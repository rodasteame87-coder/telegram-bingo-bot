const { Telegraf, Markup } = require("telegraf");
const http = require("http");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const games = new Map();

function createBingoCard() {
  const ranges = [
    [1, 15],
    [16, 30],
    [31, 45],
    [46, 60],
    [61, 75]
  ];

  const card = [];

  for (let column = 0; column < 5; column++) {
    const numbers = [];

    for (
      let n = ranges[column][0];
      n <= ranges[column][1];
      n++
    ) {
      numbers.push(n);
    }

    numbers.sort(() => Math.random() - 0.5);

    for (let row = 0; row < 5; row++) {
      if (!card[row]) {
        card[row] = [];
      }

      card[row][column] = numbers[row];
    }
  }

  card[2][2] = "FREE";

  return card;
}

function formatCard(card) {
  let text = "🎟️ YOUR BINGO CARD\n\n";
  text += " B    I    N    G    O\n";
  text += "----------------------\n";

  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 5; column++) {
      text += String(card[row][column]).padStart(5, " ");
    }

    text += "\n";
  }

  return text;
}

function getLetter(number) {
  if (number <= 15) return "B";
  if (number <= 30) return "I";
  if (number <= 45) return "N";
  if (number <= 60) return "G";
  return "O";
}

function hasBingo(card, calledNumbers) {
  const called = new Set(calledNumbers);

  function marked(value) {
    return value === "FREE" || called.has(value);
  }

  for (let row = 0; row < 5; row++) {
    let complete = true;

    for (let column = 0; column < 5; column++) {
      if (!marked(card[row][column])) {
        complete = false;
        break;
      }
    }

    if (complete) return true;
  }

  for (let column = 0; column < 5; column++) {
    let complete = true;

    for (let row = 0; row < 5; row++) {
      if (!marked(card[row][column])) {
        complete = false;
        break;
      }
    }

    if (complete) return true;
  }

  let diagonal1 = true;

  for (let i = 0; i < 5; i++) {
    if (!marked(card[i][i])) {
      diagonal1 = false;
      break;
    }
  }

  if (diagonal1) return true;

  let diagonal2 = true;

  for (let i = 0; i < 5; i++) {
    if (!marked(card[i][4 - i])) {
      diagonal2 = false;
      break;
    }
  }

  return diagonal2;
}

bot.start((ctx) => {
  ctx.reply(
    "🎱 Welcome to Bingo Bot!\n\n" +
    "Commands:\n\n" +
    "/newgame - Create a game\n" +
    "/join - Join the game\n" +
    "/players - Show players\n" +
    "/play - Open your Bingo card\n" +
    "/call - Call a number\n" +
    "/bingo - Claim Bingo\n" +
    "/endgame - End the game\n" +
    "/help - Show help"
  );
});

bot.command("newgame", (ctx) => {
  const chatId = ctx.chat.id;

  if (games.has(chatId)) {
    return ctx.reply("⚠️ A game is already running.");
  }

  games.set(chatId, {
    hostId: ctx.from.id,
    hostName: ctx.from.first_name,
    players: new Map(),
    calledNumbers: [],
    winner: null
  });

  ctx.reply(
    `🎱 NEW BINGO GAME!\n\n` +
    `👑 Host: ${ctx.from.first_name}\n\n` +
    `Players can now use /join`
  );
});

bot.command("join", (ctx) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  if (!game) {
    return ctx.reply(
      "❌ No Bingo game is running.\nUse /newgame first."
    );
  }

  if (game.winner) {
    return ctx.reply(
      "🏁 This game already has a winner."
    );
  }

  const userId = ctx.from.id;

  if (game.players.has(userId)) {
    return ctx.reply(
      "⚠️ You are already in the game."
    );
  }

  const card = createBingoCard();

  game.players.set(userId, {
    name: ctx.from.first_name,
    card: card
  });

  ctx.reply(
    `🎉 ${ctx.from.first_name} joined the game!\n\n` +
    formatCard(card)
  );
});

bot.command("players", (ctx) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  if (!game) {
    return ctx.reply(
      "❌ No Bingo game is running."
    );
  }

  if (game.players.size === 0) {
    return ctx.reply(
      "👥 No players have joined yet."
    );
  }

  let text = "👥 BINGO PLAYERS\n\n";
  let number = 1;

  for (const player of game.players.values()) {
    text += `${number}. ${player.name}\n`;
    number++;
  }

  ctx.reply(text);
});

bot.command("play", async (ctx) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  if (!game) {
    return ctx.reply(
      "❌ No Bingo game is running.\nUse /newgame first."
    );
  }

  const userId = ctx.from.id;

  if (!game.players.has(userId)) {
    return ctx.reply(
      "❌ You are not in this game.\nUse /join first."
    );
  }

  const botUsername = bot.botInfo.username;

  const miniAppLink =
    `https://t.me/${botUsername}?startapp=${encodeURIComponent(chatId)}`;

  await ctx.reply(
    "🎱 Open your Bingo card below:",
    Markup.inlineKeyboard([
      Markup.button.url(
        "🎱 Open My Bingo Card",
        miniAppLink
      )
    ])
  );
});

bot.command("call", (ctx) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  if (!game) {
    return ctx.reply(
      "❌ No Bingo game is running."
    );
  }

  if (game.winner) {
    return ctx.reply(
      `🏆 ${game.winner} already won this game!`
    );
  }

  if (game.players.size === 0) {
    return ctx.reply(
      "⚠️ Nobody has joined yet. Use /join first."
    );
  }

  if (game.calledNumbers.length >= 75) {
    return ctx.reply(
      "🎱 All 75 numbers have been called!"
    );
  }

  let number;

  do {
    number = Math.floor(Math.random() * 75) + 1;
  } while (game.calledNumbers.includes(number));

  game.calledNumbers.push(number);

  const letter = getLetter(number);

  ctx.reply(
    `🎱 NUMBER CALLED!\n\n` +
    `🔔 ${letter}-${number}\n\n` +
    `📊 ${game.calledNumbers.length}/75 numbers called`
  );
});

bot.command("bingo", (ctx) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  if (!game) {
    return ctx.reply(
      "❌ No Bingo game is running.\nUse /newgame first."
    );
  }

  if (game.winner) {
    return ctx.reply(
      `🏆 ${game.winner} already won this game!`
    );
  }

  const player = game.players.get(ctx.from.id);

  if (!player) {
    return ctx.reply(
      "❌ You are not in this game.\nUse /join first."
    );
  }

  if (game.calledNumbers.length === 0) {
    return ctx.reply(
      "⚠️ No numbers have been called yet."
    );
  }

  const winner = hasBingo(
    player.card,
    game.calledNumbers
  );

  if (!winner) {
    return ctx.reply(
      "❌ Not Bingo yet!\nKeep playing."
    );
  }

  game.winner = player.name;

  ctx.reply(
    `🏆🎉 BINGO! 🎉🏆\n\n` +
    `${player.name} has won the game!\n\n` +
    `🎱 Numbers called: ${game.calledNumbers.length}`
  );
});

bot.command("endgame", (ctx) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  if (!game) {
    return ctx.reply(
      "❌ No Bingo game is running."
    );
  }

  if (ctx.from.id !== game.hostId) {
    return ctx.reply(
      "⛔ Only the game host can end the game."
    );
  }

  games.delete(chatId);

  ctx.reply("🏁 Bingo game ended!");
});

bot.command("help", (ctx) => {
  ctx.reply(
    "🎱 BINGO COMMANDS\n\n" +
    "/newgame - Create a game\n" +
    "/join - Join the game\n" +
    "/players - Show players\n" +
    "/play - Open your Bingo card\n" +
    "/call - Call a number\n" +
    "/bingo - Claim Bingo\n" +
    "/endgame - End the game"
  );
});

const server = http.createServer((req, res) => {

  if (req.url.startsWith("/api/card")) {

    const url = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    const chatId = url.searchParams.get("chatId");
    const userId = url.searchParams.get("userId");

    const game = games.get(Number(chatId));

    if (!game) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });

      res.end(JSON.stringify({
        error: "No Bingo game found"
      }));

      return;
    }

    const player = game.players.get(Number(userId));

    if (!player) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });

      res.end(JSON.stringify({
        error: "You are not in this Bingo game"
      }));

      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
      name: player.name,
      card: player.card,
      calledNumbers: game.calledNumbers,
      winner: game.winner
    }));

    return;
  }

  if (req.url === "/miniapp" || req.url === "/miniapp/") {

    const filePath = path.join(
      __dirname,
      "miniapp",
      "index.html"
    );

    fs.readFile(filePath, (err, data) => {

      if (err) {
        console.error(err);

        res.writeHead(500, {
          "Content-Type": "text/plain"
        });

        res.end("Mini App error");

        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html"
      });

      res.end(data);
    });

    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("Bingo bot is running!");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `🌐 Web server running on port ${PORT}`
  );
});

bot.launch();

console.log("🎱 Bingo bot is running!");

process.once("SIGINT", () => {
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
});
