const { Telegraf } = require("telegraf");
const { Pool } = require("pg");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing");
}

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is missing");
}

const bot = new Telegraf(BOT_TOKEN);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const MINIAPP_URL =
  "https://telegram-bingo-bot-q54q.onrender.com/miniapp";

/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bingo_cards (
      card_number INTEGER PRIMARY KEY,
      card JSONB NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      user_id BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      card_number INTEGER REFERENCES bingo_cards(card_number),
      marked_numbers JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_state (
      id INTEGER PRIMARY KEY,
      called_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
      winner_user_id BIGINT,
      winner_name TEXT,
      status TEXT NOT NULL DEFAULT 'waiting'
    )
  `);

  await pool.query(`
    INSERT INTO game_state (id, called_numbers, status)
    VALUES (1, '[]'::jsonb, 'waiting')
    ON CONFLICT (id) DO NOTHING
  `);

  await generatePermanentCards();

  console.log("Database initialized");
}

/* =========================================================
   BINGO CARD GENERATION
========================================================= */

function shuffle(array) {
  const arr = [...array];

  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}

function generateCard() {
  const B = shuffle(
    Array.from({ length: 15 }, (_, i) => i + 1)
  ).slice(0, 5);

  const I = shuffle(
    Array.from({ length: 15 }, (_, i) => i + 16)
  ).slice(0, 5);

  const N = shuffle(
    Array.from({ length: 15 }, (_, i) => i + 31)
  ).slice(0, 5);

  const G = shuffle(
    Array.from({ length: 15 }, (_, i) => i + 46)
  ).slice(0, 5);

  const O = shuffle(
    Array.from({ length: 15 }, (_, i) => i + 61)
  ).slice(0, 5);

  const card = [];

  for (let row = 0; row < 5; row++) {
    card.push([
      B[row],
      I[row],
      row === 2 ? "FREE" : N[row],
      G[row],
      O[row]
    ]);
  }

  return card;
}

function cardKey(card) {
  return JSON.stringify(card);
}

async function generatePermanentCards() {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM bingo_cards`
  );

  const existingCount = result.rows[0].count;

  if (existingCount >= 100) {
    console.log("100 permanent Bingo cards already exist");
    return;
  }

  const existing = await pool.query(
    `SELECT card FROM bingo_cards`
  );

  const used = new Set(
    existing.rows.map(row => cardKey(row.card))
  );

  let created = 0;

  for (let cardNumber = 1; cardNumber <= 100; cardNumber++) {
    const alreadyExists = await pool.query(
      `SELECT 1 FROM bingo_cards WHERE card_number = $1`,
      [cardNumber]
    );

    if (alreadyExists.rowCount > 0) {
      continue;
    }

    let card;

    do {
      card = generateCard();
    } while (used.has(cardKey(card)));

    used.add(cardKey(card));

    await pool.query(
      `
      INSERT INTO bingo_cards (card_number, card)
      VALUES ($1, $2)
      `,
      [cardNumber, JSON.stringify(card)]
    );

    created++;
  }

  console.log(`Created ${created} new permanent Bingo cards`);
}

/* =========================================================
   TELEGRAM INIT DATA AUTHENTICATION
========================================================= */

function validateTelegramInitData(initData) {
  if (!initData) {
    throw new Error("Missing Telegram initData");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) {
    throw new Error("Missing Telegram hash");
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (
    calculatedHash.length !== hash.length ||
    !crypto.timingSafeEqual(
      Buffer.from(calculatedHash),
      Buffer.from(hash)
    )
  ) {
    throw new Error("Invalid Telegram initData");
  }

  const authDate = Number(params.get("auth_date"));

  if (!authDate) {
    throw new Error("Missing auth_date");
  }

  const maxAge = 24 * 60 * 60;

  if (Math.floor(Date.now() / 1000) - authDate > maxAge) {
    throw new Error("Telegram initData expired");
  }

  const userString = params.get("user");

  if (!userString) {
    throw new Error("Telegram user missing");
  }

  return JSON.parse(userString);
}

/* =========================================================
   HTTP HELPERS
========================================================= */

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
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
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function getInitData(req, body = {}) {
  const authHeader = req.headers.authorization || "";

  if (authHeader.startsWith("tma ")) {
    return authHeader.substring(4);
  }

  if (body.initData) {
    return body.initData;
  }

  return null;
}

/* =========================================================
   AUTHENTICATED PLAYER
========================================================= */

function authenticatePlayer(req, body = {}) {
  const initData = getInitData(req, body);

  if (!initData) {
    throw new Error("Telegram authentication required");
  }

  return validateTelegramInitData(initData);
}

/* =========================================================
   BINGO CHECK
========================================================= */

function hasBingo(card, markedNumbers) {
  const marked = new Set(markedNumbers);

  // Center is automatically free
  marked.add("FREE");

  // Rows
  for (let row = 0; row < 5; row++) {
    let complete = true;

    for (let col = 0; col < 5; col++) {
      if (!marked.has(card[row][col])) {
        complete = false;
        break;
      }
    }

    if (complete) return true;
  }

  // Columns
  for (let col = 0; col < 5; col++) {
    let complete = true;

    for (let row = 0; row < 5; row++) {
      if (!marked.has(card[row][col])) {
        complete = false;
        break;
      }
    }

    if (complete) return true;
  }

  // Diagonal
  let diagonal1 = true;

  for (let i = 0; i < 5; i++) {
    if (!marked.has(card[i][i])) {
      diagonal1 = false;
      break;
    }
  }

  if (diagonal1) return true;

  // Other diagonal
  let diagonal2 = true;

  for (let i = 0; i < 5; i++) {
    if (!marked.has(card[i][4 - i])) {
      diagonal2 = false;
      break;
    }
  }

  return diagonal2;
}

/* =========================================================
   TELEGRAM BOT COMMANDS
========================================================= */

bot.start(async ctx => {
  const user = ctx.from;

  await pool.query(
    `
    INSERT INTO players (user_id, name)
    VALUES ($1, $2)
    ON CONFLICT (user_id)
    DO UPDATE SET name = EXCLUDED.name
    `,
    [user.id, user.first_name || "Player"]
  );

  await ctx.reply(
    `🎉 Welcome to Telegram Bingo, ${user.first_name || "Player"}!\n\nChoose an option below:`,
    {
      reply_markup: {
        keyboard: [
          [{ text: "▶️ Start" }],
          [{ text: "🎮 Play" }],
          [{ text: "💰 Deposit" }],
          [{ text: "💵 Balance" }],
          [{ text: "🏧 Withdraw" }],
          [{ text: "❓ HIW / How to Play" }],
          [{ text: "📨 Invite" }],
          [{ text: "🆘 Support" }]
        ],
        resize_keyboard: true
      }
    }
  );
});

bot.command("play", async ctx => {
  await ctx.reply("🎮 Choose your Bingo card:", {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🎯 Choose Card 1–100",
            web_app: {
              url: MINIAPP_URL
            }
          }
        ]
      ]
    }
  });
});

bot.hears("▶️ Start", async ctx => {
  await ctx.reply("🎯 Press Play to choose your Bingo card.");
});

bot.hears("🎮 Play", async ctx => {
  await ctx.reply("🎮 Choose your Bingo card:", {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🎯 Choose Card 1–100",
            web_app: {
              url: MINIAPP_URL
            }
          }
        ]
      ]
    }
  });
});

bot.hears("❓ HIW / How to Play", async ctx => {
  await ctx.reply(
    `🎯 HOW TO PLAY BINGO

1️⃣ Press Play.
2️⃣ Choose a card number from 1–100.
3️⃣ Preview your 5×5 Bingo card.
4️⃣ Press OK to confirm your card.
5️⃣ Play the Bingo round.
6️⃣ Mark your called numbers.
7️⃣ Complete a row, column, or diagonal.
8️⃣ Press BINGO.

⭐ Every card number always has the same card layout.`
  );
});

bot.hears("📨 Invite", async ctx => {
  await ctx.reply(
    "📨 Invite your friends to play Telegram Bingo!"
  );
});

bot.hears("🆘 Support", async ctx => {
  await ctx.reply(
    "🆘 Support\n\nPlease contact the game administrator for help."
  );
});

/* =========================================================
   HTTP SERVER
========================================================= */

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, {});
    return;
  }

  try {
    /* ---------------------------------------------
       MINI APP
    --------------------------------------------- */

    if (
      req.method === "GET" &&
      (req.url === "/" || req.url === "/miniapp")
    ) {
      const filePath = path.join(
        __dirname,
        "Miniapp",
        "index.html"
      );

      if (!fs.existsSync(filePath)) {
        res.writeHead(404, {
          "Content-Type": "text/plain"
        });

        res.end("Mini App not found");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });

      fs.createReadStream(filePath).pipe(res);
      return;
    }

    /* ---------------------------------------------
       GET ALL CARDS
    --------------------------------------------- */

    if (
      req.method === "GET" &&
      req.url === "/api/cards"
    ) {
      const result = await pool.query(`
        SELECT card_number, card
        FROM bingo_cards
        ORDER BY card_number
      `);

      sendJson(res, 200, {
        cards: result.rows
      });

      return;
    }

    /* ---------------------------------------------
       GET MY CARD
    --------------------------------------------- */

    if (
      req.method === "GET" &&
      req.url.startsWith("/api/my-card")
    ) {
      const url = new URL(req.url, `http://${req.headers.host}`);

      const initData =
        req.headers.authorization?.startsWith("tma ")
          ? req.headers.authorization.substring(4)
          : url.searchParams.get("initData");

      const user = validateTelegramInitData(initData);

      const result = await pool.query(
        `
        SELECT
          p.user_id,
          p.name,
          p.card_number,
          p.marked_numbers,
          c.card
        FROM players p
        LEFT JOIN bingo_cards c
          ON p.card_number = c.card_number
        WHERE p.user_id = $1
        `,
        [user.id]
      );

      if (result.rowCount === 0) {
        sendJson(res, 404, {
          error: "Player not found"
        });

        return;
      }

      const game = await pool.query(`
        SELECT
          called_numbers,
          winner_user_id,
          winner_name,
          status
        FROM game_state
        WHERE id = 1
      `);

      sendJson(res, 200, {
        playerName: result.rows[0].name,
        cardNumber: result.rows[0].card_number,
        card: result.rows[0].card,
        markedNumbers: result.rows[0].marked_numbers || [],
        calledNumbers: game.rows[0].called_numbers || [],
        winnerUserId: game.rows[0].winner_user_id,
        winnerName: game.rows[0].winner_name,
        status: game.rows[0].status
      });

      return;
    }

    /* ---------------------------------------------
       SELECT CARD
    --------------------------------------------- */

    if (
      req.method === "POST" &&
      req.url === "/api/select-card"
    ) {
      const body = await readBody(req);
      const user = authenticatePlayer(req, body);

      const cardNumber = Number(body.cardNumber);

      if (
        !Number.isInteger(cardNumber) ||
        cardNumber < 1 ||
        cardNumber > 100
      ) {
        sendJson(res, 400, {
          error: "Card number must be between 1 and 100"
        });

        return;
      }

      const card = await pool.query(
        `
        SELECT card_number, card
        FROM bingo_cards
        WHERE card_number = $1
        `,
        [cardNumber]
      );

      if (card.rowCount === 0) {
        sendJson(res, 404, {
          error: "Card not found"
        });

        return;
      }

      await pool.query(
        `
        INSERT INTO players
          (user_id, name, card_number, marked_numbers)
        VALUES
          ($1, $2, $3, '[]'::jsonb)
        ON CONFLICT (user_id)
        DO UPDATE SET
          name = EXCLUDED.name,
          card_number = EXCLUDED.card_number,
          marked_numbers = '[]'::jsonb
        `,
        [
          user.id,
          user.first_name || "Player",
          cardNumber
        ]
      );

      sendJson(res, 200, {
        success: true,
        cardNumber,
        card: card.rows[0].card
      });

      return;
    }

    /* ---------------------------------------------
       MARK NUMBER
    --------------------------------------------- */

    if (
      req.method === "POST" &&
      req.url === "/api/mark"
    ) {
      const body = await readBody(req);
      const user = authenticatePlayer(req, body);

      const number = Number(body.number);

      if (!Number.isInteger(number)) {
        sendJson(res, 400, {
          error: "Invalid number"
        });

        return;
      }

      const gameResult = await pool.query(`
        SELECT called_numbers
        FROM game_state
        WHERE id = 1
      `);

      const calledNumbers =
        gameResult.rows[0].called_numbers || [];

      if (!calledNumbers.includes(number)) {
        sendJson(res, 400, {
          error: "That number has not been called"
        });

        return;
      }

      const playerResult = await pool.query(
        `
        SELECT marked_numbers
        FROM players
        WHERE user_id = $1
        `,
        [user.id]
      );

      if (playerResult.rowCount === 0) {
        sendJson(res, 404, {
          error: "Player not found"
        });

        return;
      }

      const marked =
        playerResult.rows[0].marked_numbers || [];

      if (!marked.includes(number)) {
        marked.push(number);
      }

      await pool.query(
        `
        UPDATE players
        SET marked_numbers = $1
        WHERE user_id = $2
        `,
        [JSON.stringify(marked), user.id]
      );

      sendJson(res, 200, {
        success: true,
        markedNumbers: marked
      });

      return;
    }

    /* ---------------------------------------------
       UNMARK NUMBER
    --------------------------------------------- */

    if (
      req.method === "POST" &&
      req.url === "/api/unmark"
    ) {
      const body = await readBody(req);
      const user = authenticatePlayer(req, body);

      const number = Number(body.number);

      const playerResult = await pool.query(
        `
        SELECT marked_numbers
        FROM players
        WHERE user_id = $1
        `,
        [user.id]
      );

      if (playerResult.rowCount === 0) {
        sendJson(res, 404, {
          error: "Player not found"
        });

        return;
      }

      let marked =
        playerResult.rows[0].marked_numbers || [];

      marked = marked.filter(n => n !== number);

      await pool.query(
        `
        UPDATE players
        SET marked_numbers = $1
        WHERE user_id = $2
        `,
        [JSON.stringify(marked), user.id]
      );

      sendJson(res, 200, {
        success: true,
        markedNumbers: marked
      });

      return;
    }

    /* ---------------------------------------------
       BINGO
    --------------------------------------------- */

    if (
      req.method === "POST" &&
      req.url === "/api/bingo"
    ) {
      const body = await readBody(req);
      const user = authenticatePlayer(req, body);

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const gameResult = await client.query(`
          SELECT
            called_numbers,
            winner_user_id,
            winner_name,
            status
          FROM game_state
          WHERE id = 1
          FOR UPDATE
        `);

        const game = gameResult.rows[0];

        if (game.winner_user_id) {
          await client.query("ROLLBACK");

          sendJson(res, 200, {
            bingo: false,
            message: `Winner already declared: ${game.winner_name}`
          });

          return;
        }

        const playerResult = await client.query(
          `
          SELECT
            p.name,
            p.marked_numbers,
            c.card
          FROM players p
          JOIN bingo_cards c
            ON p.card_number = c.card_number
          WHERE p.user_id = $1
          `,
          [user.id]
        );

        if (playerResult.rowCount === 0) {
          await client.query("ROLLBACK");

          sendJson(res, 404, {
            error: "Player/card not found"
          });

          return;
        }

        const player = playerResult.rows[0];

        const bingo = hasBingo(
          player.card,
          player.marked_numbers || []
        );

        if (!bingo) {
          await client.query("ROLLBACK");

          sendJson(res, 200, {
            bingo: false,
            message: "You do not have Bingo yet."
          });

          return;
        }

        await client.query(
          `
          UPDATE game_state
          SET
            winner_user_id = $1,
            winner_name = $2,
            status = 'finished'
          WHERE id = 1
          `,
          [user.id, player.name]
        );

        await client.query("COMMIT");

        sendJson(res, 200, {
          bingo: true,
          winner: player.name
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      return;
    }

    sendJson(res, 404, {
      error: "Not found"
    });
  } catch (error) {
    console.error(error);

    sendJson(res, 500, {
      error: error.message || "Server error"
    });
  }
});

/* =========================================================
   START
========================================================= */

async function start() {
  try {
    await initDatabase();

    await bot.telegram.deleteWebhook({
      drop_pending_updates: true
    });

    const webhookUrl =
      `https://telegram-bingo-bot-q54q.onrender.com/telegram-webhook`;

    await bot.telegram.setWebhook(webhookUrl);

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    bot.startWebhook(
      "/telegram-webhook",
      null,
      PORT
    );

    console.log("Telegram Bingo bot started");
  } catch (error) {
    console.error("Startup error:", error);
    process.exit(1);
  }
}

start();
