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
const io = new Server(server, { cors: { origin: "*" } });

// --- データベース接続 ---
const MONGO_URI = process.env.MONGO_URI; 
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB接続成功"))
    .catch(err => console.error("❌ MongoDB接続エラー:", err.message));

const User = mongoose.model('User', new mongoose.Schema({
    name: { type: String, required: true },
    password: { type: String, required: true },
    chips: { type: Number, default: 1000 },
    bank: { type: Number, default: 0 },
    ip: { type: String },
    lastLogin: { type: Date, default: Date.now }
}));

const Chat = mongoose.model('Chat', new mongoose.Schema({
    userName: String,
    message: String,
    time: { type: Date, default: Date.now }
}));

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

let bjGames = {};

// --- 通信ロジック ---
io.on('connection', (socket) => {
    
    // ログイン履歴取得用の関数（io.onの中で定義）
    const sendChatHistory = async () => {
        try {
            const history = await Chat.find().sort({ time: -1 }).limit(30);
            const chatHistory = await Promise.all(history.reverse().map(async (c) => {
                const author = await User.findOne({ name: c.userName });
                return { userName: c.userName, message: c.message, isDebtor: author ? author.bank < 0 : false };
            }));
            socket.emit('chat_history', chatHistory);
        } catch (e) { console.error(e); }
    };

    // ログイン
    socket.on('login_request', async (data) => {
        try {
            const { name, password } = data;
            let user = await User.findOne({ name });
            if (!user) {
                user = new User({ name, password, ip: socket.handshake.address });
                await user.save();
            } else if (user.password !== password) {
                return socket.emit('login_error', "パスワードが違います");
            }
            socket.data.userName = name;
            socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
            
            // ログイン成功時に履歴を送る
            sendChatHistory();
        } catch (e) { console.error(e); }
    });

    // ATM
    socket.on('atm_request', async ({ amount, type }) => {
        const user = await User.findOne({ name: socket.data.userName });
        if (!user || amount <= 0) return;
        if (type === 'deposit' && user.chips >= amount) {
            user.chips -= amount; user.bank += amount;
        } else if (type === 'withdraw' && user.bank - amount >= -10000) {
            user.chips += amount; user.bank -= amount;
        }
        await user.save();
        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
    });

    // スロット
    socket.on('spin_request', async ({ bet }) => {
        const user = await User.findOne({ name: socket.data.userName });
        if (!user || user.chips < bet) return;
        const isWin = Math.random() < 0.02; 
        const winAmount = isWin ? bet * 50 : 0;
        user.chips = user.chips - bet + winAmount;
        await user.save();
        socket.emit('spin_result', { result: isWin ? ["7️⃣","7️⃣","7️⃣"] : ["🍋","🍒","🍉"], win: winAmount, newChips: user.chips });
    });

    // ブラックジャック
    socket.on('bj_start', async ({ bet }) => {
        const user = await User.findOne({ name: socket.data.userName });
        if (!user || user.chips < bet) return;
        user.chips -= bet; await user.save();
        const deck = createDeck();
        bjGames[socket.id] = { p: [deck.pop(), deck.pop()], d: [deck.pop(), deck.pop()], deck, bet };
        socket.emit('bj_update', { player: bjGames[socket.id].p, dealer: [bjGames[socket.id].d[0], {rank:'?'}], pSum: getBJValue(bjGames[socket.id].p) });
        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
    });

    socket.on('bj_stand', async () => {
        const g = bjGames[socket.id]; if (!g) return;
        let dSum = getBJValue(g.d);
        while (dSum < 17) { g.d.push(g.deck.pop()); dSum = getBJValue(g.d); }
        const pSum = getBJValue(g.p);
        const win = (dSum > 21 || pSum > dSum) ? g.bet * 2 : (pSum === dSum ? g.bet : 0);
        const user = await User.findOne({ name: socket.data.userName });
        user.chips += win; await user.save();
        socket.emit('bj_result', { player: g.p, dealer: g.d, msg: win > g.bet ? "WIN" : "LOSE", newChips: user.chips });
        delete bjGames[socket.id];
    });

    // ハイアンドロー (修正版)
    socket.on('hl_start', async (data) => {
        const user = await User.findOne({ name: socket.data.userName });
        const bet = parseInt(data?.bet || 100);
        if (!user || user.chips < bet) return socket.emit('login_error', "チップ不足");
        user.chips -= bet; await user.save();
        const deck = createDeck();
        const card = deck.pop();
        socket.data.hl = { deck, current: card, pending: bet, count: 0 };
        socket.emit('hl_setup', { currentCard: card });
        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
    });

    socket.on('hl_guess', async (data) => {
        if (!socket.data.hl) return;
        const hl = socket.data.hl;
        const nextCard = hl.deck.pop();
        const curVal = getHLValue(hl.current.rank);
        const nextVal = getHLValue(nextCard.rank);
        const isWin = (data.choice === 'high' && nextVal >= curVal) || (data.choice === 'low' && nextVal <= curVal);
        if (isWin) {
            hl.pending = Math.floor(hl.pending * 2); 
            hl.count++;
            hl.current = nextCard;
            socket.emit('hl_result', { win: true, msg: `正解！配当は ${hl.pending} 枚！`, oldCard: nextCard, pending: hl.pending, count: hl.count });
        } else {
            socket.data.hl = null;
            socket.emit('hl_result', { win: false, msg: "残念、ハズレです...", oldCard: nextCard, pending: 0 });
        }
    });

    socket.on('hl_collect', async () => {
        const hl = socket.data.hl;
        if (!hl || hl.count === 0) return;
        const user = await User.findOne({ name: socket.data.userName });
        user.chips += hl.pending; await user.save();
        socket.emit('hl_result', { msg: `${hl.pending}枚回収！`, newChips: user.chips });
        socket.data.hl = null;
        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
    });

    // チャットメッセージ受信
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
        } catch (err) { console.error("Chat Error:", err); }
    });

}); // ここが io.on の閉じカッコ。全ての通信はこの手前に入れる。

server.listen(process.env.PORT || 3000, "0.0.0.0", () => console.log(`🚀 Ready`));
