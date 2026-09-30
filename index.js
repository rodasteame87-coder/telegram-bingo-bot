const { Telegraf } = require("telegraf");
const { Pool } = require("pg");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT || 10000);

const RENDER_URL =
  "https://telegram-bingo-bot-q54q.onrender.com";

const MINIAPP_URL =
  `${RENDER_URL}/miniapp`;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN environment variable is missing");
}

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is missing");
}

const bot = new Telegraf(BOT_TOKEN);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

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
    INSERT INTO game_state
      (id, called_numbers, status)
    VALUES
      (1, '[]'::jsonb, 'waiting')
    ON CONFLICT (id) DO NOTHING
  `);

  await generatePermanentCards();

  console.log("Database ready");
}

/* =========================================================
   RANDOM / BINGO CARD
========================================================= */

function shuffle(array) {
  const result = [...array];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] =
      [result[j], result[i]];
  }

  return result;
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

  return [
    [B[0], I[0], N[0], G[0], O[0]],
    [B[1], I[1], N[1], G[1], O[1]],
    [B[2], I[2], "FREE", G[2], O[2]],
    [B[3], I[3], N[3], G[3], O[3]],
    [B[4], I[4], N[4], G[4], O[4]]
  ];
}

function cardKey(card) {
  return JSON.stringify(card);
}

async function generatePermanentCards() {
  const result = await pool.query(`
    SELECT card_number, card
    FROM bingo_cards
    ORDER BY card_number
  `);

  const existingNumbers = new Set(
    result.rows.map(row => Number(row.card_number))
  );

  const usedCards = new Set(
    result.rows.map(row => cardKey(row.card))
  );

  let created = 0;

  for (let number = 1; number <= 100; number++) {
    if (existingNumbers.has(number)) {
      continue;
    }

    let card;

    do {
      card = generateCard();
    } while (usedCards.has(cardKey(card)));

    usedCards.add(cardKey(card));

    await pool.query(
      `
      INSERT INTO bingo_cards
        (card_number, card)
      VALUES
        ($1, $2)
      `,
      [number, JSON.stringify(card)]
    );

    created++;
  }

  console.log(
    `Permanent cards ready. Created ${created} new cards.`
  );
}

/* =========================================================
   TELEGRAM WEB APP AUTHENTICATION
========================================================= */

function validateTelegramInitData(initData) {
  if (!initData) {
    throw new Error("Telegram initData is missing");
  }

  const params = new URLSearchParams(initData);

  const hash = params.get("hash");

  if (!hash) {
    throw new Error("Telegram hash is missing");
  }

  params.delete("hash");

  const dataCheckString =
    [...params.entries()]
      .sort(([a], [b]) =>
        a.localeCompare(b)
      )
      .map(([key, value]) =>
        `${key}=${value}`
      )
      .join("\n");

  const secretKey =
    crypto
      .createHmac(
        "sha256",
        "WebAppData"
      )
      .update(BOT_TOKEN)
      .digest();

  const calculatedHash =
    crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(dataCheckString)
      .digest("hex");

  if (
    calculatedHash.length !== hash.length
  ) {
    throw new Error(
      "Invalid Telegram authentication"
    );
  }

  if (
    !crypto.timingSafeEqual(
      Buffer.from(calculatedHash),
      Buffer.from(hash)
    )
  ) {
    throw new Error(
      "Invalid Telegram authentication"
    );
  }

  const userData =
    params.get("user");

  if (!userData) {
    throw new Error(
      "Telegram user information is missing"
    );
  }

  return JSON.parse(userData);
}

function getInitDataFromRequest(req, body = {}) {
  const authorization =
    req.headers.authorization || "";

  if (
    authorization.startsWith("tma ")
  ) {
    return authorization.substring(4);
  }

  if (body.initData) {
    return body.initData;
  }

  return null;
}

function authenticateRequest(req, body = {}) {
  const initData =
    getInitDataFromRequest(
      req,
      body
    );

  return validateTelegramInitData(
    initData
  );
}

/* =========================================================
   BINGO CHECK
========================================================= */

function hasBingo(card, markedNumbers) {
  const marked =
    new Set(markedNumbers || []);

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

    if (complete) {
      return true;
    }
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

    if (complete) {
      return true;
    }
  }

  // Diagonal 1
  let diagonal1 = true;

  for (let i = 0; i < 5; i++) {
    if (!marked.has(card[i][i])) {
      diagonal1 = false;
      break;
    }
  }

  if (diagonal1) {
    return true;
  }

  // Diagonal 2
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
   BOT KEYBOARD
========================================================= */

const mainKeyboard = {
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
};

/* =========================================================
   BOT COMMANDS
========================================================= */

bot.start(async ctx => {
  const user = ctx.from;

  await pool.query(
    `
    INSERT INTO players
      (user_id, name)
    VALUES
      ($1, $2)
    ON CONFLICT (user_id)
    DO UPDATE SET
      name = EXCLUDED.name
    `,
    [
      user.id,
      user.first_name || "Player"
    ]
  );

  await ctx.reply(
    `🎉 Welcome to Telegram Bingo, ${
      user.first_name || "Player"
    }!\n\nChoose an option:`,
    {
      reply_markup: mainKeyboard
    }
  );
});

bot.command("play", async ctx => {
  await sendPlayButton(ctx);
});

bot.hears("▶️ Start", async ctx => {
  await ctx.reply(
    "🎯 Welcome!\n\nPress 🎮 Play to choose your Bingo card.",
    {
      reply_markup: mainKeyboard
    }
  );
});

bot.hears("🎮 Play", async ctx => {
  await sendPlayButton(ctx);
});

async function sendPlayButton(ctx) {
  await ctx.reply(
    "🎮 Choose your Bingo card:",
    {
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
    }
  );
}

bot.hears("❓ HIW / How to Play", async ctx => {
  await ctx.reply(
    `🎯 HOW TO PLAY

1️⃣ Press Play.
2️⃣ Choose a card from 1–100.
3️⃣ Preview the 5×5 card.
4️⃣ Press OK.
5️⃣ Play Bingo.
6️⃣ Mark called numbers.
7️⃣ Complete a row, column, or diagonal.
8️⃣ Press BINGO.`
  );
});

bot.hears("📨 Invite", async ctx => {
  await ctx.reply(
    "📨 Invite your friends to Telegram Bingo!"
  );
});

bot.hears("🆘 Support", async ctx => {
  await ctx.reply(
    "🆘 Support\n\nPlease contact the administrator."
  );
});

/* =========================================================
   PLACEHOLDER MONEY BUTTONS
========================================================= */

bot.hears("💰 Deposit", async ctx => {
  await ctx.reply(
    "💰 Deposit\n\nThis section will be connected later."
  );
});

bot.hears("💵 Balance", async ctx => {
  await ctx.reply(
    "💵 Balance\n\nYour balance system will be connected later."
  );
});

bot.hears("🏧 Withdraw", async ctx => {
  await ctx.reply(
    "🏧 Withdraw\n\nThis section will be connected later."
  );
});

/* =========================================================
   HTTP HELPERS
========================================================= */

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",
    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS"
  });

  res.end(
    JSON.stringify(data)
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(
          new Error("Invalid JSON")
        );
      }
    });

    req.on("error", reject);
  });
}

/* =========================================================
   HTTP SERVER
========================================================= */

const server = http.createServer(
  async (req, res) => {
    try {

      /* -----------------------------------------
         CORS
      ----------------------------------------- */

      if (req.method === "OPTIONS") {
        sendJson(res, 200, {});
        return;
      }

      /* -----------------------------------------
         TELEGRAM WEBHOOK
      ----------------------------------------- */

      if (
        req.method === "POST" &&
        req.url === "/telegram-webhook"
      ) {
        const update =
          await readBody(req);

        await bot.handleUpdate(
          update
        );

        sendJson(res, 200, {
          ok: true
        });

        return;
      }

      /* -----------------------------------------
         MINI APP
      ----------------------------------------- */

      if (
        req.method === "GET" &&
        (
          req.url === "/" ||
          req.url === "/miniapp"
        )
      ) {
        const filePath =
          path.join(
            __dirname,
            "Miniapp",
            "index.html"
          );

        if (!fs.existsSync(filePath)) {
          sendJson(res, 404, {
            error:
              "Miniapp/index.html not found"
          });

          return;
        }

        res.writeHead(200, {
          "Content-Type":
            "text/html; charset=utf-8"
        });

        fs.createReadStream(
          filePath
        ).pipe(res);

        return;
      }

      /* -----------------------------------------
         HEALTH CHECK
      ----------------------------------------- */

      if (
        req.method === "GET" &&
        req.url === "/health"
      ) {
        sendJson(res, 200, {
          status: "ok"
        });

        return;
      }

      /* -----------------------------------------
         GET 100 CARDS
      ----------------------------------------- */

      if (
        req.method === "GET" &&
        req.url === "/api/cards"
      ) {
        const result =
          await pool.query(`
            SELECT
              card_number,
              card
            FROM bingo_cards
            ORDER BY card_number
          `);

        sendJson(res, 200, {
          cards: result.rows
        });

        return;
      }

      /* -----------------------------------------
         GET MY CARD
      ----------------------------------------- */

      if (
        req.method === "GET" &&
        req.url.startsWith(
          "/api/my-card"
        )
      ) {
        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

        const initData =
          url.searchParams.get(
            "initData"
          );

        const user =
          validateTelegramInitData(
            initData
          );

        const playerResult =
          await pool.query(
            `
            SELECT
              p.user_id,
              p.name,
              p.card_number,
              p.marked_numbers,
              c.card
            FROM players p
            LEFT JOIN bingo_cards c
              ON p.card_number =
                 c.card_number
            WHERE p.user_id = $1
            `,
            [user.id]
          );

        if (
          playerResult.rowCount === 0
        ) {
          sendJson(res, 404, {
            error:
              "Player not found"
          });

          return;
        }

        const gameResult =
          await pool.query(`
            SELECT
              called_numbers,
              winner_user_id,
              winner_name,
              status
            FROM game_state
            WHERE id = 1
          `);

        const player =
          playerResult.rows[0];

        const game =
          gameResult.rows[0];

        sendJson(res, 200, {
          playerName: player.name,
          cardNumber: player.card_number,
          card: player.card,
          markedNumbers:
            player.marked_numbers || [],
          calledNumbers:
            game.called_numbers || [],
          winnerUserId:
            game.winner_user_id,
          winnerName:
            game.winner_name,
          status:
            game.status
        });

        return;
      }

      /* -----------------------------------------
         SELECT CARD
      ----------------------------------------- */

      if (
        req.method === "POST" &&
        req.url === "/api/select-card"
      ) {
        const body =
          await readBody(req);

        const user =
          authenticateRequest(
            req,
            body
          );

        const cardNumber =
          Number(body.cardNumber);

        if (
          !Number.isInteger(
            cardNumber
          ) ||
          cardNumber < 1 ||
          cardNumber > 100
        ) {
          sendJson(res, 400, {
            error:
              "Card number must be between 1 and 100"
          });

          return;
        }

        const cardResult =
          await pool.query(
            `
            SELECT
              card_number,
              card
            FROM bingo_cards
            WHERE card_number = $1
            `,
            [cardNumber]
          );

        if (
          cardResult.rowCount === 0
        ) {
          sendJson(res, 404, {
            error:
              "Card not found"
          });

          return;
        }

        await pool.query(
          `
          INSERT INTO players
            (
              user_id,
              name,
              card_number,
              marked_numbers
            )
          VALUES
            ($1, $2, $3, '[]'::jsonb)
          ON CONFLICT (user_id)
          DO UPDATE SET
            name = EXCLUDED.name,
            card_number =
              EXCLUDED.card_number,
            marked_numbers =
              '[]'::jsonb
          `,
          [
            user.id,
            user.first_name ||
              "Player",
            cardNumber
          ]
        );

        sendJson(res, 200, {
          success: true,
          cardNumber,
          card:
            cardResult.rows[0].card
        });

        return;
      }

      /* -----------------------------------------
         MARK
      ----------------------------------------- */

      if (
        req.method === "POST" &&
        req.url === "/api/mark"
      ) {
        const body =
          await readBody(req);

        const user =
          authenticateRequest(
            req,
            body
          );

        const number =
          Number(body.number);

        if (
          !Number.isInteger(number) ||
          number < 1 ||
          number > 75
        ) {
          sendJson(res, 400, {
            error:
              "Invalid Bingo number"
          });

          return;
        }

        const gameResult =
          await pool.query(`
            SELECT called_numbers
            FROM game_state
            WHERE id = 1
          `);

        const called =
          gameResult.rows[0]
            ?.called_numbers || [];

        if (!called.includes(number)) {
          sendJson(res, 400, {
            error:
              "That number has not been called yet"
          });

          return;
        }

        const playerResult =
          await pool.query(
            `
            SELECT marked_numbers
            FROM players
            WHERE user_id = $1
            `,
            [user.id]
          );

        if (
          playerResult.rowCount === 0
        ) {
          sendJson(res, 404, {
            error:
              "Choose a card first"
          });

          return;
        }

        const marked =
          playerResult.rows[0]
            .marked_numbers || [];

        if (!marked.includes(number)) {
          marked.push(number);
        }

        await pool.query(
          `
          UPDATE players
          SET marked_numbers = $1
          WHERE user_id = $2
          `,
          [
            JSON.stringify(marked),
            user.id
          ]
        );

        sendJson(res, 200, {
          success: true,
          markedNumbers: marked
        });

        return;
      }

      /* -----------------------------------------
         UNMARK
      ----------------------------------------- */

      if (
        req.method === "POST" &&
        req.url === "/api/unmark"
      ) {
        const body =
          await readBody(req);

        const user =
          authenticateRequest(
            req,
            body
          );

        const number =
          Number(body.number);

        const playerResult =
          await pool.query(
            `
            SELECT marked_numbers
            FROM players
            WHERE user_id = $1
            `,
            [user.id]
          );

        if (
          playerResult.rowCount === 0
        ) {
          sendJson(res, 404, {
            error:
              "Player not found"
          });

          return;
        }

        let marked =
          playerResult.rows[0]
            .marked_numbers || [];

        marked =
          marked.filter(
            n => n !== number
          );

        await pool.query(
          `
          UPDATE players
          SET marked_numbers = $1
          WHERE user_id = $2
          `,
          [
            JSON.stringify(marked),
            user.id
          ]
        );

        sendJson(res, 200, {
          success: true,
          markedNumbers: marked
        });

        return;
      }

      /* -----------------------------------------
         BINGO
      ----------------------------------------- */

      if (
        req.method === "POST" &&
        req.url === "/api/bingo"
      ) {
        const body =
          await readBody(req);

        const user =
          authenticateRequest(
            req,
            body
          );

        const client =
          await pool.connect();

        try {
          await client.query(
            "BEGIN"
          );

          const gameResult =
            await client.query(`
              SELECT
                called_numbers,
                winner_user_id,
                winner_name,
                status
              FROM game_state
              WHERE id = 1
              FOR UPDATE
            `);

          const game =
            gameResult.rows[0];

          if (game.winner_user_id) {
            await client.query(
              "ROLLBACK"
            );

            sendJson(res, 200, {
              bingo: false,
              message:
                `Winner already declared: ${game.winner_name}`
            });

            return;
          }

          const playerResult =
            await client.query(
              `
              SELECT
                p.name,
                p.marked_numbers,
                c.card
              FROM players p
              JOIN bingo_cards c
                ON p.card_number =
                   c.card_number
              WHERE p.user_id = $1
              `,
              [user.id]
            );

          if (
            playerResult.rowCount === 0
          ) {
            await client.query(
              "ROLLBACK"
            );

            sendJson(res, 404, {
              error:
                "Choose a card first"
            });

            return;
          }

          const player =
            playerResult.rows[0];

          const bingo =
            hasBingo(
              player.card,
              player.marked_numbers
            );

          if (!bingo) {
            await client.query(
              "ROLLBACK"
            );

            sendJson(res, 200, {
              bingo: false,
              message:
                "You do not have Bingo yet."
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
            [
              user.id,
              player.name
            ]
          );

          await client.query(
            "COMMIT"
          );

          sendJson(res, 200, {
            bingo: true,
            winner: player.name
          });

        } catch (error) {

          await client.query(
            "ROLLBACK"
          );

          throw error;

        } finally {

          client.release();
        }

        return;
      }

      /* -----------------------------------------
         404
      ----------------------------------------- */

      sendJson(res, 404, {
        error: "Not found"
      });

    } catch (error) {

      console.error(
        "Request error:",
        error
      );

      sendJson(res, 500, {
        error:
          error.message ||
          "Internal server error"
      });
    }
  }
);

/* =========================================================
   START SERVER
========================================================= */

async function start() {
  try {

    await initDatabase();

    const webhookUrl =
      `${RENDER_URL}/telegram-webhook`;

    await bot.telegram.setWebhook(
      webhookUrl,
      {
        drop_pending_updates: true
      }
    );

    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `Server listening on port ${PORT}`
        );

        console.log(
          `Webhook: ${webhookUrl}`
        );

        console.log(
          `Mini App: ${MINIAPP_URL}`
        );
      }
    );

  } catch (error) {

    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);
  }
}

start();

/* =========================================================
   SHUTDOWN
========================================================= */

process.once(
  "SIGINT",
  async () => {
    await bot.stop();
    await pool.end();
    server.close();
    process.exit(0);
  }
);

process.once(
  "SIGTERM",
  async () => {
    await bot.stop();
    await pool.end();
    server.close();
    process.exit(0);
  }
);
