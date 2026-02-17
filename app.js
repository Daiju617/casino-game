const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 1. データベース設定 ---
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB接続成功"))
    .catch(err => console.error("❌ DBエラー:", err));

// ユーザーデータの保存形式（ログインボーナス用にlastLoginを追加）
const userSchema = new mongoose.Schema({
    name: String,
    chips: Number,
    lastLogin: Date
});
const User = mongoose.model('User', userSchema);

// --- 2. サーバー設定 ---
app.use(express.static(__dirname));

// --- 3. ゲームロジック ---

io.on('connection', (socket) => {
    console.log('ユーザーが接続しました');

    // 【B：ログインボーナス機能付きログイン】
    socket.on('login_request', async (name) => {
        socket.userName = name;
        let user = await User.findOne({ name: name });
        let bonusMessage = "";

        if (!user) {
            user = new User({ name: name, chips: 1000, lastLogin: new Date() });
            await user.save();
            bonusMessage = `ようこそ ${name}さん！新規特典1,000枚贈呈！`;
        } else {
            const now = new Date();
            const last = user.lastLogin || new Date(0);
            // 24時間以上経過判定
            if (now - last > 24 * 60 * 60 * 1000) {
                user.chips += 500;
                user.lastLogin = now;
                await user.save();
                bonusMessage = `毎日ボーナス！500枚獲得！（現在: ${user.chips}枚）`;
            } else {
                // ログイン時刻だけ更新
                user.lastLogin = now;
                await user.save();
            }
        }

        socket.emit('login_success', { name: user.name, chips: user.chips });
        if (bonusMessage) io.emit('broadcast', bonusMessage);
        updateRanking();
    });

    // 【スロット：リスク比例配当】
    socket.on('spin_request', async (data) => {
        const user = await User.findOne({ name: socket.userName });
        if (!user || user.chips < data.bet) return;

        const symbols = ["🍒", "💎", "7️⃣", "🍋", "⭐"];
        const result = [
            symbols[Math.floor(Math.random() * symbols.length)],
            symbols[Math.floor(Math.random() * symbols.length)],
            symbols[Math.floor(Math.random() * symbols.length)]
        ];

        let multiplier = 0;
        if (result[0] === result[1] && result[1] === result[2]) {
            if (result[0] === "7️⃣") multiplier = 50; 
            else if (result[0] === "💎") multiplier = 20;
            else multiplier = 10;
        } else if (result[0] === result[1] || result[1] === result[2] || result[0] === result[2]) {
            multiplier = 2; // 小当たり
        }

        const win = data.bet * multiplier;
        user.chips = user.chips - data.bet + win;
        await user.save();

        socket.emit('spin_result', { result, win, newChips: user.chips });
        updateRanking();
    });

    // 【C：新ゲーム ダブルアップ】
    socket.on('double_up_request', async (data) => {
        const user = await User.findOne({ name: socket.userName });
        if (!user || user.chips < data.bet) return;

        const myCard = Math.floor(Math.random() * 10);
        const dealerCard = Math.floor(Math.random() * 10);
        let win = 0;
        let msg = "";

        if (myCard > dealerCard) {
            win = data.bet * 2;
            msg = `勝利！ 貴方:${myCard} vs 敵:${dealerCard} (+${win})`;
        } else if (myCard === dealerCard) {
            win = data.bet;
            msg = `引き分け！ 両者:${myCard} (返金)`;
        } else {
            win = 0;
            msg = `敗北... 貴方:${myCard} vs 敵:${dealerCard}`;
        }

        user.chips = user.chips - data.bet + win;
        await user.save();

        socket.emit('double_up_result', { win, message: msg, newChips: user.chips });
        updateRanking();
    });
});

// ランキング更新
async function updateRanking() {
    const topUsers = await User.find().sort({ chips: -1 }).limit(5);
    io.emit('update_ranking', topUsers);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
