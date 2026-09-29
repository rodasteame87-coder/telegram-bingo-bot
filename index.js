const { Telegraf } = require("telegraf");
const { Pool } = require("pg");
const http = require("http");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

const BOT_USERNAME = "Rudivollerbingo_bot";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing!");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      chat_id BIGINT PRIMARY KEY,
      host_id BIGINT NOT NULL,
      host_name TEXT NOT NULL,
      called_numbers JSONB NOT NULL DEFAULT '[]',
      winner TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      chat_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      name TEXT NOT NULL,
      card JSONB NOT NULL,
      PRIMARY KEY (chat_id, user_id),
      FOREIGN KEY (chat_id)
        REFERENCES games(chat_id)
        ON DELETE CASCADE
    )
  `);

  console.log("✅ PostgreSQL database ready!");
}


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


bot.command("newgame", async (ctx) => {
  const chatId = String(ctx.chat.id);

  const existing = await pool.query(
    "SELECT chat_id FROM games WHERE chat_id = $1",
    [chatId]
  );

  if (existing.rows.length > 0) {
    return ctx.reply("⚠️ A game is already running.");
  }

  await pool.query(
    `
    INSERT INTO games
      (chat_id, host_id, host_name, called_numbers, winner)
    VALUES
      ($1, $2, $3, '[]', NULL)
    `,
    [
      chatId,
      String(ctx.from.id),
      ctx.from.first_name
    ]
  );

  await ctx.reply(
    "🎱 NEW BINGO GAME!\n\n" +
      `👑 Host: ${ctx.from.first_name}\n\n` +
      "Players can now use /join"
  );
});


bot.command("join", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userId = String(ctx.from.id);

  const gameResult = await pool.query(
    "SELECT winner FROM games WHERE chat_id = $1",
    [chatId]
  );

  if (gameResult.rows.length === 0) {
    return ctx.reply(
      "❌ No Bingo game is running.\nUse /newgame first."
    );
  }

  if (gameResult.rows[0].winner) {
    return ctx.reply(
      "🏁 This game already has a winner."
    );
  }

  const existingPlayer = await pool.query(
    `
    SELECT user_id
    FROM players
    WHERE chat_id = $1 AND user_id = $2
    `,
    [chatId, userId]
  );

  if (existingPlayer.rows.length > 0) {
    return ctx.reply(
      "⚠️ You are already in the game."
    );
  }

  const card = createBingoCard();

  await pool.query(
    `
    INSERT INTO players
      (chat_id, user_id, name, card)
    VALUES
      ($1, $2, $3, $4)
    `,
    [
      chatId,
      userId,
      ctx.from.first_name,
      JSON.stringify(card)
    ]
  );

  await ctx.reply(
    `🎉 ${ctx.from.first_name} joined the game!\n\n` +
      formatCard(card)
  );
});


bot.command("players", async (ctx) => {
  const chatId = String(ctx.chat.id);

  const result = await pool.query(
    `
    SELECT name
    FROM players
    WHERE chat_id = $1
    ORDER BY user_id
    `,
    [chatId]
  );

  if (result.rows.length === 0) {
    return ctx.reply(
      "👥 No players have joined yet."
    );
  }

  let text = "👥 BINGO PLAYERS\n\n";

  result.rows.forEach((player, index) => {
    text += `${index + 1}. ${player.name}\n`;
  });

  await ctx.reply(text);
});


bot.command("play", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userId = String(ctx.from.id);

  const gameResult = await pool.query(
    "SELECT chat_id FROM games WHERE chat_id = $1",
    [chatId]
  );

  if (gameResult.rows.length === 0) {
    return ctx.reply(
      "❌ No Bingo game is running.\nUse /newgame first."
    );
  }

  const playerResult = await pool.query(
    `
    SELECT user_id
    FROM players
    WHERE chat_id = $1 AND user_id = $2
    `,
    [chatId, userId]
  );

  if (playerResult.rows.length === 0) {
    return ctx.reply(
      "❌ You are not in this game.\nUse /join first."
    );
  }

  const link =
    `https://t.me/${BOT_USERNAME}?startapp=${encodeURIComponent(chatId)}`;

  await ctx.reply(
    "🎱 Open your Bingo card:\n\n" +
      link
  );
});


bot.command("call", async (ctx) => {
  const chatId = String(ctx.chat.id);

  const gameResult = await pool.query(
    `
    SELECT called_numbers, winner
    FROM games
    WHERE chat_id = $1
    `,
    [chatId]
  );

  if (gameResult.rows.length === 0) {
    return ctx.reply(
      "❌ No Bingo game is running."
    );
  }

  const game = gameResult.rows[0];

  if (game.winner) {
    return ctx.reply(
      `🏆 ${game.winner} already won this game!`
    );
  }

  const playersResult = await pool.query(
    `
    SELECT COUNT(*) AS count
    FROM players
    WHERE chat_id = $1
    `,
    [chatId]
  );

  if (Number(playersResult.rows[0].count) === 0) {
    return ctx.reply(
      "⚠️ Nobody has joined yet. Use /join first."
    );
  }

  const calledNumbers =
    game.called_numbers || [];

  if (calledNumbers.length >= 75) {
    return ctx.reply(
      "🎱 All 75 numbers have been called!"
    );
  }

  let number;

  do {
    number =
      Math.floor(Math.random() * 75) + 1;
  } while (calledNumbers.includes(number));

  calledNumbers.push(number);

  await pool.query(
    `
    UPDATE games
    SET called_numbers = $1
    WHERE chat_id = $2
    `,
    [
      JSON.stringify(calledNumbers),
      chatId
    ]
  );

  await ctx.reply(
    "🎱 NUMBER CALLED!\n\n" +
      `🔔 ${getLetter(number)}-${number}\n\n` +
      `📊 ${calledNumbers.length}/75 numbers called`
  );
});


bot.command("bingo", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userId = String(ctx.from.id);

  const gameResult = await pool.query(
    `
    SELECT called_numbers, winner
    FROM games
    WHERE chat_id = $1
    `,
    [chatId]
  );

  if (gameResult.rows.length === 0) {
    return ctx.reply(
      "❌ No Bingo game is running."
    );
  }

  const game = gameResult.rows[0];

  if (game.winner) {
    return ctx.reply(
      `🏆 ${game.winner} already won this game!`
    );
  }

  const playerResult = await pool.query(
    `
    SELECT name, card
    FROM players
    WHERE chat_id = $1 AND user_id = $2
    `,
    [chatId, userId]
  );

  if (playerResult.rows.length === 0) {
    return ctx.reply(
      "❌ You are not in this game.\nUse /join first."
    );
  }

  const player = playerResult.rows[0];

  const calledNumbers =
    game.called_numbers || [];

  if (calledNumbers.length === 0) {
    return ctx.reply(
      "⚠️ No numbers have been called yet."
    );
  }

  if (
    !hasBingo(
      player.card,
      calledNumbers
    )
  ) {
    return ctx.reply(
      "❌ Not Bingo yet!\nKeep playing."
    );
  }

  await pool.query(
    `
    UPDATE games
    SET winner = $1
    WHERE chat_id = $2
    `,
    [
      player.name,
      chatId
    ]
  );

  await ctx.reply(
    "🏆🎉 BINGO! 🎉🏆\n\n" +
      `${player.name} has won the game!\n\n` +
      `🎱 Numbers called: ${calledNumbers.length}`
  );
});


bot.command("endgame", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userId = String(ctx.from.id);

  const gameResult = await pool.query(
    `
    SELECT host_id
    FROM games
    WHERE chat_id = $1
    `,
    [chatId]
  );

  if (gameResult.rows.length === 0) {
    return ctx.reply(
      "❌ No Bingo game is running."
    );
  }

  if (
    String(gameResult.rows[0].host_id) !== userId
  ) {
    return ctx.reply(
      "⛔ Only the game host can end the game."
    );
  }

  await pool.query(
    "DELETE FROM games WHERE chat_id = $1",
    [chatId]
  );

  await ctx.reply(
    "🏁 Bingo game ended!"
  );
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


const server = http.createServer(
  async (req, res) => {

    if (req.url.startsWith("/api/bingo")) {

      const url = new URL(
        req.url,
        `http://${req.headers.host}`
      );

      const chatId =
        url.searchParams.get("chatId");

      const userId =
        url.searchParams.get("userId");

      const gameResult =
        await pool.query(
          `
          SELECT called_numbers, winner
          FROM games
          WHERE chat_id = $1
          `,
          [chatId]
        );

      if (gameResult.rows.length === 0) {

        res.writeHead(404, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify({
            error:
              "No Bingo game found"
          })
        );

        return;
      }

      const game =
        gameResult.rows[0];

      if (game.winner) {

        res.writeHead(400, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify({
            error:
              `${game.winner} already won this game!`
          })
        );

        return;
      }

      const playerResult =
        await pool.query(
          `
          SELECT name, card
          FROM players
          WHERE chat_id = $1
          AND user_id = $2
          `,
          [chatId, userId]
        );

      if (
        playerResult.rows.length === 0
      ) {

        res.writeHead(404, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify({
            error:
              "You are not in this game"
          })
        );

        return;
      }

      const player =
        playerResult.rows[0];

      const calledNumbers =
        game.called_numbers || [];

      if (
        !hasBingo(
          player.card,
          calledNumbers
        )
      ) {

        res.writeHead(400, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify({
            error:
              "Not Bingo yet! Keep playing."
          })
        );

        return;
      }

      await pool.query(
        `
        UPDATE games
        SET winner = $1
        WHERE chat_id = $2
        `,
        [
          player.name,
          chatId
        ]
      );

      try {

        await bot.telegram.sendMessage(
          chatId,
          "🏆🎉 BINGO! 🎉🏆\n\n" +
            `${player.name} has won the game!\n\n` +
            `🎱 Numbers called: ${calledNumbers.length}`
        );

      } catch (error) {

        console.error(
          "Could not announce Bingo:",
          error.message
        );

      }

      res.writeHead(200, {
        "Content-Type":
          "application/json"
      });

      res.end(
        JSON.stringify({
          success: true,
          winner: player.name
        })
      );

      return;
    }


    if (req.url.startsWith("/api/card")) {

      const url = new URL(
        req.url,
        `http://${req.headers.host}`
      );

      const chatId =
        url.searchParams.get("chatId");

      const userId =
        url.searchParams.get("userId");

      const gameResult =
        await pool.query(
          `
          SELECT
            called_numbers,
            winner
          FROM games
          WHERE chat_id = $1
          `,
          [chatId]
        );

      if (
        gameResult.rows.length === 0
      ) {

        res.writeHead(404, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify({
            error:
              "No Bingo game found"
          })
        );

        return;
      }

      const playerResult =
        await pool.query(
          `
          SELECT
            name,
            card
          FROM players
          WHERE chat_id = $1
          AND user_id = $2
          `,
          [chatId, userId]
        );

      if (
        playerResult.rows.length === 0
      ) {

        res.writeHead(404, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify({
            error:
              "You are not in this Bingo game"
          })
        );

        return;
      }

      const game =
        gameResult.rows[0];

      const player =
        playerResult.rows[0];

      res.writeHead(200, {
        "Content-Type":
          "application/json"
      });

      res.end(
        JSON.stringify({
          name: player.name,
          card: player.card,
          calledNumbers:
            game.called_numbers || [],
          winner: game.winner
        })
      );

      return;
    }


    if (req.url.startsWith("/miniapp")) {

      const filePath =
        path.join(
          __dirname,
          "miniapp",
          "index.html"
        );

      fs.readFile(
        filePath,
        (err, data) => {

          if (err) {

            res.writeHead(500, {
              "Content-Type":
                "text/plain"
            });

            res.end(
              "Mini App error"
            );

            return;
          }

          res.writeHead(200, {
            "Content-Type":
              "text/html"
          });

          res.end(data);
        }
      );

      return;
    }


    res.writeHead(200, {
      "Content-Type":
        "text/plain"
    });

    res.end(
      "Bingo bot is running!"
    );
  }
);


server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `🌐 Web server running on port ${PORT}`
    );

  }
);


initDatabase()
  .then(() => {

    bot.launch();

    console.log(
      "🎱 Bingo bot is running!"
    );

  })
  .catch((error) => {

    console.error(
      "❌ Database startup error:",
      error
    );

    process.exit(1);

  });


process.once(
  "SIGINT",
  () => {

    bot.stop("SIGINT");

  }
);


process.once(
  "SIGTERM",
  () => {

    bot.stop("SIGTERM");

  }
);
