const { Telegraf } = require("telegraf");
const http = require("http");

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Store player cards
const players = new Map();

// Create a random Bingo card
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

    for (let n = ranges[column][0]; n <= ranges[column][1]; n++) {
      numbers.push(n);
    }

    numbers.sort(() => Math.random() - 0.5);

    for (let row = 0; row < 5; row++) {
      if (!card[row]) card[row] = [];

      card[row][column] = numbers[row];
    }
  }

  // Free center
  card[2][2] = "FREE";

  return card;
}

// Format card for Telegram
function formatCard(card) {
  let text = "🎟️ YOUR BINGO CARD\n\n";

  text += " B   I   N   G   O\n";
  text += "-------------------\n";

  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 5; column++) {
      const value = String(card[row][column]).padStart(4, " ");

      text += value;
    }

    text += "\n";
  }

  return text;
}

bot.start((ctx) => {
  ctx.reply(
    "🎱 Welcome to Bingo Bot!\n\n" +
    "Use /bingo to get your Bingo card."
  );
});

bot.command("bingo", (ctx) => {
  const userId = ctx.from.id;

  const card = createBingoCard();

  players.set(userId, {
    name: ctx.from.first_name,
    card: card
  });

  ctx.reply(formatCard(card));
});

bot.command("help", (ctx) => {
  ctx.reply(
    "📋 Commands:\n\n" +
    "/start - Start the bot\n" +
    "/bingo - Get a Bingo card\n" +
    "/help - Show help"
  );
});

// Render HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bingo bot is running!");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

bot.launch();

console.log("🎱 Bingo bot is running!");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
