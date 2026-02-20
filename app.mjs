import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// --- データベース接続 ---
const MONGO_URI = process.env.MONGO_URI; 
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB接続成功"))
    .catch(err => console.error("❌ MongoDB接続エラー:", err.message));

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    password: { type: String, required: true },
    chips: { type: Number, default: 1000 },
    bank: { type: Number, default: 0 },
    ip: { type: String },
    lastLogin: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const chatSchema = new mongoose.Schema({
    userName: String,
    message: String,
    time: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', chatSchema);

app.use(express.static(__dirname));

// --- 共通関数 ---
const createDeck = () => {
    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let deck = [];
    for (let s of suits) for (let r of ranks) deck.push({ suit: s, rank: r });
    return deck.sort(() => Math.random() - 0.5);
};

const getBJValue = (cards) => {
    let sum = 0, aces = 0;
    cards.forEach(c => {
        if (['J', 'Q', 'K'].includes(c.rank)) sum += 10;
        else if (c.rank === 'A') { sum += 11; aces++; }
        else sum += parseInt(c.rank);
    });
    while (sum > 21 && aces > 0) { sum -= 10; aces--; }
    return sum;
};

const getHLValue = (rank) => {
    if (rank === 'A') return 1;
    if (rank === 'J') return 11;
    if (rank === 'Q') return 12;
    if (rank === 'K') return 13;
    return parseInt(rank);
};

// 状態管理
let bjGames = {}; 

// --- 通信ロジック ---
io.on('connection', (socket) => {
    console.log('ユーザーが接続しました');

    // ATM
    socket.on('atm_request', async (data) => {
        const { amount, type } = data;
        try {
            const user = await User.findOne({ name: socket.data.userName });
            if (!user || amount <= 0) return;
            if (type === 'deposit') {
                if (user.chips < amount) return socket.emit('login_error', "手持ちが足りません");
                user.chips -= amount;
                user.bank += amount;
            } else if (type === 'withdraw') {
                if (user.bank - amount < -10000) return socket.emit('login_error', "融資限度額（1万枚）を超えています");
                user.chips += amount;
                user.bank -= amount;
            }
            await user.save();
            socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
            updateRanking();
        } catch (err) { console.error(err); }
    });

    // ログイン・登録
    socket.on('login_request', async (data) => {
        const { name, password } = data;
        const clientIp = socket.handshake.address;
        try {
            let user = await User.findOne({ name: name });
            if (!user) {
                const ipExists = await User.findOne({ ip: clientIp });
                if (ipExists) return socket.emit('login_error', "この端末からは1つしかアカウントを作れません");
                user = new User({ name: name, password: password, ip: clientIp, chips: 1000 });
                await user.save();
            } else {
                if (user.password !== password) return socket.emit('login_error', "パスワードが違います");
                
                let message = "";
                if (user.bank < 0) {
                    const interest = Math.floor(user.bank * 0.1);
                    user.bank += interest;
                    message = `【ATM通知】借金の利息 ${Math.abs(interest)}枚 が加算されました`;
                } else if (user.bank > 0) {
                    const bonus = Math.floor(user.bank * 0.01);
                    if (bonus > 0) {
                        user.bank += bonus;
                        message = `【銀行通知】預金利息 ${bonus}枚 が入金されました！`;
                    }
                }
                if (message) {
                    await user.save();
                    socket.emit('login_error', message);
                }
            }
            socket.data.userName = name;
            socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
            
            const history = await Chat.find().sort({ time: -1 }).limit(30);
            const chatHistory = await Promise.all(history.reverse().map(async (c) => {
                const author = await User.findOne({ name: c.userName });
                return { userName: c.userName, message: c.message, isDebtor: author ? author.bank < 0 : false };
            }));
            socket.emit('chat_history', chatHistory);
            updateRanking();
        } catch (err) { console.error(err); }
    });

    // スロット
    socket.on('spin_request', async (data) => {
        try {
            const user = await User.findOne({ name: socket.data.userName });
            if (!user || user.chips < data.bet) return;
            const symbols = ["🍒", "💎", "7️⃣", "🍋", "⭐"];
            const isPekari = Math.floor(Math.random() * 50) === 0;
            let result = isPekari ? ["7️⃣", "7️⃣", "7️⃣"] : [symbols[Math.floor(Math.random() * 5)], symbols[Math.floor(Math.random() * 5)], symbols[Math.floor(Math.random() * 5)]];
            let multiplier = (result[0] === result[1] && result[1] === result[2]) ? (result[0] === "7️⃣" ? 50 : 10) : 0;
            user.chips = user.chips - data.bet + (data.bet * multiplier);
            if (user.chips < 0) user.chips = 0;
            await user.save();
            socket.emit('spin_result', { result, win: data.bet * multiplier, newChips: user.chips, isPekari });
            updateRanking();
        } catch (err) { console.error(err); }
    });

    // チャット
    socket.on('chat_message', async (data) => {
        if (!socket.data.userName) return;
        const messageText = (typeof data === 'string') ? data : (data.message || data.msg);
        try {
            const user = await User.findOne({ name: socket.data.userName });
            const newChat = new Chat({ userName: socket.data.userName, message: messageText });
            await newChat.save();
            io.emit('broadcast', {
                userName: socket.data.userName,
                message: messageText,
                isDebtor: user ? user.bank < 0 : false
            });
        } catch (err) { console.error(err); }
    });

    // スコア交換
    const CLICK_RATE = 100;
    socket.on('exchange_request', async (data) => {
        const { score } = data;
        try {
            const user = await User.findOne({ name: socket.data.userName });
            if (!user || score < CLICK_RATE) return;
            const reward = Math.floor(score / CLICK_RATE);
            user.chips += reward;
            await user.save();
            socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
            socket.emit('exchange_success', { addedChips: reward });
        } catch (err) { console.error(err); }
    });

    // ブラックジャック
    socket.on('bj_start', async (data) => {
        const user = await User.findOne({ name: socket.data.userName });
        const bet = parseInt(data.bet) || 100;
        if (!user || user.chips < bet) return socket.emit('login_error', "チップが足りません");
        user.chips -= bet;
        await user.save();
        const deck = createDeck();
        bjGames[socket.id] = { p: [deck.pop(), deck.pop()], d: [deck.pop(), deck.pop()], deck, bet: bet };
        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
        socket.emit('bj_update', { player: bjGames[socket.id].p, dealer: [bjGames[socket.id].d[0], {rank:'?', suit:'?'}], pSum: getBJValue(bjGames[socket.id].p) });
    });

    socket.on('bj_hit', () => {
        const g = bjGames[socket.id]; if (!g) return;
        g.p.push(g.deck.pop());
        const sum = getBJValue(g.p);
        if (sum > 21) handleBJEnd(socket, g, 0, "BUST (Lose)");
        else socket.emit('bj_update', { player: g.p, dealer: [g.d[0], {rank:'?'}], pSum: sum });
    });

    socket.on('bj_stand', async () => {
        const g = bjGames[socket.id]; if (!g) return;
        let dSum = getBJValue(g.d);
        while (dSum < 17) { g.d.push(g.deck.pop()); dSum = getBJValue(g.d); }
        const pSum = getBJValue(g.p);
        let win = (dSum > 21 || pSum > dSum) ? g.bet * 2 : (pSum === dSum ? g.bet : 0);
        let msg = (dSum > 21 || pSum > dSum) ? "WIN!" : (pSum === dSum ? "PUSH" : "LOSE");
        handleBJEnd(socket, g, win, msg);
    });

    // ハイアンドロー
    socket.on('hl_start', async (data) => {
        const user = await User.findOne({ name: socket.data.userName });
        const bet = parseInt(data?.bet) || 100;
        if (!user || user.chips < bet) return socket.emit('login_error', "チップが足りません");
        user.chips -= bet;
        await user.save();
        const deck = createDeck();
        const firstCard = deck.pop();
        socket.data.hlDeck = deck;
        socket.data.hlCurrent = firstCard;
        socket.data.hlPending = bet;
        socket.data.hlCount = 0;
        socket.emit('hl_setup', { currentCard: firstCard });
        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
    });

    socket.on('hl_guess', async (data) => {
        if (!socket.data.hlCurrent) return;
        const deck = socket.data.hlDeck;
        const nextCard = deck.pop();
        const curVal = getHLValue(socket.data.hlCurrent.rank);
        const nextVal = getHLValue(nextCard.rank);
        let win = (data.choice === 'high' && nextVal >= curVal) || (data.choice === 'low' && nextVal <= curVal);
        if (win) {
            socket.data.hlPending = Math.floor(socket.data.hlPending * 1.9);
            socket.data.hlCount++;
            socket.data.hlCurrent = nextCard;
            socket.emit('hl_result', { msg: `WIN! 次は ${socket.data.hlPending}枚！`, oldCard: nextCard });
        } else {
            socket.data.hlPending = 0;
            socket.data.hlCount = 0;
            socket.data.hlCurrent = null;
            socket.emit('hl_result', { msg: "LOSE... 全額没収です", oldCard: nextCard });
        }
    });

    socket.on('hl_collect', async () => {
        const user = await User.findOne({ name: socket.data.userName });
        if (!user || !socket.data.hlPending || socket.data.hlCount === 0) return socket.emit('login_error', "コレクトできません");
        user.chips += socket.data.hlPending;
        const reward = socket.data.hlPending;
        socket.data.hlPending = 0;
        socket.data.hlCount = 0;
        await user.save();
        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
        socket.emit('hl_result', { msg: `安全に ${reward} 枚回収しました！`, newChips: user.chips });
    });

    socket.on('disconnect', () => {
        delete bjGames[socket.id];
    });
});

async function handleBJEnd(socket, g, win, msg) {
    const user = await User.findOne({ name: socket.data.userName });
    if (!user) return;
    user.chips += win;
    await user.save();
    socket.emit('bj_result', { player: g.p, dealer: g.d, msg, newChips: user.chips });
    delete bjGames[socket.id];
    updateRanking();
}

async function updateRanking() {
    try {
        const users = await User.find().sort({ chips: -1 }).limit(10);
        const list = users.map(u => ({ name: u.name, chips: u.chips, isDebtor: u.bank < 0 }));
        io.emit('update_ranking', list);
    } catch (err) { console.error(err); }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));





