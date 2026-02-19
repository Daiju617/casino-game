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
    bank: { type: Number, default: 0 }, // 銀行預金（マイナスなら借金）
    ip: { type: String },               // IPアドレス保存用
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

// 状態管理
let bjGames = {}; 
let hlCurrentCard = {};

// --- 通信ロジック ---
io.on('connection', (socket) => {
    console.log('ユーザーが接続しました');

    // ATM機能
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
                if (user.bank < 0) {
                    const interest = Math.floor(user.bank * 0.1);
                    user.bank += interest;
                    await user.save();
                    socket.emit('login_error', `【ATM通知】借金の利息 ${Math.abs(interest)}枚 が加算されました`);
                }
            }
            socket.data.userName = name;
            socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
            
            const history = await Chat.find().sort({ time: -1 }).limit(30);
            // 履歴にも債務者情報を載せるため、Mapで変換して送る
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
            
            // 破産削除ではなく、残高0にしてATMへ誘導
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

    // レート設定: 100スコア = 1チップ
const CLICK_RATE = 100;

socket.on('exchange_request', async (data) => {
    const { score } = data; // フロントから送られてくるスコア
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
        if (!user || user.chips < data.bet) return;
        const deck = createDeck();
        bjGames[socket.id] = { p: [deck.pop(), deck.pop()], d: [deck.pop(), deck.pop()], deck, bet: data.bet };
        socket.emit('bj_update', { player: bjGames[socket.id].p, dealer: [bjGames[socket.id].d[0], {rank:'?', suit:'?'}], pSum: getBJValue(bjGames[socket.id].p) });
    });

    socket.on('bj_hit', () => {
        const g = bjGames[socket.id]; if (!g) return;
        g.p.push(g.deck.pop());
        const sum = getBJValue(g.p);
        if (sum > 21) {
            handleBJEnd(socket, g, 0, "BUST (Lose)");
        } else {
            socket.emit('bj_update', { player: g.p, dealer: [g.d[0], {rank:'?'}], pSum: sum });
        }
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
    socket.on('hl_start', (data) => {
        const deck = createDeck();
        hlCurrentCard[socket.id] = deck.pop();
        socket.emit('hl_setup', { currentCard: hlCurrentCard[socket.id] });
    });

    socket.on('hl_guess', async (data) => {
        try {
            const user = await User.findOne({ name: socket.data.userName });
            if (!user || user.chips < data.bet) return;
            const nextCard = createDeck().pop();
            const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
            const curIdx = ranks.indexOf(hlCurrentCard[socket.id].rank);
            const nxtIdx = ranks.indexOf(nextCard.rank);
            let win = (nxtIdx === curIdx) ? data.bet : (((data.choice==='high'&&nxtIdx>curIdx)||(data.choice==='low'&&nxtIdx<curIdx)) ? data.bet*2 : 0);
            
            user.chips = user.chips - data.bet + win;
            if (user.chips < 0) user.chips = 0;
            await user.save();
            hlCurrentCard[socket.id] = nextCard;
            socket.emit('hl_result', { oldCard: nextCard, msg: win>data.bet?"WIN!":(win===0?"LOSE":"PUSH"), newChips: user.chips });
            updateRanking();
        } catch (err) { console.error(err); }
    });

    socket.on('disconnect', () => {
        delete bjGames[socket.id];
        delete hlCurrentCard[socket.id];
    });
});

async function handleBJEnd(socket, g, win, msg) {
    const user = await User.findOne({ name: socket.data.userName });
    if (!user) return;
    user.chips = user.chips - g.bet + win;
    if (user.chips < 0) user.chips = 0;
    await user.save();
    socket.emit('bj_result', { player: g.p, dealer: g.d, msg, newChips: user.chips });
    delete bjGames[socket.id];
    updateRanking();
}

async function updateRanking() {
    try {
        const users = await User.find().sort({ chips: -1 }).limit(10);
        const list = users.map(u => ({
            name: u.name,
            chips: u.chips,
            isDebtor: u.bank < 0
        }));
        io.emit('update_ranking', list);
    } catch (err) { console.error(err); }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));

