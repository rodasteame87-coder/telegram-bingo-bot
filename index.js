const { Telegraf } = require("telegraf");
const http = require("http");

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const players = new Map();

// Numbers called during the current game
let calledNumbers = [];

// Create a Bingo card
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

  card[2][2] = "FREE";

  return card;
}

// Format Bingo card
function formatCard(card) {
  let text = "🎟️ YOUR BINGO CARD\n\n";

  text += " B   I   N   G   O\n";
  text += "-------------------\n";

  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 5; column++) {
      text += String(card[row][column]).padStart(5, " ");
    }

    text += "\n";
  }

  return text;
}

// Get Bingo letter
function getLetter(number) {
  if (number <= 15) return "B";
  if (number <= 30) return "I";
  if (number <= 45) return "N";
  if (number <= 60) return "G";
  return "O";
}

bot.start((ctx) => {
  ctx.reply(
    "🎱 Welcome to Bingo Bot!\n\n" +
    "Commands:\n" +
    "/bingo - Get a Bingo card\n" +
    "/call - Call a number\n" +
    "/numbers - Show called numbers\n" +
    "/help - Show help"
  );
});

// Create a card
bot.command("bingo", (ctx) => {
  const userId = ctx.from.id;

  const card = createBingoCard();

  players.set(userId, {
    name: ctx.from.first_name,
    card: card
  });

  ctx.reply(formatCard(card));
});

// Call a random number
bot.command("call", (ctx) => {
  if (calledNumbers.length >= 75) {
    return ctx.reply("🎱 All 75 numbers have been called!");
  }

  let number;

  do {
    number = Math.floor(Math.random() * 75) + 1;
  } while (calledNumbers.includes(number));

  calledNumbers.push(number);

  const letter = getLetter(number);

  ctx.reply(
    `🎱 NUMBER CALLED!\n\n` +
    `🔔 ${letter}-${number}\n\n` +
    `Numbers called: ${calledNumbers.length}/75`
  );
});

// Show called numbers
bot.command("numbers", (ctx) => {
  if (calledNumbers.length === 0) {
    return ctx.reply("📋 No numbers have been called yet.");
  }

  const sorted = [...calledNumbers].sort((a, b) => a - b);

  ctx.reply(
    `📋 CALLED NUMBERS\n\n` +
    `${sorted.join(", ")}\n\n` +
    `Total: ${calledNumbers.length}/75`
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    "📋 Commands:\n\n" +
    "/bingo - Get a Bingo card\n" +
    "/call - Call a number\n" +
    "/numbers - Show called numbers"
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
