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

// スキーマ定義
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    password: { type: String, required: true },
    chips: { type: Number, default: 1000 },
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

    // ログイン・新規登録
    socket.on('login_request', async (data) => {
        const { name, password } = data;
        try {
            let user = await User.findOne({ name: name });
            if (!user) {
                user = new User({ name: name, password: password, chips: 1000, lastLogin: new Date() });
                await user.save();
                io.emit('broadcast', `✨ 新規プレイヤー ${name} さんが来店しました！`);
            } else {
                if (user.password !== password) return socket.emit('login_error', "パスワードが違います");
                
                const now = new Date();
                const last = user.lastLogin || new Date(0);
                if (now - last > 24 * 60 * 60 * 1000) {
                    user.chips += 500;
                    user.lastLogin = now;
                    await user.save();
                    io.emit('broadcast', `🎁 ${name} さん、来店ボーナス500枚！`);
                }
            }
            socket.data.userName = name;
            socket.emit('login_success', { name: user.name, chips: user.chips });

            // ログイン成功時にチャット履歴（最新30件）を送信
            const history = await Chat.find().sort({ time: -1 }).limit(30);
            socket.emit('chat_history', history.reverse().map(c => `${c.userName}: ${c.message}`));
            
            updateRanking();
        } catch (err) { console.error(err); }
    });

    // チャット機能（保存 ＋ お掃除）
    socket.on('chat_message', async (msg) => {
        if (!socket.data.userName) return;
        
        const newChat = new Chat({ userName: socket.data.userName, message: msg });
        await newChat.save();

        const count = await Chat.countDocuments();
        if (count > 100) {
            const oldest = await Chat.find().sort({ time: 1 }).limit(count - 100);
            await Chat.deleteMany({ _id: { $in: oldest.map(c => c._id) } });
        }
        io.emit('broadcast', `${socket.data.userName}: ${msg}`);
    });

    // スロット
    socket.on('spin_request', async (data) => {
        try {
            const user = await User.findOne({ name: socket.data.userName });
            if (!user || user.chips < data.bet) return;
            const symbols = ["🍒", "💎", "7️⃣", "🍋", "⭐"];
            const result = [symbols[Math.floor(Math.random()*5)], symbols[Math.floor(Math.random()*5)], symbols[Math.floor(Math.random()*5)]];
            let mult = 0;
            if (result[0] === result[1] && result[1] === result[2]) mult = (result[0] === "7️⃣") ? 50 : 10;
            else if (result[0] === result[1] || result[1] === result[2] || result[0] === result[2]) mult = 2;
            
            user.chips = user.chips - data.bet + (data.bet * mult);
            if (user.chips <= 0) {
                await User.deleteOne({ _id: user._id });
                return socket.emit('login_error', "破産しました。データは削除されます。");
            }
            await user.save();
            socket.emit('spin_result', { result, win: data.bet * mult, newChips: user.chips });
            updateRanking();
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
            socket.emit('bj_result', { player: g.p, dealer: g.d, msg: "BUST (Lose)", win: 0 });
            handleBJEnd(socket, g, 0);
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
            if (user.chips <= 0) {
                await User.deleteOne({ _id: user._id });
                return socket.emit('hl_result', { oldCard: nextCard, msg: "BANKRUPT", newChips: 0 });
            }
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
    if (user.chips <= 0) await User.deleteOne({ _id: user._id });
    else await user.save();
    socket.emit('bj_result', { player: g.p, dealer: g.d, msg, newChips: user.chips });
    delete bjGames[socket.id];
    updateRanking();
}

async function updateRanking() {
    try {
        const list = await User.find().sort({ chips: -1 }).limit(5);
        io.emit('update_ranking', list);
    } catch (err) { console.error(err); }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
