let gridSize = 3;
let count = 0;
let success = 0;
let isRunning = false;
let duration = 15000; // 15秒
let timer;

function startGame(size) {
  gridSize = size;
  count = 0;
  success = 0;
  isRunning = true;

  document.getElementById("result").innerHTML = "";
  generateGrid(size);

  const endTime = Date.now() + duration;

  timer = setInterval(() => {
    if (Date.now() >= endTime) {
      finishGame();
    }
  }, 10);

  activateRandomTile();
}

function generateGrid(size) {
  const game = document.getElementById("game");
  game.innerHTML = "";
  game.style.gridTemplateColumns = `repeat(${size}, 1fr)`;

  for (let i = 0; i < size * size; i++) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.onclick = () => handleClick(tile);
    game.appendChild(tile);
  }
}

function activateRandomTile() {
  const tiles = document.querySelectorAll(".tile");
  tiles.forEach(t => t.classList.remove("active"));

  const index = Math.floor(Math.random() * tiles.length);
  tiles[index].classList.add("active");
}

function handleClick(tile) {
  if (!isRunning) return;

  count++;

  if (tile.classList.contains("active")) {
    success++;
    activateRandomTile();
  }
}

function finishGame() {
  isRunning = false;
  clearInterval(timer);

  const accuracy = Math.round((success / count) * 100);
  const apm = Math.round((success / 15) * 60);

  document.getElementById("result").innerHTML =
    `APM: ${apm}<br>精度: ${accuracy}%`;

  sendScore(apm, accuracy);
  loadRanking();
}

async function sendScore(apm, accuracy) {
  const name = prompt("名前を入力してください");

  await fetch("/api/score", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      apm,
      accuracy,
      mode: `${gridSize}x${gridSize}`
    })
  });
}

async function loadRanking() {
  const res = await fetch(`/api/ranking/${gridSize}x${gridSize}`);
  const ranking = await res.json();

  const list = document.getElementById("ranking");
  list.innerHTML = "";

  ranking.forEach((item, i) => {
    const li = document.createElement("li");
    li.textContent = `${i + 1}. ${item.name} - ${item.apm} APM (${item.accuracy}%)`;
    list.appendChild(li);
  });
}
