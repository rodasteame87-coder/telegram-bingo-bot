const { Telegraf } = require("telegraf");
const { Pool } = require("pg");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 10000;

const RENDER_URL = "https://telegram-bingo-bot-q54q.onrender.com";
const MINIAPP_URL = `${RENDER_URL}/miniapp`;
const MINIAPP_FILE = path.join(__dirname, "miniapp", "index.html");

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

/* =========================
   BINGO CARD GENERATOR
========================= */

function randomNumbers(min, max, count) {
  const numbers = [];

  while (numbers.length < count) {
    const number =
      Math.floor(Math.random() * (max - min + 1)) + min;

    if (!numbers.includes(number)) {
      numbers.push(number);
    }
  }

  return numbers;
}

function generateCard() {
  const B = randomNumbers(1, 15, 5);
  const I = randomNumbers(16, 30, 5);
  const N = randomNumbers(31, 45, 5);
  const G = randomNumbers(46, 60, 5);
  const O = randomNumbers(61, 75, 5);

  N[2] = "FREE";

  return [
    B,
    I,
    N,
    G,
    O
  ];
}

/* =========================
   DATABASE INITIALIZATION
========================= */

async function initDatabase() {
  console.log("Initializing database...");

  /*
    IMPORTANT:
    We keep bingo_cards so permanent cards
    1-100 are not deleted.
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bingo_cards (
      card_number INTEGER PRIMARY KEY,
      board JSONB NOT NULL
    )
  `);

  /*
    The previous players table had duplicate/
    incompatible data.

    We remove ONLY players.
    bingo_cards is NOT removed.
  */

  await pool.query(`
    DROP TABLE IF EXISTS players CASCADE
  `);

  /*
    Create clean players table.
  */

  await pool.query(`
    CREATE TABLE players (
      user_id BIGINT PRIMARY KEY,
      name TEXT DEFAULT 'Player',
      card_number INTEGER,
      marked_numbers JSONB DEFAULT '[]'::jsonb
    )
  `);

  /*
    Prevent two players from selecting
    the same Bingo card.
  */

  await pool.query(`
    CREATE UNIQUE INDEX players_card_number_unique
    ON players(card_number)
    WHERE card_number IS NOT NULL
  `);

  /*
    Game state.
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_state (
      id INTEGER PRIMARY KEY,
      called_numbers JSONB DEFAULT '[]'::jsonb
    )
  `);

  await pool.query(`
    INSERT INTO game_state (id, called_numbers)
    VALUES (1, '[]'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);

  /*
    Create permanent Bingo cards.
    Existing cards are never changed.
  */

  await generatePermanentCards();

  console.log("Database ready.");
}

/* =========================
   PERMANENT BINGO CARDS
========================= */

async function generatePermanentCards() {
  const existing = await pool.query(`
    SELECT card_number, board
    FROM bingo_cards
  `);

  const existingNumbers = new Set(
    existing.rows.map(row => Number(row.card_number))
  );

  const existingBoards = new Set(
    existing.rows.map(row =>
      JSON.stringify(row.board)
    )
  );

  for (let cardNumber = 1; cardNumber <= 100; cardNumber++) {

    if (existingNumbers.has(cardNumber)) {
      continue;
    }

    let board;
    let boardString;

    do {
      board = generateCard();
      boardString = JSON.stringify(board);
    } while (existingBoards.has(boardString));

    await pool.query(
      `
      INSERT INTO bingo_cards
      (card_number, board)
      VALUES ($1, $2)
      `,
      [
        cardNumber,
        JSON.stringify(board)
      ]
    );

    existingNumbers.add(cardNumber);
    existingBoards.add(boardString);
  }

  console.log("Permanent Bingo cards 1-100 ready.");
}

/* =========================
   TELEGRAM MINI APP AUTH
========================= */

function validateTelegramInitData(initData) {

  if (!initData) {
    return null;
  }

  try {

    const params = new URLSearchParams(initData);

    const hash = params.get("hash");

    if (!hash) {
      return null;
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) =>
        a.localeCompare(b)
      )
      .map(([key, value]) =>
        `${key}=${value}`
      )
      .join("\n");

    const secretKey = crypto
      .createHmac(
        "sha256",
        "WebAppData"
      )
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(dataCheckString)
      .digest("hex");

    if (calculatedHash !== hash) {
      return null;
    }

    const userData = params.get("user");

    if (!userData) {
      return null;
    }

    return JSON.parse(userData);

  } catch (error) {

    console.error(
      "Telegram auth error:",
      error
    );

    return null;
  }
}

/* =========================
   PLAYER REGISTRATION
========================= */

async function registerPlayer(user) {

  if (!user || !user.id) {
    return;
  }

  const name =
    user.first_name ||
    user.username ||
    "Player";

  await pool.query(
    `
    INSERT INTO players
    (user_id, name)
    VALUES ($1, $2)
    ON CONFLICT (user_id)
    DO UPDATE SET name = EXCLUDED.name
    `,
    [
      user.id,
      name
    ]
  );
}

/* =========================
   MAIN MENU
========================= */

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

/* =========================
   START
========================= */

bot.start(async ctx => {

  try {

    await registerPlayer(ctx.from);

    await ctx.reply(
      `🎉 Welcome ${ctx.from.first_name || "Player"}!

🎮 Welcome to Bingo.

Choose an option below:`,
      {
        reply_markup: mainKeyboard
      }
    );

  } catch (error) {

    console.error(error);

    await ctx.reply(
      "Something went wrong. Please try again."
    );
  }
});

/* =========================
   START BUTTON
========================= */

bot.hears("▶️ Start", async ctx => {

  try {

    await registerPlayer(ctx.from);

    await ctx.reply(
      "🎮 Welcome back!\n\nChoose what you want to do:",
      {
        reply_markup: mainKeyboard
      }
    );

  } catch (error) {

    console.error(error);

    await ctx.reply(
      "Something went wrong."
    );
  }
});

/* =========================
   PLAY
========================= */

bot.hears("🎮 Play", async ctx => {

  try {

    await registerPlayer(ctx.from);

    await ctx.reply(
      "🎮 Choose your Bingo card:",
      {
        reply_markup: {

          inline_keyboard: [

            [

              {
                text: "🎯 OPEN BINGO",

                web_app: {
                  url: MINIAPP_URL
                }
              }

            ]

          ]

        }
      }
    );

  } catch (error) {

    console.error(error);

    await ctx.reply(
      "Unable to open Bingo."
    );
  }
});

/* =========================
   DEPOSIT
========================= */

bot.hears("💰 Deposit", async ctx => {

  await ctx.reply(
    `💰 DEPOSIT

Deposit functionality is currently being prepared.`
  );
});

/* =========================
   BALANCE
========================= */

bot.hears("💵 Balance", async ctx => {

  try {

    const result = await pool.query(
      `
      SELECT card_number
      FROM players
      WHERE user_id = $1
      `,
      [ctx.from.id]
    );

    if (result.rows.length === 0) {

      await ctx.reply(
        "Your account is not registered yet. Press Start."
      );

      return;
    }

    const card =
      result.rows[0].card_number;

    await ctx.reply(
      `💵 BALANCE

Card: ${card || "Not selected"}

Balance functionality is currently being prepared.`
    );

  } catch (error) {

    console.error(error);

    await ctx.reply(
      "Unable to check balance."
    );
  }
});

/* =========================
   WITHDRAW
========================= */

bot.hears("🏧 Withdraw", async ctx => {

  await ctx.reply(
    `🏧 WITHDRAW

Withdrawal functionality is currently being prepared.`
  );
});

/* =========================
   HOW TO PLAY
========================= */

bot.hears(
  "❓ HIW / How to Play",
  async ctx => {

    await ctx.reply(
      `❓ HOW TO PLAY

1️⃣ Press Play.
2️⃣ Open Bingo.
3️⃣ Choose a card number from 1–100.
4️⃣ Preview your Bingo card.
5️⃣ Press OK to confirm your card.
6️⃣ Play Bingo when the game starts.

🎯 Good luck!`
    );
  }
);

/* =========================
   INVITE
========================= */

bot.hears("📨 Invite", async ctx => {

  const username =
    ctx.botInfo?.username ||
    "your_bot";

  await ctx.reply(
    `📨 INVITE

Invite your friends to play Bingo!

https://t.me/${username}`
  );
});

/* =========================
   SUPPORT
========================= */

bot.hears("🆘 Support", async ctx => {

  await ctx.reply(
    `🆘 SUPPORT

For support, please contact the administrator.`
  );
});

/* =========================
   HTTP SERVER
========================= */

const server = http.createServer(
  async (req, res) => {

    try {

      /* =====================
         HEALTH
      ===================== */

      if (
        req.method === "GET" &&
        req.url === "/health"
      ) {

        res.writeHead(200, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify({
            status: "ok"
          })
        );

        return;
      }

      /* =====================
         MINI APP
      ===================== */

      if (
        req.method === "GET" &&
        (
          req.url === "/" ||
          req.url === "/miniapp"
        )
      ) {

        if (
          !fs.existsSync(
            MINIAPP_FILE
          )
        ) {

          res.writeHead(404, {
            "Content-Type":
              "application/json"
          });

          res.end(
            JSON.stringify({
              error:
                "miniapp/index.html not found"
            })
          );

          return;
        }

        const html =
          fs.readFileSync(
            MINIAPP_FILE,
            "utf8"
          );

        res.writeHead(200, {
          "Content-Type":
            "text/html; charset=utf-8"
        });

        res.end(html);

        return;
      }

      /* =====================
         TELEGRAM WEBHOOK
      ===================== */

      if (
        req.method === "POST" &&
        req.url ===
          "/telegram-webhook"
      ) {

        let body = "";

        req.on(
          "data",
          chunk => {
            body += chunk;
          }
        );

        req.on(
          "end",
          async () => {

            try {

              const update =
                JSON.parse(body);

              await bot.handleUpdate(
                update
              );

              res.writeHead(200);

              res.end("OK");

            } catch (error) {

              console.error(
                "Webhook error:",
                error
              );

              res.writeHead(500);

              res.end("ERROR");
            }

          }
        );

        return;
      }

      /* =====================
         ALL CARDS
      ===================== */

      if (
        req.method === "GET" &&
        req.url === "/api/cards"
      ) {

        const result =
          await pool.query(`
            SELECT
              card_number,
              board
            FROM bingo_cards
            ORDER BY card_number
          `);

        res.writeHead(200, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify(
            result.rows
          )
        );

        return;
      }

      /* =====================
         MY CARD
      ===================== */

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

        if (!user) {

          res.writeHead(401, {
            "Content-Type":
              "application/json"
          });

          res.end(
            JSON.stringify({
              error:
                "Invalid Telegram data"
            })
          );

          return;
        }

        const result =
          await pool.query(
            `
            SELECT
              p.card_number,
              c.board
            FROM players p
            LEFT JOIN bingo_cards c
              ON p.card_number =
                 c.card_number
            WHERE p.user_id = $1
            `,
            [user.id]
          );

        if (
          result.rows.length === 0
        ) {

          res.writeHead(404, {
            "Content-Type":
              "application/json"
          });

          res.end(
            JSON.stringify({
              error:
                "Player not found"
            })
          );

          return;
        }

        res.writeHead(200, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify(
            result.rows[0]
          )
        );

        return;
      }

      /* =====================
         SELECT CARD
      ===================== */

      if (
        req.method === "POST" &&
        req.url ===
          "/api/select-card"
      ) {

        let body = "";

        req.on(
          "data",
          chunk => {
            body += chunk;
          }
        );

        req.on(
          "end",
          async () => {

            try {

              const data =
                JSON.parse(body);

              const {
                initData,
                cardNumber
              } = data;

              const user =
                validateTelegramInitData(
                  initData
                );

              if (!user) {

                res.writeHead(401, {
                  "Content-Type":
                    "application/json"
                });

                res.end(
                  JSON.stringify({
                    error:
                      "Invalid Telegram data"
                  })
                );

                return;
              }

              const number =
                Number(cardNumber);

              if (
                !Number.isInteger(
                  number
                ) ||
                number < 1 ||
                number > 100
              ) {

                res.writeHead(400, {
                  "Content-Type":
                    "application/json"
                });

                res.end(
                  JSON.stringify({
                    error:
                      "Invalid card number"
                  })
                );

                return;
              }

              await registerPlayer(
                user
              );

              const cardResult =
                await pool.query(
                  `
                  SELECT
                    card_number,
                    board
                  FROM bingo_cards
                  WHERE card_number = $1
                  `,
                  [number]
                );

              if (
                cardResult.rows.length === 0
              ) {

                res.writeHead(404, {
                  "Content-Type":
                    "application/json"
                });

                res.end(
                  JSON.stringify({
                    error:
                      "Card not found"
                  })
                );

                return;
              }

              /*
                Select card.

                If another player already
                has this card, PostgreSQL
                returns error 23505.
              */

              try {

                await pool.query(
                  `
                  UPDATE players
                  SET
                    card_number = $1,
                    marked_numbers =
                      '[]'::jsonb
                  WHERE user_id = $2
                  `,
                  [
                    number,
                    user.id
                  ]
                );

              } catch (error) {

                if (
                  error.code === "23505"
                ) {

                  res.writeHead(409, {
                    "Content-Type":
                      "application/json"
                  });

                  res.end(
                    JSON.stringify({
                      error:
                        "This Bingo card is already selected by another player."
                    })
                  );

                  return;
                }

                throw error;
              }

              res.writeHead(200, {
                "Content-Type":
                  "application/json"
              });

              res.end(
                JSON.stringify({
                  success: true,
                  cardNumber: number,
                  board:
                    cardResult.rows[0]
                      .board
                })
              );

            } catch (error) {

              console.error(
                "Error selecting card:",
                error
              );

              res.writeHead(500, {
                "Content-Type":
                  "application/json"
              });

              res.end(
                JSON.stringify({
                  error:
                    error.message
                })
              );
            }

          }
        );

        return;
      }

      /* =====================
         MARK NUMBER
      ===================== */

      if (
        req.method === "POST" &&
        req.url === "/api/mark"
      ) {

        let body = "";

        req.on(
          "data",
          chunk => {
            body += chunk;
          }
        );

        req.on(
          "end",
          async () => {

            try {

              const data =
                JSON.parse(body);

              const user =
                validateTelegramInitData(
                  data.initData
                );

              if (!user) {

                res.writeHead(401);

                res.end(
                  JSON.stringify({
                    error:
                      "Invalid Telegram data"
                  })
                );

                return;
              }

              const number =
                Number(data.number);

              const player =
                await pool.query(
                  `
                  SELECT marked_numbers
                  FROM players
                  WHERE user_id = $1
                  `,
                  [user.id]
                );

              if (
                player.rows.length === 0
              ) {

                res.writeHead(404);

                res.end(
                  JSON.stringify({
                    error:
                      "Player not found"
                  })
                );

                return;
              }

              let marked =
                player.rows[0]
                  .marked_numbers || [];

              if (
                !marked.includes(number)
              ) {

                marked.push(number);
              }

              await pool.query(
                `
                UPDATE players
                SET marked_numbers = $1
                WHERE user_id = $2
                `,
                [
                  JSON.stringify(
                    marked
                  ),
                  user.id
                ]
              );

              res.writeHead(200, {
                "Content-Type":
                  "application/json"
              });

              res.end(
                JSON.stringify({
                  success: true,
                  marked
                })
              );

            } catch (error) {

              console.error(error);

              res.writeHead(500);

              res.end(
                JSON.stringify({
                  error:
                    error.message
                })
              );
            }

          }
        );

        return;
      }

      /* =====================
         UNMARK NUMBER
      ===================== */

      if (
        req.method === "POST" &&
        req.url === "/api/unmark"
      ) {

        let body = "";

        req.on(
          "data",
          chunk => {
            body += chunk;
          }
        );

        req.on(
          "end",
          async () => {

            try {

              const data =
                JSON.parse(body);

              const user =
                validateTelegramInitData(
                  data.initData
                );

              if (!user) {

                res.writeHead(401);

                res.end(
                  JSON.stringify({
                    error:
                      "Invalid Telegram data"
                  })
                );

                return;
              }

              const number =
                Number(data.number);

              const player =
                await pool.query(
                  `
                  SELECT marked_numbers
                  FROM players
                  WHERE user_id = $1
                  `,
                  [user.id]
                );

              if (
                player.rows.length === 0
              ) {

                res.writeHead(404);

                res.end(
                  JSON.stringify({
                    error:
                      "Player not found"
                  })
                );

                return;
              }

              let marked =
                player.rows[0]
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
                  JSON.stringify(
                    marked
                  ),
                  user.id
                ]
              );

              res.writeHead(200, {
                "Content-Type":
                  "application/json"
              });

              res.end(
                JSON.stringify({
                  success: true,
                  marked
                })
              );

            } catch (error) {

              console.error(error);

              res.writeHead(500);

              res.end(
                JSON.stringify({
                  error:
                    error.message
                })
              );
            }

          }
        );

        return;
      }

      /* =====================
         BINGO
      ===================== */

      if (
        req.method === "POST" &&
        req.url === "/api/bingo"
      ) {

        res.writeHead(200, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify({
            success: false,
            message:
              "Bingo game has not started yet."
          })
        );

        return;
      }

      /* =====================
         NOT FOUND
      ===================== */

      res.writeHead(404, {
        "Content-Type":
          "application/json"
      });

      res.end(
        JSON.stringify({
          error: "Not found"
        })
      );

    } catch (error) {

      console.error(
        "Server error:",
        error
      );

      res.writeHead(500, {
        "Content-Type":
          "application/json"
      });

      res.end(
        JSON.stringify({
          error:
            error.message
        })
      );
    }
  }
);

/* =========================
   START
========================= */

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

        console.log(
          `Mini App file: ${MINIAPP_FILE}`
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
