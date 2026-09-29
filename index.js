const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;

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
  ctx.reply(
    "🎉 Bingo game started!\n\n" +
    "More Bingo features are coming next."
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    "📋 Commands:\n\n" +
    "/start - Start the bot\n" +
    "/bingo - Start a Bingo game\n" +
    "/help - Show help"
  );
});

bot.launch();

console.log("🎱 Bingo bot is running!");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
