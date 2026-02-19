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
    bank: { type: Number, default: 0 }, // ✅ 銀行預金（マイナスなら借金）
    ip: { type: String },               // ✅ IPアドレス保存用
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

    socket.on('atm_request', async (data) => {
    const { amount, type } = data;
    try {
        const user = await User.findOne({ name: socket.data.userName });
        if (!user || amount <= 0) return;

        if (type === 'deposit') { // 預ける
            if (user.chips < amount) return socket.emit('login_error', "手持ちが足りません");
            user.chips -= amount;
            user.bank += amount;
        } else if (type === 'withdraw') { // 引き出す（借金も可）
            // 借金の限度額を -10,000枚 に設定
            if (user.bank - amount < -10000) return socket.emit('login_error', "融資限度額（1万枚）を超えています");
            user.chips += amount;
            user.bank -= amount;
        }

        await user.save();
        // 更新された残高をフロントに送る
        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
    } catch (err) { console.error(err); }
});

socket.on('login_request', async (data) => {
    const { name, password } = data;
    const clientIp = socket.handshake.address; // 接続元のIPを取得

    try {
        let user = await User.findOne({ name: name });

        if (!user) {
            // ✅ 【IP制限】このIPで既に登録されているユーザーがいないか確認
            const ipExists = await User.findOne({ ip: clientIp });
            if (ipExists) {
                return socket.emit('login_error', "この端末からは1つしかアカウントを作れません");
            }
            // 新規作成（IPを記録）
            user = new User({ name: name, password: password, ip: clientIp, chips: 1000 });
            await user.save();
        } else {
            // パスワード確認
            if (user.password !== password) return socket.emit('login_error', "パスワードが違います");

            // ✅ 【闇金利息】ログイン時に借金があれば10%の利息を加算
            if (user.bank < 0) {
                const interest = Math.floor(user.bank * 0.1); // マイナスが増える
                user.bank += interest;
                await user.save();
                socket.emit('login_error', `【ATM通知】借金の利息 ${Math.abs(interest)}枚 が加算されました`);
            }
        }

        socket.data.userName = name;
        // フロントに bank も一緒に送る
        socket.emit('login_success', { name: user.name, chips: user.chips, bank: user.bank });
        
        // チャット履歴送信などはそのまま
        const history = await Chat.find().sort({ time: -1 }).limit(30);
        socket.emit('chat_history', history.reverse());
        updateRanking();
    } catch (err) { console.error(err); }
});
    
            // ログイン成功時にチャット履歴（最新30件）を送信
const history = await Chat.find().sort({ time: -1 }).limit(30);
// 余計な .map(...) を消して、DBから届いたデータをそのまま送ります
socket.emit('chat_history', history.reverse());
            
            updateRanking();
        } catch (err) { console.error(err); }
    });

// --- [スロット] ペカり確率 1/50 のロジック追加 ---
socket.on('spin_request', async (data) => {
    try {
        const user = await User.findOne({ name: socket.data.userName });
        if (!user || user.chips < data.bet) return;

        const symbols = ["🍒", "💎", "7️⃣", "🍋", "⭐"];
        
        // 1/50の確率で「当たり（ペカり）」フラグを立てる
        const isPekari = Math.floor(Math.random() * 50) === 0;
        
        let result;
        if (isPekari) {
            // ペカる時は強制的に 7-7-7 にする
            result = ["7️⃣", "7️⃣", "7️⃣"];
        } else {
            // 通常時はランダム（たまに揃う）
            result = [
                symbols[Math.floor(Math.random() * 5)],
                symbols[Math.floor(Math.random() * 5)],
                symbols[Math.floor(Math.random() * 5)]
            ];
        }

        let multiplier = 0;
        if (result[0] === result[1] && result[1] === result[2]) {
            multiplier = (result[0] === "7️⃣") ? 50 : 10;
        }

        user.chips = user.chips - data.bet + (data.bet * multiplier);
        if (user.chips <= 0) {
            await User.deleteOne({ _id: user._id });
            return socket.emit('login_error', "破産しました。");
        }
        await user.save();

        // クライアントに結果とペカりフラグを送信
        socket.emit('spin_result', { 
            result, 
            win: data.bet * multiplier, 
            newChips: user.chips,
            isPekari: isPekari // これをフロントで受け取って光らせる！
        });
        updateRanking();
    } catch (err) { console.error(err); }
});

socket.on('chat_message', async (data) => {
    if (!socket.data.userName) return;

    // 受信したデータが「文字列(msg)」か「オブジェクト({message: msg})」か判定する
    const messageText = (typeof data === 'string') ? data : (data.message || data.msg);

    try {
        const newChat = new Chat({ 
            userName: socket.data.userName, 
            message: messageText // ✅ 確実にこの名前で保存
        });
        await newChat.save();

        io.emit('broadcast', {
            userName: socket.data.userName,
            message: messageText
        });
    } catch (err) { console.error("DB保存エラー:", err); }
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




