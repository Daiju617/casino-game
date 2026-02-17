const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// --- データベース接続 ---
// ここをコピーした文字列に書き換え！ <password> の消し忘れに注意
const MONGO_URI = "mongodb+srv://tomnaga8510_db_user:<db_password>@casinogame.vkch471.mongodb.net/?appName=Casinogame"; 

// app.js 修正版
mongoose.connect(MONGO_URI)
    .then(() => console.log("MongoDBに接続成功！"))
    .catch(err => {
        console.error("DB接続エラー:");
        console.error(err); // ここで詳細を確認
    });

// ユーザーデータの設計図
const userSchema = new mongoose.Schema({
    username: String,
    chips: { type: Number, default: 1000 }
});
const User = mongoose.model('User', userSchema);

// --- 通信処理 ---
io.on('connection', (socket) => {
    
    // ログイン処理
    socket.on('login_request', async (name) => {
        let user = await User.findOne({ username: name });
        if (!user) {
            user = new User({ username: name, chips: 1000 });
            await user.save();
        }
        socket.userId = user._id;
        socket.username = name;
        socket.emit('login_success', { name: user.username, chips: user.chips });
        updateRankings();
    });

    // スロット処理
    socket.on('spin_request', async (data) => {
        if (!socket.userId) return;
        const user = await User.findById(socket.userId);
        const bet = parseInt(data.bet);

        if (!user || user.chips < bet) return;

        user.chips -= bet;
        const symbols = ["🍒", "💎", "7️⃣", "🍋", "⭐"];
        const result = [rand(symbols), rand(symbols), rand(symbols)];

        let win = 0;
        if (result[0] === result[1] && result[1] === result[2]) {
            win = bet * 5;
            if (result[0] === "7️⃣") io.emit('broadcast', `🔥 ${user.username}が777を当てたぞ！`);
        } else if (result[0] === result[1] || result[1] === result[2] || result[0] === result[2]) {
            win = Math.floor(bet * 1.5);
        }

        user.chips += win;
        await user.save(); // データベースに保存！

        socket.emit('spin_result', { result, win, newChips: user.chips });
        updateRankings();
    });
});

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function updateRankings() {
    const list = await User.find().sort({ chips: -1 }).limit(5);
    io.emit('update_ranking', list.map(u => ({ name: u.username, chips: u.chips })));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));