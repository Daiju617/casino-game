const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 1. データベース接続設定 ---
const MONGO_URI = process.env.MONGO_URI; 
mongoose.connect(MONGO_URI)
    .then(() => {
        console.log("✅ MongoDB接続成功：カジノサーバー稼働中");
    })
    .catch(err => {
        console.error("❌ MongoDB接続エラー:", err.message);
    });

// ユーザーデータの保存形式（パスワードとログインボーナス用）
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    password: { type: String, required: true },
    chips: { type: Number, default: 1000 },
    lastLogin: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 静的ファイルの提供（index.htmlを表示するため）
app.use(express.static(__dirname));

// --- 2. 通信ロジック ---
io.on('connection', (socket) => {
    console.log('新規ユーザーが接続しました');

    // 【ログイン処理（パスワード認証 & ボーナス）】
    socket.on('login_request', async (data) => {
        const { name, password } = data;
        
        try {
            let user = await User.findOne({ name: name });

            if (!user) {
                // 新規ユーザー作成
                user = new User({ 
                    name: name, 
                    password: password, 
                    chips: 1000, 
                    lastLogin: new Date() 
                });
                await user.save();
                console.log(`新規登録: ${name}`);
            } else {
                // 既存ユーザーのパスワードチェック
                if (user.password !== password) {
                    socket.emit('login_error', "パスワードが正しくありません。");
                    return;
                }

                // 24時間ごとのログインボーナス判定
                const now = new Date();
                const last = user.lastLogin || new Date(0);
                const diffTime = now - last;
                const oneDay = 24 * 60 * 60 * 1000;

                if (diffTime > oneDay) {
                    user.chips += 500;
                    user.lastLogin = now;
                    await user.save();
                    io.emit('broadcast', `🎁 ${name}さんが24時間ボーナス（500枚）を獲得しました！`);
                } else {
                    // ログイン時刻のみ更新
                    user.lastLogin = now;
                    await user.save();
                }
            }

            // ログイン成功を通知
            socket.userName = name;
            socket.emit('login_success', { name: user.name, chips: user.chips });
            updateRanking();

        } catch (err) {
            console.error("ログインエラー:", err);
            socket.emit('login_error', "サーバーエラーが発生しました。");
        }
    });

    // 【配当比例スロット処理】
    socket.on('spin_request', async (data) => {
        try {
            const user = await User.findOne({ name: socket.userName });
            const bet = parseInt(data.bet);

            if (!user || isNaN(bet) || bet <= 0 || user.chips < bet) {
                return;
            }

            const symbols = ["🍒", "💎", "7️⃣", "🍋", "⭐"];
            const result = [
                symbols[Math.floor(Math.random() * 5)],
                symbols[Math.floor(Math.random() * 5)],
                symbols[Math.floor(Math.random() * 5)]
            ];

            let multiplier = 0;
            // 3つ揃い（大当たり）
            if (result[0] === result[1] && result[1] === result[2]) {
                if (result[0] === "7️⃣") multiplier = 50; 
                else if (result[0] === "💎") multiplier = 20;
                else multiplier = 10;
            } 
            // 2つ揃い（小当たり）
            else if (result[0] === result[1] || result[1] === result[2] || result[0] === result[2]) {
                multiplier = 2;
            }

            const win = bet * multiplier;
            user.chips = user.chips - bet + win;
            await user.save();

            socket.emit('spin_result', { 
                result: result, 
                win: win, 
                newChips: user.chips 
            });
            updateRanking();

        } catch (err) {
            console.error("スロットエラー:", err);
        }
    });

    // 【ダブルアップ (High & Low) 処理】
    socket.on('double_up_request', async (data) => {
        try {
            const user = await User.findOne({ name: socket.userName });
            const bet = parseInt(data.bet);

            if (!user || isNaN(bet) || bet <= 0 || user.chips < bet) {
                return;
            }

            // 0〜9の数字で比較
            const playerCard = Math.floor(Math.random() * 10);
            const dealerCard = Math.floor(Math.random() * 10);
            
            let win = 0;
            let message = "";

            if (playerCard > dealerCard) {
                win = bet * 2;
                message = `勝利！ 貴方:${playerCard} vs 敵:${dealerCard} (+${win})`;
            } else if (playerCard === dealerCard) {
                win = bet;
                message = `引き分け！ 両者:${playerCard} (返金)`;
            } else {
                win = 0;
                message = `敗北... 貴方:${playerCard} vs 敵:${dealerCard}`;
            }

            user.chips = user.chips - bet + win;
            await user.save();

            socket.emit('double_up_result', { 
                win: win, 
                message: message, 
                newChips: user.chips 
            });
            updateRanking();

        } catch (err) {
            console.error("ダブルアップエラー:", err);
        }
    });

    socket.on('disconnect', () => {
        console.log('ユーザーが離脱しました');
    });
});

// ランキングを全ユーザーに送信
async function updateRanking() {
    try {
        const topUsers = await User.find().sort({ chips: -1 }).limit(5);
        io.emit('update_ranking', topUsers);
    } catch (err) {
        console.error("ランキング更新エラー:", err);
    }
}

// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
