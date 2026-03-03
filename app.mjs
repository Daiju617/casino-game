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
    chips: { type: String, default: "1000" }, // 文字列にする
    bank: { type: String, default: "0" },     // 文字列にする
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

// 81行目付近
const broadcastRanking = async () => {
    try {
        // collationを使用して文字列を数値順に並べる
        const topUsers = await User.find().sort({ chips: -1 }).limit(10).collation({ locale: "en_US", numericOrdering: true });
        io.emit('update_ranking', topUsers.map(u => ({ name: u.name, chips: u.chips })));
    } catch (e) { console.error("Ranking Error:", e); }
};

// 共通のBOTメッセージ送信関数
const sendBotMsg = (msg) => {
    io.emit('broadcast', {
        userName: "🤖 BOT",
        message: msg,
        isDebtor: false // BOTは借金しないので
    });
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

// 129行目付近
socket.on('atm_request', async ({ amount, type }) => {
    const user = await User.findOne({ name: socket.data.userName });
    if (!user || amount <= 0) return;

    let bChips = BigInt(user.chips);
    let bBank = BigInt(user.bank);
    let bAmount = BigInt(amount);

    if (type === 'deposit' && bChips >= bAmount) {
        user.chips = (bChips - bAmount).toString();
        user.bank = (bBank + bAmount).toString();
    } else if (type === 'withdraw' && (bBank - bAmount) >= BigInt(-10000)) {
        user.chips = (bChips + bAmount).toString();
        user.bank = (bBank - bAmount).toString();
    }
    await user.save();
    socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
    broadcastRanking();
});

// 144行目付近
socket.on('spin_request', async ({ bet }) => {
    const user = await User.findOne({ name: socket.data.userName });
    if (!user || BigInt(user.chips) < BigInt(bet)) return;

    const isWin = Math.random() < 0.02;
    const winAmount = isWin ? BigInt(bet) * BigInt(50) : BigInt(0);
    
    user.chips = (BigInt(user.chips) - BigInt(bet) + winAmount).toString();
    await user.save();

    socket.emit('spin_result', { 
        result: isWin ? ["7️⃣","7️⃣","7️⃣"] : ["🍋","🍒","🍉"], 
        win: winAmount.toString(), 
        newChips: user.chips 
    });
    broadcastRanking();
});

socket.on('hl_start', async (data) => {
    const user = await User.findOne({ name: socket.data.userName });
    const bet = BigInt(data?.bet || 100);
    if (!user || BigInt(user.chips) < bet || bet <= 0n) return;

    user.chips = (BigInt(user.chips) - bet).toString();
    await user.save();
    
    // socket.dataに保存する際は、エラー回避のため数値型に戻す
    socket.data.hlPending = Number(bet); 
    socket.data.hlCount = 0;
    const deck = createDeck();
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
        // BigIntに変換して2倍し、またNumberに戻して保存
        socket.data.hlPending = Number(BigInt(socket.data.hlPending) * 2n);
        socket.data.hlCount++;
        socket.data.hlCurrent = nextCard;
        socket.emit('hl_result', { win: true, msg: "WIN!", oldCard: nextCard, pending: socket.data.hlPending, count: socket.data.hlCount });
    } else {
        socket.data.hlPending = 0;
        socket.emit('hl_result', { win: false, msg: "LOSE", oldCard: nextCard, pending: 0 });
    }
});

// 184行目付近 (hl_collect)
socket.on('hl_collect', async () => {
    const user = await User.findOne({ name: socket.data.userName });
    if (user && socket.data.hlPending > 0) {
        user.chips = (BigInt(user.chips) + BigInt(socket.data.hlPending)).toString();
        await user.save();
        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
        socket.data.hlPending = 0;
        broadcastRanking();
    }
});

    // --- クラッシュ用：次の爆発倍率を決定する関数 ---
const getCrashPoint = () => {
    const r = Math.random();
    // 3%の確率で即爆発(1.0x)、それ以外は計算で倍率を出す
    if (r < 0.03) return 1.0; 
    return parseFloat((0.99 / (1 - r)).toFixed(2));
};

// --- ルーレット用：当選番号を決める (0-36) ---
const getRouletteResult = () => Math.floor(Math.random() * 37);

// 209行目付近 (crash_bet)
socket.on('crash_bet', async ({ bet }) => {
    const user = await User.findOne({ name: socket.data.userName });
    if (!user || BigInt(user.chips) < BigInt(bet) || bet <= 0) return;

    user.chips = (BigInt(user.chips) - BigInt(bet)).toString();
    await user.save();

        const crashPoint = getCrashPoint();
        socket.emit('crash_start', { bet, crashPoint });
        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
    });

socket.on('crash_cashout', async ({ bet, multiplier }) => {
    const user = await User.findOne({ name: socket.data.userName });
    if (!user) return;

    // 倍率計算は一旦Numberで行い、最後にBigIntに戻す
    const winAmount = BigInt(Math.floor(Number(bet) * multiplier));
    user.chips = (BigInt(user.chips) + winAmount).toString();
    await user.save();
        
        sendBotMsg(`${socket.data.userName} が ${multiplier.toFixed(2)}x で利確！ +${winAmount}枚`);

        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
        broadcastRanking();
    });

    // 【ルーレット】ベット処理
// 235行目付近
socket.on('roulette_bet', async ({ bet, type }) => {
    const user = await User.findOne({ name: socket.data.userName });
    if (!user || BigInt(user.chips) < BigInt(bet) || bet <= 0) return;

    user.chips = (BigInt(user.chips) - BigInt(bet)).toString();
    await user.save();

        const resultNumber = getRouletteResult();
        const redNumbers = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
        const isRed = redNumbers.includes(resultNumber);

        let isWin = false;
        let payout = 0;

        if (type === 'red' && isRed && resultNumber !== 0) { isWin = true; payout = bet * 2; }
        else if (type === 'black' && !isRed && resultNumber !== 0) { isWin = true; payout = bet * 2; }
        else if (type.startsWith('num_')) {
            const chosen = parseInt(type.split('_')[1]);
            if (chosen === resultNumber) { isWin = true; payout = bet * 36; }
        }

if (isWin) {
        const bPayout = BigInt(payout);
        user.chips = (BigInt(user.chips) + bPayout).toString();
        await user.save();
        sendBotMsg(`🎉 【ルーレット】 ${user.name} が当選！ ${bPayout.toString()}枚獲得！`);
    }

        socket.emit('roulette_result', { resultNumber, isWin, payout, newChips: user.chips });
        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
        broadcastRanking();
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
// 284行目付近
if (data.type === 'update_chips') {
    // 文字列として更新
    await User.findOneAndUpdate({ name: data.target }, { chips: data.amount.toString() });
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






