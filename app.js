const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- データベース接続 ---
const MONGO_URI = process.env.MONGO_URI; 
mongoose.connect(MONGO_URI)
    .then(() => {
        console.log("✅ MongoDB接続成功：サーバーは正常に稼働しています");
    })
    .catch(err => {
        console.error("❌ MongoDB接続エラー:", err.message);
    });

// ユーザーデータの定義
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    password: { type: String, required: true },
    chips: { type: Number, default: 1000 },
    lastLogin: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

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

// 状態管理用
let bjGames = {}; 
let hlCurrentCard = {};

// --- 通信ロジック ---
io.on('connection', (socket) => {
    console.log('ユーザーが接続しました');

    // --- チャット機能 ---
    socket.on('chat_message', (msg) => {
        if (!socket.userName) return;
        io.emit('broadcast', `${socket.userName}: ${msg}`);
    });

    // --- ログイン・新規登録 (元のロジックを完全保持) ---
    socket.on('login_request', async (data) => {
        const { name, password } = data;
        try {
            let user = await User.findOne({ name: name });
            if (!user) {
                console.log(`新規プレイヤー登録中: ${name}`);
                user = new User({ 
                    name: name, password: password, chips: 1000, lastLogin: new Date() 
                });
                await user.save();
                socket.userName = name;
                socket.emit('login_success', { name: user.name, chips: user.chips });
                io.emit('broadcast', `✨ 新規プレイヤー ${name} さんが来店しました！`);
            } else {
                if (user.password !== password) {
                    console.log(`ログイン失敗（パスワード不一致）: ${name}`);
                    return socket.emit('login_error', "パスワードが正しくありません。");
                }
                socket.userName = name;
                const now = new Date();
                const last = user.lastLogin || new Date(0);
                const oneDay = 24 * 60 * 60 * 1000;
                if (now - last > oneDay) {
                    user.chips += 500;
                    user.lastLogin = now;
                    await user.save();
                    io.emit('broadcast', `🎁 ${name} さん、24時間ぶりの来店ボーナス500枚！`);
                } else {
                    user.lastLogin = now;
                    await user.save();
                }
                socket.emit('login_success', { name: user.name, chips: user.chips });
            }
            updateRanking();
        } catch (err) {
            console.error("システムエラー:", err);
            socket.emit('login_error', "サーバーでエラーが発生しました。");
        }
    });

    // --- スロットロジック (元の倍率設定を保持) ---
    socket.on('spin_request', async (data) => {
        try {
            const user = await User.findOne({ name: socket.userName });
            if (!user || user.chips < data.bet) return;
            const symbols = ["🍒", "💎", "7️⃣", "🍋", "⭐"];
            const result = [
                symbols[Math.floor(Math.random() * 5)],
                symbols[Math.floor(Math.random() * 5)],
                symbols[Math.floor(Math.random() * 5)]
            ];
            let multiplier = 0;
            if (result[0] === result[1] && result[1] === result[2]) {
                multiplier = (result[0] === "7️⃣") ? 50 : 10;
            } else if (result[0] === result[1] || result[1] === result[2] || result[0] === result[2]) {
                multiplier = 2;
            }
            const win = data.bet * multiplier;
            user.chips = user.chips - data.bet + win;
            await user.save();
            socket.emit('spin_result', { result, win, newChips: user.chips });
            updateRanking();
        } catch (err) { console.error(err); }
    });

    // --- 新・本格ブラックジャック ---
    socket.on('bj_start', async (data) => {
        const user = await User.findOne({ name: socket.userName });
        if (!user || user.chips < data.bet) return;
        const deck = createDeck();
        bjGames[socket.id] = { p: [deck.pop(), deck.pop()], d: [deck.pop(), deck.pop()], deck, bet: data.bet };
        socket.emit('bj_update', { 
            player: bjGames[socket.id].p, 
            dealer: [bjGames[socket.id].d[0], {rank:'?', suit:'?'}],
            pSum: getBJValue(bjGames[socket.id].p)
        });
    });

    socket.on('bj_hit', () => {
        const g = bjGames[socket.id]; if (!g) return;
        g.p.push(g.deck.pop());
        const sum = getBJValue(g.p);
        if (sum > 21) {
            socket.emit('bj_result', { player: g.p, dealer: g.d, msg: "BUST (Lose)", win: 0 });
            delete bjGames[socket.id];
        } else {
            socket.emit('bj_update', { player: g.p, dealer: [g.d[0], {rank:'?'}], pSum: sum });
        }
    });

socket.on('bj_stand', async (data) => {
        const g = bjGames[socket.id]; if (!g) return;
        const user = await User.findOne({ name: socket.userName });
        
        let dSum = getBJValue(g.d);
        // ディーラーは17以上になるまで引き続ける
        while (dSum < 17) { 
            g.d.push(g.deck.pop()); 
            dSum = getBJValue(g.d); 
        }
        
        const pSum = getBJValue(g.p);
        let win = 0;
        let msg = "";

        if (dSum > 21 || pSum > dSum) {
            win = Math.floor(g.bet * 2); // 勝利：2倍
            msg = "WIN!";
        } else if (pSum === dSum) {
            win = g.bet; // 引き分け：返金
            msg = "PUSH";
        } else {
            win = 0; // 敗北
            msg = "LOSE";
        }

        // ここでチップを確実に更新
        user.chips = user.chips - g.bet + win;
        await user.save();

        socket.emit('bj_result', { 
            player: g.p, 
            dealer: g.d, 
            msg: msg, 
            newChips: user.chips 
        });
        
        delete bjGames[socket.id];
        updateRanking();
    });
    
    // --- 新・ハイアンドロー ---
    socket.on('hl_start', () => {
        hlCurrentCard[socket.id] = createDeck().pop();
        socket.emit('hl_setup', { currentCard: hlCurrentCard[socket.id] });
    });

    socket.on('hl_guess', async (data) => {
        const user = await User.findOne({ name: socket.userName });
        if (!user || !hlCurrentCard[socket.id]) return;
        const next = createDeck().pop();
        const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
        const isWin = (data.choice === 'high' && ranks.indexOf(next.rank) > ranks.indexOf(hlCurrentCard[socket.id].rank)) ||
                      (data.choice === 'low' && ranks.indexOf(next.rank) < ranks.indexOf(hlCurrentCard[socket.id].rank));
        let win = (next.rank === hlCurrentCard[socket.id].rank) ? data.bet : (isWin ? data.bet * 2 : 0);
        user.chips = user.chips - data.bet + win;
        await user.save();
        hlCurrentCard[socket.id] = next;
        socket.emit('hl_result', { oldCard: next, msg: win > 0 ? "WIN" : "LOSE", newChips: user.chips });
        updateRanking();
    });

    // ハイアンドローの賞金を確定して終了する
    socket.on('hl_collect', async () => {
        const user = await User.findOne({ name: socket.userName });
        // HLは1回ごとにチップを更新する現在の仕様なら、
        // 画面上の表示をリセットするだけでOK
        delete hlCurrentCard[socket.id];
        socket.emit('hl_finished', { newChips: user.chips });
    });

    // --- 管理者用コマンド (デバッグ用) ---
    socket.on('admin_command', async (d) => {
        if (d.pass !== "ADMIN_SECRET") return;
        if (d.act === "up") await User.findOneAndUpdate({ name: d.target }, { chips: d.val });
        updateRanking();
    });
});

async function updateRanking() {
    try {
        const list = await User.find().sort({ chips: -1 }).limit(5);
        io.emit('update_ranking', list);
    } catch (err) { console.error(err); }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

