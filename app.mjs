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

// --- 【1】ハイアンドロー開始 ---
    socket.on('hl_start', async (data) => {
        try {
            const user = await User.findOne({ name: socket.data.userName });
            // フロントから送られてくる賭け金を確実に取得
            const bet = parseInt(data?.bet || 100);

            if (!user || user.chips < bet || bet <= 0) {
                return socket.emit('login_error', "チップが足りないか、無効な金額です");
            }

            // チップをマイナス
            user.chips -= bet;
            await user.save();

            const deck = createDeck();
            const firstCard = deck.pop();

            // サーバー側の変数名を固定（hlPending, hlCount, hlDeck）
            socket.data.hlPending = bet; 
            socket.data.hlCount = 0;
            socket.data.hlDeck = deck;
            socket.data.hlCurrent = firstCard;

            // セットアップ。ここがズレるとDEALボタンから進まない
            socket.emit('hl_setup', { currentCard: firstCard });
            
            // 所持金を同期
            socket.emit('login_success', { 
                name: user.name, 
                chips: user.chips, 
                bank: user.bank 
            });
        } catch (e) { console.error("HL Start Error:", e); }
    });

    // --- 【2】ハイアンドロー予想 (ここを抜本的に修正) ---
    socket.on('hl_guess', async (data) => {
        // 変数チェック
        if (!socket.data.hlCurrent || !socket.data.hlDeck) return;

        const nextCard = socket.data.hlDeck.pop();
        const curVal = getHLValue(socket.data.hlCurrent.rank);
        const nextVal = getHLValue(nextCard.rank);

        // 判定（同じ数字はプレイヤー勝利）
        const isWin = (data.choice === 'high' && nextVal >= curVal) || 
                      (data.choice === 'low' && nextVal <= curVal);

        if (isWin) {
            // 配当を2倍にする（NaN防止のため確実に数値計算）
            socket.data.hlPending = Math.floor(socket.data.hlPending * 2);
            socket.data.hlCount++;
            socket.data.hlCurrent = nextCard;

            // 【重要】win: true を送る。これでフロントは赤文字(終了)を出さず、続行モードになる
            socket.emit('hl_result', {
                win: true,
                msg: `正解！配当: ${socket.data.hlPending}枚`,
                oldCard: nextCard,     // 伏せられたカードを開くアニメーション用
                currentCard: nextCard, // フロントの表示上書き用
                pending: socket.data.hlPending,
                count: socket.data.hlCount
            });
        } else {
            // ハズレ：全額没収してデータをクリア
            socket.data.hlPending = 0;
            socket.data.hlCurrent = null;
            
            // win: false を送ることで、フロントに「赤い文字での終了」を許可する
            socket.emit('hl_result', {
                win: false,
                msg: "残念！ハズレで全額没収です...",
                oldCard: nextCard,
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
            }
        } catch (e) { console.error("HL Collect Error:", e); }
    });

}); // ここが io.on の閉じカッコ。全ての通信はこの手前に入れる。

server.listen(process.env.PORT || 3000, "0.0.0.0", () => console.log(`🚀 Ready`));





