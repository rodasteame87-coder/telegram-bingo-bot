const { Telegraf } = require("telegraf");
const http = require("http");

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    "🎱 Welcome to Bingo Bot!\n\n" +
    "Use /bingo to start a Bingo game."
  );
});

bot.command("bingo", (ctx) => {
  ctx.reply("🎉 Bingo game started!");
});

bot.command("help", (ctx) => {
  ctx.reply(
    "📋 Commands:\n\n" +
    "/start - Start the bot\n" +
    "/bingo - Start a Bingo game\n" +
    "/help - Show help"
  );
});

// HTTP server for Render
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bingo bot is running!");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

// Start Telegram bot
bot.launch();

console.log("🎱 Bingo bot is running!");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
