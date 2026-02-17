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

// --- 通信ロジック ---
io.on('connection', (socket) => {
    console.log('ユーザーが接続しました');

    // 【ログイン・新規登録の修正】
    socket.on('login_request', async (data) => {
        const { name, password } = data;
        
        try {
            let user = await User.findOne({ name: name });

            if (!user) {
                // ユーザーが存在しない場合 ＝ 新規登録
                console.log(`新規プレイヤー登録中: ${name}`);
                user = new User({ 
                    name: name, 
                    password: password, 
                    chips: 1000, 
                    lastLogin: new Date() 
                });
                await user.save();
                socket.userName = name;
                socket.emit('login_success', { name: user.name, chips: user.chips });
                io.emit('broadcast', `✨ 新規プレイヤー ${name} さんが来店しました！`);
            } else {
                // ユーザーが存在する場合 ＝ パスワードチェック
                if (user.password !== password) {
                    console.log(`ログイン失敗（パスワード不一致）: ${name}`);
                    socket.emit('login_error', "パスワードが正しくありません。");
                    return;
                }

                // ログイン成功時の処理
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

    // 【スロットロジック】
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

    // 【ダブルアップロジック】
    socket.on('double_up_request', async (data) => {
        try {
            const user = await User.findOne({ name: socket.userName });
            if (!user || user.chips < data.bet) return;

            const pCard = Math.floor(Math.random() * 10);
            const dCard = Math.floor(Math.random() * 10);
            let win = 0, msg = "";

            if (pCard > dCard) {
                win = data.bet * 2;
                msg = `勝利！ 貴方:${pCard} vs 敵:${dCard} (+${win})`;
            } else if (pCard === dCard) {
                win = data.bet;
                msg = `引き分け！ 両者:${pCard} (返金)`;
            } else {
                msg = `敗北... 貴方:${pCard} vs 敵:${dCard}`;
            }

            user.chips = user.chips - data.bet + win;
            await user.save();
            socket.emit('double_up_result', { win, message: msg, newChips: user.chips });
            updateRanking();
        } catch (err) { console.error(err); }
    });
});

async function updateRanking() {
    const list = await User.find().sort({ chips: -1 }).limit(5);
    io.emit('update_ranking', list);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
