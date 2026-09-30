const { Telegraf } = require("telegraf");
const { Pool } = require("pg");
const http = require("http");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

const WEBHOOK_URL =
  "https://telegram-bingo-bot-q54q.onrender.com/telegram-webhook";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* =========================
   DATABASE
========================= */

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
      chat_id BIGINT,
      user_id BIGINT,
      name TEXT,
      card JSONB,
      marked_numbers JSONB NOT NULL DEFAULT '[]',
      PRIMARY KEY (chat_id, user_id),
      FOREIGN KEY (chat_id)
        REFERENCES games(chat_id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS marked_numbers JSONB NOT NULL DEFAULT '[]'
  `);

  console.log("Database initialized");
}

/* =========================
   BINGO CARD
========================= */

function generateCard() {
  const ranges = [
    [1, 15],
    [16, 30],
    [31, 45],
    [46, 60],
    [61, 75]
  ];

  const columns = ranges.map(([min, max]) => {
    const numbers = [];

    while (numbers.length < 5) {
      const number =
        Math.floor(Math.random() * (max - min + 1)) + min;

      if (!numbers.includes(number)) {
        numbers.push(number);
      }
    }

    return numbers;
  });

  const card = [];

  for (let row = 0; row < 5; row++) {
    const currentRow = [];

    for (let col = 0; col < 5; col++) {
      if (row === 2 && col === 2) {
        currentRow.push("FREE");
      } else {
        currentRow.push(columns[col][row]);
      }
    }

    card.push(currentRow);
  }

  return card;
}

/* =========================
   BINGO CHECK
========================= */

function checkBingo(card, markedNumbers) {
  const marked = new Set(markedNumbers);

  const isMarked = value =>
    value === "FREE" || marked.has(value);

  // Rows
  for (let row = 0; row < 5; row++) {
    if (card[row].every(isMarked)) {
      return true;
    }
  }

  // Columns
  for (let col = 0; col < 5; col++) {
    let complete = true;

    for (let row = 0; row < 5; row++) {
      if (!isMarked(card[row][col])) {
        complete = false;
        break;
      }
    }

    if (complete) {
      return true;
    }
  }

  // Main diagonal
  if (
    isMarked(card[0][0]) &&
    isMarked(card[1][1]) &&
    isMarked(card[2][2]) &&
    isMarked(card[3][3]) &&
    isMarked(card[4][4])
  ) {
    return true;
  }

  // Other diagonal
  if (
    isMarked(card[0][4]) &&
    isMarked(card[1][3]) &&
    isMarked(card[2][2]) &&
    isMarked(card[3][1]) &&
    isMarked(card[4][0])
  ) {
    return true;
  }

  return false;
}

function cardContainsNumber(card, number) {
  return card.some(row => row.includes(number));
}

/* =========================
   /newgame
========================= */

bot.command("newgame", async ctx => {
  try {
    const chatId = ctx.chat.id;
    const hostId = ctx.from.id;

    const hostName =
      ctx.from.first_name ||
      ctx.from.username ||
      "Host";

    await pool.query(
      `
      INSERT INTO games
        (chat_id, host_id, host_name, called_numbers, winner)
      VALUES
        ($1, $2, $3, '[]', NULL)
      ON CONFLICT (chat_id)
      DO UPDATE SET
        host_id = EXCLUDED.host_id,
        host_name = EXCLUDED.host_name,
        called_numbers = '[]',
        winner = NULL
      `,
      [chatId, hostId, hostName]
    );

    await pool.query(
      `DELETE FROM players WHERE chat_id = $1`,
      [chatId]
    );

    await ctx.reply(
      "🎉 New Bingo game created!\n\n" +
      "Players can now use /join to get a card."
    );

  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not create the game.");
  }
});

/* =========================
   /join
========================= */

bot.command("join", async ctx => {
  try {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    const name =
      ctx.from.first_name ||
      ctx.from.username ||
      "Player";

    const gameResult = await pool.query(
      `SELECT * FROM games WHERE chat_id = $1`,
      [chatId]
    );

    if (gameResult.rows.length === 0) {
      return ctx.reply(
        "❌ There is no active game.\nUse /newgame first."
      );
    }

    const existing = await pool.query(
      `
      SELECT *
      FROM players
      WHERE chat_id = $1 AND user_id = $2
      `,
      [chatId, userId]
    );

    if (existing.rows.length > 0) {
      return ctx.reply(
        "You already joined this game.\nUse /play to open your card."
      );
    }

    const card = generateCard();

    await pool.query(
      `
      INSERT INTO players
        (chat_id, user_id, name, card, marked_numbers)
      VALUES
        ($1, $2, $3, $4, '[]')
      `,
      [
        chatId,
        userId,
        name,
        JSON.stringify(card)
      ]
    );

    await ctx.reply(
      `🎫 ${name}, your Bingo card is ready!\n\n` +
      `Use /play to open your card.`
    );

  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not join the game.");
  }
});

/* =========================
   /players
========================= */

bot.command("players", async ctx => {
  try {
    const chatId = ctx.chat.id;

    const result = await pool.query(
      `
      SELECT name
      FROM players
      WHERE chat_id = $1
      ORDER BY name
      `,
      [chatId]
    );

    if (result.rows.length === 0) {
      return ctx.reply("No players have joined yet.");
    }

    const text =
      "👥 Players:\n\n" +
      result.rows
        .map((player, index) =>
          `${index + 1}. ${player.name}`
        )
        .join("\n");

    await ctx.reply(text);

  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not get players.");
  }
});

/* =========================
   /call
========================= */

bot.command("call", async ctx => {
  try {
    const chatId = ctx.chat.id;

    const result = await pool.query(
      `SELECT * FROM games WHERE chat_id = $1`,
      [chatId]
    );

    if (result.rows.length === 0) {
      return ctx.reply(
        "❌ No active game. Use /newgame first."
      );
    }

    const game = result.rows[0];

    if (game.winner) {
      return ctx.reply(
        `🏆 This game is already won by ${game.winner}.`
      );
    }

    const calledNumbers =
      game.called_numbers || [];

    if (calledNumbers.length >= 75) {
      return ctx.reply(
        "All 75 numbers have already been called."
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
      `🎱 Called number: ${number}\n\n` +
      `Numbers called: ${calledNumbers.length}/75`
    );

  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not call a number.");
  }
});

/* =========================
   /play
========================= */

bot.command("play", async ctx => {
  try {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    const gameResult = await pool.query(
      `SELECT * FROM games WHERE chat_id = $1`,
      [chatId]
    );

    if (gameResult.rows.length === 0) {
      return ctx.reply(
        "❌ No active game. Use /newgame first."
      );
    }

    const playerResult = await pool.query(
      `
      SELECT *
      FROM players
      WHERE chat_id = $1 AND user_id = $2
      `,
      [chatId, userId]
    );

    if (playerResult.rows.length === 0) {
      return ctx.reply(
        "❌ You have not joined this game yet.\nUse /join first."
      );
    }

    /*
      IMPORTANT:
      The game ID is the Telegram chat ID.

      Telegram passes the value after startapp=
      to the Mini App as start_param.
    */

    const miniAppUrl =
      `https://t.me/Rudivollerbingo_bot?startapp=${encodeURIComponent(chatId)}`;

    await ctx.reply(
      "🎫 Your Bingo card is ready!\n\n" +
      "Press the button below to open your card.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎮 Play Bingo",
                url: miniAppUrl
              }
            ]
          ]
        }
      }
    );

  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not open the Bingo card.");
  }
});

/* =========================
   /bingo
========================= */

bot.command("bingo", async ctx => {
  try {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    const gameResult = await pool.query(
      `SELECT * FROM games WHERE chat_id = $1`,
      [chatId]
    );

    if (gameResult.rows.length === 0) {
      return ctx.reply("❌ No active game.");
    }

    const game = gameResult.rows[0];

    if (game.winner) {
      return ctx.reply(
        `🏆 The game is already won by ${game.winner}.`
      );
    }

    const playerResult = await pool.query(
      `
      SELECT *
      FROM players
      WHERE chat_id = $1 AND user_id = $2
      `,
      [chatId, userId]
    );

    if (playerResult.rows.length === 0) {
      return ctx.reply(
        "❌ You are not in this game."
      );
    }

    const player = playerResult.rows[0];

    const valid = checkBingo(
      player.card,
      player.marked_numbers || []
    );

    if (!valid) {
      return ctx.reply(
        "❌ No Bingo yet. Complete a row, column, or diagonal."
      );
    }

    await pool.query(
      `
      UPDATE games
      SET winner = $1
      WHERE chat_id = $2
      `,
      [player.name, chatId]
    );

    await ctx.reply(
      `🎉 BINGO!\n\n🏆 ${player.name} wins the game!`
    );

  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not check Bingo.");
  }
});

/* =========================
   /endgame
========================= */

bot.command("endgame", async ctx => {
  try {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    const result = await pool.query(
      `SELECT * FROM games WHERE chat_id = $1`,
      [chatId]
    );

    if (result.rows.length === 0) {
      return ctx.reply("❌ No active game.");
    }

    const game = result.rows[0];

    if (String(game.host_id) !== String(userId)) {
      return ctx.reply(
        "❌ Only the game host can end the game."
      );
    }

    await pool.query(
      `DELETE FROM games WHERE chat_id = $1`,
      [chatId]
    );

    await ctx.reply("🛑 Bingo game ended.");

  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not end the game.");
  }
});

/* =========================
   API HELPERS
========================= */

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

/* =========================
   /api/card
========================= */

async function getCard(req, res) {
  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    const chatId = url.searchParams.get("chatId");
    const userId = url.searchParams.get("userId");

    if (!chatId || !userId) {
      return sendJson(res, 400, {
        error: "Missing chatId or userId"
      });
    }

    const gameResult = await pool.query(
      `SELECT * FROM games WHERE chat_id = $1`,
      [chatId]
    );

    if (gameResult.rows.length === 0) {
      return sendJson(res, 404, {
        error: "Game not found"
      });
    }

    const playerResult = await pool.query(
      `
      SELECT *
      FROM players
      WHERE chat_id = $1 AND user_id = $2
      `,
      [chatId, userId]
    );

    if (playerResult.rows.length === 0) {
      return sendJson(res, 404, {
        error: "Player not found"
      });
    }

    const game = gameResult.rows[0];
    const player = playerResult.rows[0];

    const countResult = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM players
      WHERE chat_id = $1
      `,
      [chatId]
    );

    return sendJson(res, 200, {
      name: player.name,
      hostName: game.host_name,
      playerCount: countResult.rows[0].count,
      card: player.card,
      markedNumbers: player.marked_numbers || [],
      calledNumbers: game.called_numbers || [],
      winner: game.winner
    });

  } catch (error) {
    console.error(error);

    return sendJson(res, 500, {
      error: "Server error"
    });
  }
}

/* =========================
   MARK / UNMARK
========================= */

async function markNumber(req, res, shouldMark) {
  try {
    const body = await readBody(req);

    const chatId = body.chatId;
    const userId = body.userId;
    const number = Number(body.number);

    if (
      !chatId ||
      !userId ||
      !Number.isInteger(number) ||
      number < 1 ||
      number > 75
    ) {
      return sendJson(res, 400, {
        error: "Invalid data"
      });
    }

    const playerResult = await pool.query(
      `
      SELECT *
      FROM players
      WHERE chat_id = $1 AND user_id = $2
      `,
      [chatId, userId]
    );

    if (playerResult.rows.length === 0) {
      return sendJson(res, 404, {
        error: "Player not found"
      });
    }

    const player = playerResult.rows[0];

    if (!cardContainsNumber(player.card, number)) {
      return sendJson(res, 400, {
        error: "Number is not on your card"
      });
    }

    const gameResult = await pool.query(
      `SELECT * FROM games WHERE chat_id = $1`,
      [chatId]
    );

    if (gameResult.rows.length === 0) {
      return sendJson(res, 404, {
        error: "Game not found"
      });
    }

    const game = gameResult.rows[0];

    if (!(game.called_numbers || []).includes(number)) {
      return sendJson(res, 400, {
        error: "Number has not been called"
      });
    }

    let markedNumbers =
      player.marked_numbers || [];

    if (shouldMark) {
      if (!markedNumbers.includes(number)) {
        markedNumbers.push(number);
      }
    } else {
      markedNumbers =
        markedNumbers.filter(n => n !== number);
    }

    await pool.query(
      `
      UPDATE players
      SET marked_numbers = $1
      WHERE chat_id = $2 AND user_id = $3
      `,
      [
        JSON.stringify(markedNumbers),
        chatId,
        userId
      ]
    );

    return sendJson(res, 200, {
      success: true,
      markedNumbers
    });

  } catch (error) {
    console.error(error);

    return sendJson(res, 500, {
      error: "Server error"
    });
  }
}

/* =========================
   /api/bingo
========================= */

async function bingoApi(req, res) {
  try {
    const body = await readBody(req);

    const chatId = body.chatId;
    const userId = body.userId;

    if (!chatId || !userId) {
      return sendJson(res, 400, {
        error: "Missing chatId or userId"
      });
    }

    const gameResult = await pool.query(
      `SELECT * FROM games WHERE chat_id = $1`,
      [chatId]
    );

    if (gameResult.rows.length === 0) {
      return sendJson(res, 404, {
        error: "Game not found"
      });
    }

    const game = gameResult.rows[0];

    if (game.winner) {
      return sendJson(res, 200, {
        bingo: true,
        winner: game.winner
      });
    }

    const playerResult = await pool.query(
      `
      SELECT *
      FROM players
      WHERE chat_id = $1 AND user_id = $2
      `,
      [chatId, userId]
    );

    if (playerResult.rows.length === 0) {
      return sendJson(res, 404, {
        error: "Player not found"
      });
    }

    const player = playerResult.rows[0];

    const valid = checkBingo(
      player.card,
      player.marked_numbers || []
    );

    if (!valid) {
      return sendJson(res, 200, {
        bingo: false
      });
    }

    await pool.query(
      `
      UPDATE games
      SET winner = $1
      WHERE chat_id = $2
      `,
      [player.name, chatId]
    );

    await bot.telegram.sendMessage(
      chatId,
      `🎉 BINGO!\n\n🏆 ${player.name} wins the game!`
    );

    return sendJson(res, 200, {
      bingo: true,
      winner: player.name
    });

  } catch (error) {
    console.error(error);

    return sendJson(res, 500, {
      error: "Server error"
    });
  }
}

/* =========================
   MINI APP
========================= */

function serveMiniApp(res) {
  const filePath = path.join(
    __dirname,
    "miniapp",
    "index.html"
  );

  fs.readFile(filePath, "utf8", (error, data) => {
    if (error) {
      console.error(error);

      res.writeHead(500, {
        "Content-Type": "text/plain"
      });

      return res.end(
        "Mini App file could not be loaded."
      );
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8"
    });

    res.end(data);
  });
}

/* =========================
   HTTP SERVER
========================= */

const server = http.createServer(async (req, res) => {
  try {

    // Telegram webhook
    if (
      req.method === "POST" &&
      req.url === "/telegram-webhook"
    ) {
      const update = await readBody(req);

      await bot.handleUpdate(update);

      res.writeHead(200);
      return res.end("OK");
    }

    const url = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    // Mini App
    if (
      req.method === "GET" &&
      (
        url.pathname === "/" ||
        url.pathname === "/miniapp"
      )
    ) {
      return serveMiniApp(res);
    }

    // Card API
    if (
      req.method === "GET" &&
      url.pathname === "/api/card"
    ) {
      return getCard(req, res);
    }

    // Mark
    if (
      req.method === "POST" &&
      url.pathname === "/api/mark"
    ) {
      return markNumber(req, res, true);
    }

    // Unmark
    if (
      req.method === "POST" &&
      url.pathname === "/api/unmark"
    ) {
      return markNumber(req, res, false);
    }

    // Bingo
    if (
      req.method === "POST" &&
      url.pathname === "/api/bingo"
    ) {
      return bingoApi(req, res);
    }

    res.writeHead(404, {
      "Content-Type": "text/plain"
    });

    res.end("Not found");

  } catch (error) {
    console.error(error);

    res.writeHead(500, {
      "Content-Type": "text/plain"
    });

    res.end("Server error");
  }
});

/* =========================
   START
========================= */

server.listen(PORT, async () => {
  console.log(
    `HTTP server running on port ${PORT}`
  );

  try {
    await initDatabase();

    // Remove any old webhook.
    await bot.telegram.deleteWebhook();

    // Set the new webhook.
    await bot.telegram.setWebhook(WEBHOOK_URL);

    console.log(
      "Telegram webhook configured successfully"
    );

    console.log(
      `Webhook URL: ${WEBHOOK_URL}`
    );

  } catch (error) {
    console.error(
      "Startup error:",
      error
    );
  }
});

/* =========================
   SHUTDOWN
========================= */

process.once("SIGINT", async () => {
  try {
    await bot.telegram.deleteWebhook();
  } catch (e) {}

  process.exit(0);
});

process.once("SIGTERM", async () => {
  try {
    await bot.telegram.deleteWebhook();
  } catch (e) {}

  process.exit(0);
});
