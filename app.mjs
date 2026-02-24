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

// 旧：app.use(express.static(__dirname)); 
// 新：publicフォルダを読み込む設定
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

import { MongoClient } from "mongodb";
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

async function getCollection() {
  await client.connect();
  return client.db("apm").collection("scores");
}

// スコア保存
app.post("/api/score", async (req, res) => {
  const { name, apm, accuracy, mode } = req.body;

  if (!name || !apm || !mode) {
    return res.status(400).json({ error: "Invalid data" });
  }

  const col = await getCollection();
  await col.insertOne({
    name,
    apm,
    accuracy,
    mode,      // 3x3 / 4x4 / 5x5
    date: Date.now()
  });

  res.json({ success: true });
});

// ランキング取得（モード別）
app.get("/api/ranking/:mode", async (req, res) => {
  const mode = req.params.mode;
  const col = await getCollection();

  const ranking = await col
    .find({ mode })
    .sort({ apm: -1 })
    .limit(100)
    .toArray();

  res.json(ranking);
});

// --- 通信ロジック ---
io.on('connection', (socket) => {

    // --- チャットメッセージの受信と全員への送信 ---
    socket.on('chat_message', async (msg) => {
        try {
            if (!socket.data.userName || !msg) return;

            // 1. データベースに保存
            const newChat = new Chat({
                userName: socket.data.userName,
                message: msg,
                time: new Date()
            });
            await newChat.save();

            // 2. 発信者の債務者情報を確認
            const user = await User.findOne({ name: socket.data.userName });
            const isDebtor = user ? user.bank < 0 : false;

            // 3. 全員にメッセージをリアルタイムで送る
            io.emit('broadcast', {
                userName: socket.data.userName,
                message: msg,
                isDebtor: isDebtor
            });
        } catch (e) {
            console.error("Chat Send Error:", e);
        }
    });
    
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

    socket.on('login_request', async (data) => {
        try {
            const { name, password } = data;
            const clientIp = socket.handshake.address; // 接続元のIPを取得

            let user = await User.findOne({ name });

            if (!user) {
                // 【新規作成時】同じIPのユーザーが既にいないかチェック
                const existingIpUser = await User.findOne({ ip: clientIp });
                if (existingIpUser) {
                    return socket.emit('login_error', "このIPからは1つのアカウントしか作成できません");
                }
                
                user = new User({ name, password, ip: clientIp });
                await user.save();
            } else if (user.password !== password) {
                return socket.emit('login_error', "パスワードが違います");
            }

            socket.data.userName = name;
            socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
            sendChatHistory();
            broadcastRanking();
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

    // --- ランキング更新関数 (サーバー側の共通関数エリアに追加) ---
const broadcastRanking = async () => {
    try {
        // チップ所持数が多い順にトップ10を取得
        const topUsers = await User.find().sort({ chips: -1 }).limit(10);
        const rankingData = topUsers.map(u => ({ name: u.name, chips: u.chips }));
        io.emit('update_ranking', rankingData); // 全員に送信
    } catch (e) { console.error("Ranking Error:", e); }
};

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

// --- 【1】ハイアンドロー開始 ---
// --- 【1】ハイアンドロー開始 ---
    socket.on('hl_start', async (data) => {
        try {
            const user = await User.findOne({ name: socket.data.userName });
            // ここで入力された bet (例: 10000) を取得
            const bet = parseInt(data?.bet || 100);

            if (!user || user.chips < bet || bet <= 0) {
                return socket.emit('login_error', "チップ不足");
            }

            user.chips -= bet;
            await user.save();

            const deck = createDeck();
            const firstCard = deck.pop();

            // 【超重要】ここで入力された bet を pending に直接叩き込む
            socket.data.hlPending = bet; 
            socket.data.hlCount = 0;
            socket.data.hlDeck = deck;
            socket.data.hlCurrent = firstCard;

            socket.emit('hl_setup', { currentCard: firstCard });
            socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
        } catch (e) { console.error(e); }
    });

    // --- 【2】ハイアンドロー予想 ---
    socket.on('hl_guess', async (data) => {
        if (!socket.data.hlCurrent || !socket.data.hlDeck) return;

        const nextCard = socket.data.hlDeck.pop();
        const curVal = getHLValue(socket.data.hlCurrent.rank);
        const nextVal = getHLValue(nextCard.rank);

        const isWin = (data.choice === 'high' && nextVal >= curVal) || 
                      (data.choice === 'low' && nextVal <= curVal);

        if (isWin) {
            // 【修正】現在の pending (最初は賭け金そのもの) を2倍にする
            // 10000 賭けてたら、1回正解で 10000 * 2 = 20000 になる
            socket.data.hlPending = Math.floor(Number(socket.data.hlPending) * 2);
            socket.data.hlCount++;
            socket.data.hlCurrent = nextCard;

            socket.emit('hl_result', {
                win: true, 
                msg: `WIN! 正解！配当: ${socket.data.hlPending}枚`, 
                oldCard: nextCard,
                pending: socket.data.hlPending,
                count: socket.data.hlCount
            });
        } else {
            const lostCard = nextCard;
            socket.data.hlPending = 0;
            socket.data.hlCurrent = null;
            socket.emit('hl_result', {
                win: false,
                msg: "LOSE... ハズレです", 
                oldCard: lostCard,
                pending: 0
            });
        }
    });

    // --- 【3】ハイアンドロー回収 ---
    socket.on('hl_collect', async () => {
        if (!socket.data.hlPending || socket.data.hlCount === 0) return;

        try {
            const user = await User.findOne({ name: socket.data.userName });
            if (user) {
                const winAmount = socket.data.hlPending;
                user.chips += winAmount;
                await user.save();

                // 回収成功：フロントをリセットさせるために win: false を送る
                socket.emit('hl_result', { 
                    win: false, 
                    msg: `${winAmount}枚回収しました！`,
                    newChips: user.chips 
                });

                // 状態クリア
                socket.data.hlPending = 0;
                socket.data.hlCurrent = null;

                // 所持金更新
                socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
                broadcastRanking();
            }
        } catch (e) { console.error("HL Collect Error:", e); }
    });

    // --- クリッカー換金処理 ---
    socket.on('exchange_request', async (data) => {
        try {
            const user = await User.findOne({ name: socket.data.userName });
            if (!user) return;

            const score = parseInt(data.score);
            if (isNaN(score) || score < 100) return;

            // 100スコアにつき1チップに変換
            const addedChips = Math.floor(score / 100);
            
            user.chips += addedChips;
            await user.save();

            // フロントに成功通知と新しいチップ数を送る
            socket.emit('exchange_success', { addedChips: addedChips });
            socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
            broadcastRanking(); // ランキングも更新
        } catch (e) { console.error("Exchange Error:", e); }
    });

    // --- [重要] Socket.ioの設定を「外部接続許可」に書き換え ---
const io = new Server(server, { 
    cors: { 
        origin: "*", // GitHub Pagesからの接続を許可
        methods: ["GET", "POST"]
    } 
});

// 管理者専用のマスターキー（適宜変更してくれ！）
const MASTER_KEY = "YAWATA_SECRET_TOKEN_2026";

io.on('connection', (socket) => {
    // --- 遠隔管理者のログイン認証 ---
    socket.on('admin_remote_login', (data) => {
        if (data.key === MASTER_KEY) {
            socket.join("admin_room"); // 特権ルームに隔離
            socket.emit('admin_auth_success', { msg: "認証に成功しました。接続完了。" });
        } else {
            console.log("⚠️ 不正な管理者ログイン試行を検知");
        }
    });

    // --- 遠隔操作コマンド ---
    socket.on('admin_remote_command', async (data) => {
        // 認証済みルームにいない場合は無視
        if (!socket.rooms.has("admin_room")) return;

        try {
            if (data.type === 'get_users') {
                const users = await User.find().sort({ chips: -1 });
                socket.emit('admin_remote_data', { type: 'user_list', users });
            }
            
            if (data.type === 'update_chips') {
                const { target, amount } = data;
                const user = await User.findOneAndUpdate({ name: target }, { chips: amount }, { new: true });
                // 本人に通知（もし接続中なら）
                io.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
                // ランキング更新
                broadcastRanking();
            }

            if (data.type === 'ban_user') {
                await User.deleteOne({ name: data.target });
                socket.emit('admin_remote_msg', { msg: `${data.target} をBANしました` });
                broadcastRanking();
            }
        } catch (e) { console.error("Admin Command Error:", e); }
    });
});

}); // ここが io.on の閉じカッコ。全ての通信はこの手前に入れる。

server.listen(process.env.PORT || 3000, "0.0.0.0", () => console.log(`🚀 Ready`));
















