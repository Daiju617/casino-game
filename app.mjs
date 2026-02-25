import express from 'express';
import { createServer } from 'http';
import { Server } from "socket.io";
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from "mongodb";

// --- 基本設定 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = createServer(app);

// --- [重要] Socket.ioの設定 (CORS対応) ---
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    },
    transports: ["websocket", "polling"]
});

const MASTER_KEY = "YAWATA_SECRET_TOKEN_2026"; // 管理者用キー

app.use(express.json());
app.use(express.static(__dirname));

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

// --- ゲーム用関数 ---
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
const broadcastRanking = async () => {
    try {
        const topUsers = await User.find().sort({ chips: -1 }).limit(10);
        io.emit('update_ranking', topUsers.map(u => ({ name: u.name, chips: u.chips })));
    } catch (e) { console.error("Ranking Error:", e); }
};

io.on('connection', (socket) => {
    console.log("New Client Connected");

    // ログイン処理
    socket.on('login_request', async (data) => {
        try {
            const { name, password } = data;
            const clientIp = socket.handshake.address;
            let user = await User.findOne({ name });

            if (!user) {
                const existingIpUser = await User.findOne({ ip: clientIp });
                if (existingIpUser) return socket.emit('login_error', "このIPからは1つのアカウントしか作成できません");
                user = new User({ name, password, ip: clientIp });
                await user.save();
            } else if (user.password !== password) {
                return socket.emit('login_error', "パスワードが違います");
            }

            socket.data.userName = name;
            socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
            
            // チャット履歴送信
            const history = await Chat.find().sort({ time: -1 }).limit(30);
            socket.emit('chat_history', history.reverse());
            broadcastRanking();
        } catch (e) { console.error(e); }
    });

    // チャット
    socket.on('chat_message', async (msg) => {
        if (!socket.data.userName || !msg) return;
        const newChat = new Chat({ userName: socket.data.userName, message: msg });
        await newChat.save();
        const user = await User.findOne({ name: socket.data.userName });
        io.emit('broadcast', { userName: socket.data.userName, message: msg, isDebtor: user?.bank < 0 });
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
        broadcastRanking();
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
        broadcastRanking();
    });

    // ハイアンドロー
    socket.on('hl_start', async (data) => {
        const user = await User.findOne({ name: socket.data.userName });
        const bet = parseInt(data?.bet || 100);
        if (!user || user.chips < bet || bet <= 0) return;
        user.chips -= bet; await user.save();
        const deck = createDeck();
        socket.data.hlPending = bet;
        socket.data.hlCount = 0;
        socket.data.hlDeck = deck;
        const firstCard = deck.pop();
        socket.data.hlCurrent = firstCard;
        socket.emit('hl_setup', { currentCard: firstCard });
        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
    });

    socket.on('hl_guess', async (data) => {
        if (!socket.data.hlCurrent || !socket.data.hlDeck) return;
        const nextCard = socket.data.hlDeck.pop();
        const curVal = getHLValue(socket.data.hlCurrent.rank);
        const nextVal = getHLValue(nextCard.rank);
        const isWin = (data.choice === 'high' && nextVal >= curVal) || (data.choice === 'low' && nextVal <= curVal);
        if (isWin) {
            socket.data.hlPending = Math.floor(socket.data.hlPending * 2);
            socket.data.hlCount++;
            socket.data.hlCurrent = nextCard;
            socket.emit('hl_result', { win: true, msg: "WIN!", oldCard: nextCard, pending: socket.data.hlPending, count: socket.data.hlCount });
        } else {
            socket.data.hlPending = 0;
            socket.emit('hl_result', { win: false, msg: "LOSE", oldCard: nextCard, pending: 0 });
        }
    });

    socket.on('hl_collect', async () => {
        const user = await User.findOne({ name: socket.data.userName });
        if (user && socket.data.hlPending > 0) {
            user.chips += socket.data.hlPending;
            await user.save();
            socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
            socket.data.hlPending = 0;
            broadcastRanking();
        }
    });

    // クリッカー換金
    socket.on('exchange_request', async (data) => {
        const user = await User.findOne({ name: socket.data.userName });
        const score = parseInt(data.score);
        if (user && score >= 100) {
            const added = Math.floor(score / 100);
            user.chips += added;
            await user.save();
            socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
            broadcastRanking();
        }
    });

    // --- 管理者コマンド ---
    socket.on('admin_remote_login', (data) => {
        if (data.key === MASTER_KEY) {
            socket.join("admin_room");
            socket.emit('admin_auth_success', { msg: "認証成功" });
        }
    });

    socket.on('admin_remote_command', async (data) => {
        if (!socket.rooms.has("admin_room")) return;
        if (data.type === 'get_users') {
            const users = await User.find().sort({ chips: -1 });
            socket.emit('admin_remote_data', { type: 'user_list', users });
        }
        if (data.type === 'update_chips') {
            await User.findOneAndUpdate({ name: data.target }, { chips: data.amount });
            broadcastRanking();
        }
        if (data.type === 'ban_user') {
            await User.deleteOne({ name: data.target });
            broadcastRanking();
        }
    });
});

// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
