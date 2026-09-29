const { Telegraf } = require("telegraf");
const http = require("http");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

const BOT_USERNAME = "Rudivollerbingo_bot";

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
      let number = ranges[column][0];
      number <= ranges[column][1];
      number++
    ) {
      numbers.push(number);
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
    "🎱 NEW BINGO GAME!\n\n" +
      `👑 Host: ${ctx.from.first_name}\n\n` +
      "Players can now use /join"
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
    return ctx.reply("🏁 This game already has a winner.");
  }

  const userId = ctx.from.id;

  if (game.players.has(userId)) {
    return ctx.reply("⚠️ You are already in the game.");
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
  const game =
