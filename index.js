const { Telegraf } = require("telegraf");
const { Pool } = require("pg");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 10000;

const RENDER_URL =
  "https://telegram-bingo-bot-q54q.onrender.com";

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

  N[2] = "FREE";

  return {
    B,
    I,
    N,
    G,
    O
  };
}

/* =========================
   DATABASE
========================= */

async function initDatabase() {
  console.log("Initializing database...");

  // Rebuild bingo_cards with the correct structure
  await pool.query(`
    DROP TABLE IF EXISTS bingo_cards CASCADE
  `);

  await pool.query(`
    CREATE TABLE bingo_cards (
      card_number INTEGER PRIMARY KEY,
      board JSONB NOT NULL
    )
  `);

  // Rebuild players with the correct structure
  await pool.query(`
    DROP TABLE IF EXISTS players CASCADE
  `);

  await pool.query(`
    CREATE TABLE players (
      user_id BIGINT PRIMARY KEY,
      name TEXT DEFAULT 'Player',
      card_number INTEGER,
      marked_numbers JSONB DEFAULT '[]'::jsonb
    )
  `);

  // Only one player can use each card
  await pool.query(`
    CREATE UNIQUE INDEX players_card_number_unique
    ON players(card_number)
    WHERE card_number IS NOT NULL
  `);

  // Game state
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

  await generatePermanentCards();

  console.log("DATABASE READY");
}

/* =========================
   PERMANENT CARDS 1-100
========================= */

async function generatePermanentCards() {
  const result = await pool.query(`
    SELECT card_number, board
    FROM bingo_cards
    ORDER BY card_number
  `);

  const existingNumbers = new Set();
  const existingBoards = new Set();

  for (const row of result.rows) {
    existingNumbers.add(row.card_number);

    existingBoards.add(
      JSON.stringify(row.board)
    );
  }

  for (let number = 1; number <= 100; number++) {
    if (existingNumbers.has(number)) {
      continue;
    }

    let board;
    let boardKey;

    do {
      board = generateCard();
      boardKey = JSON.stringify(board);
    } while (existingBoards.has(boardKey));

    await pool.query(
      `
      INSERT INTO bingo_cards
      (card_number, board)
      VALUES ($1, $2)
      `,
      [
        number,
        JSON.stringify(board)
      ]
    );

    existingBoards.add(boardKey);
  }

  console.log("100 permanent Bingo cards ready");
}

/* =========================
   TELEGRAM MINI APP SECURITY
========================= */

function validateTelegramInitData(initData) {
  if (!initData) {
    return null;
  }

  const params = new URLSearchParams(initData);

  const hash = params.get("hash");

  if (!hash) {
    return null;
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

  if (calculatedHash !== hash) {
    return null;
  }

  const userString = params.get("user");

  if (!userString) {
    return null;
  }

  try {
    return JSON.parse(userString);
  } catch {
    return null;
  }
}

/* =========================
   PLAYER
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
   TELEGRAM MENU
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
   /START
========================= */

bot.start(async (ctx) => {
  try {
    await registerPlayer(ctx.from);

    await ctx.reply(
      `🎉 Welcome to Bingo!

Choose an option below:`,
      {
        reply_markup: mainKeyboard
      }
    );
  } catch (error) {
    console.error("START ERROR:", error);

    await ctx.reply(
      "Something went wrong. Please try again."
    );
  }
});

/* =========================
   START BUTTON
========================= */

bot.hears("▶️ Start", async (ctx) => {
  try {
    await registerPlayer(ctx.from);

    await ctx.reply(
      "🎉 Welcome back!\n\nChoose an option:",
      {
        reply_markup: mainKeyboard
      }
    );
  } catch (error) {
    console.error("START BUTTON ERROR:", error);
  }
});

/* =========================
   PLAY
========================= */

bot.hears("🎮 Play", async (ctx) => {
  try {
    await registerPlayer(ctx.from);

    await ctx.reply(
      "🎯 Choose your Bingo card:",
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
    console.error("PLAY ERROR:", error);
  }
});

/* =========================
   DEPOSIT
========================= */

bot.hears("💰 Deposit", async (ctx) => {
  await ctx.reply(
    `💰 Deposit

Deposit functionality is currently under development.

Your balance will appear here when the payment system is added.`
  );
});

/* =========================
   BALANCE
========================= */

bot.hears("💵 Balance", async (ctx) => {
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
      await registerPlayer(ctx.from);

      return ctx.reply(
        "💵 Balance: 0\n\n🎯 Card: Not selected"
      );
    }

    const cardNumber =
      result.rows[0].card_number;

    await ctx.reply(
      `💵 Balance: 0

🎯 Card: ${
        cardNumber
          ? "#" + cardNumber
          : "Not selected"
      }`
    );
  } catch (error) {
    console.error("BALANCE ERROR:", error);

    await ctx.reply(
      "Could not load your balance."
    );
  }
});

/* =========================
   WITHDRAW
========================= */

bot.hears("🏧 Withdraw", async (ctx) => {
  await ctx.reply(
    `🏧 Withdraw

Withdrawal functionality is currently under development.`
  );
});

/* =========================
   HOW TO PLAY
========================= */

bot.hears("❓ HIW / How to Play", async (ctx) => {
  await ctx.reply(
    `❓ HOW TO PLAY

1️⃣ Press 🎮 Play.
2️⃣ Open the Bingo game.
3️⃣ Choose a card number from 1 to 100.
4️⃣ Preview your Bingo card.
5️⃣ Press OK to confirm your card.
6️⃣ Your selected card is saved for you.

🎯 Every card has 25 spaces.
⭐ The center space is FREE.

Good luck! 🍀`
  );
});

/* =========================
   INVITE
========================= */

bot.hears("📨 Invite", async (ctx) => {
  const username =
    ctx.botInfo?.username;

  if (!username) {
    return ctx.reply(
      "Invite link is currently unavailable."
    );
  }

  const inviteLink =
    `https://t.me/${username}`;

  await ctx.reply(
    `📨 Invite Friends

Share this bot with your friends:

${inviteLink}`
  );
});

/* =========================
   SUPPORT
========================= */

bot.hears("🆘 Support", async (ctx) => {
  await ctx.reply(
    `🆘 Support

Support contact will be added here.`
  );
});

/* =========================
   HTTP SERVER
========================= */

const server = http.createServer(
  async (req, res) => {
    try {
      /* ---------- HEALTH ---------- */

      if (
        req.method === "GET" &&
        req.url === "/health"
      ) {
        res.writeHead(200, {
          "Content-Type": "application/json"
        });

        return res.end(
          JSON.stringify({
            status: "ok"
          })
        );
      }

      /* ---------- MINI APP ---------- */

      if (
        req.method === "GET" &&
        (
          req.url === "/" ||
          req.url === "/miniapp"
        )
      ) {
        if (!fs.existsSync(MINIAPP_FILE)) {
          res.writeHead(404, {
            "Content-Type":
              "application/json"
          });

          return res.end(
            JSON.stringify({
              error:
                "miniapp/index.html not found"
            })
          );
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

        return res.end(html);
      }

      /* ---------- TELEGRAM WEBHOOK ---------- */

      if (
        req.method === "POST" &&
        req.url === "/telegram-webhook"
      ) {
        let body = "";

        req.on(
          "data",
          chunk => {
            body += chunk.toString();
          }
        );

        req.on(
          "end",
          async () => {
            try {
              const update =
                JSON.parse(body);

              await bot.handleUpdate(update);

              res.writeHead(200, {
                "Content-Type":
                  "application/json"
              });

              res.end(
                JSON.stringify({
                  ok: true
                })
              );
            } catch (error) {
              console.error(
                "WEBHOOK ERROR:",
                error
              );

              res.writeHead(500, {
                "Content-Type":
                  "application/json"
              });

              res.end(
                JSON.stringify({
                  error:
                    "Webhook processing failed"
                })
              );
            }
          }
        );

        return;
      }

      /* ---------- GET ALL CARDS ---------- */

      if (
        req.method === "GET" &&
        req.url === "/api/cards"
      ) {
        const result =
          await pool.query(
            `
            SELECT card_number, board
            FROM bingo_cards
            ORDER BY card_number
            `
          );

        res.writeHead(200, {
          "Content-Type":
            "application/json"
        });

        return res.end(
          JSON.stringify(
            result.rows
          )
        );
      }

      /* ---------- MY CARD ---------- */

      if (
        req.method === "GET" &&
        req.url.startsWith(
          "/api/my-card"
        )
      ) {
        const url =
          new URL(
            req.url,
            RENDER_URL
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

          return res.end(
            JSON.stringify({
              error:
                "Invalid Telegram data"
            })
          );
        }

        const result =
          await pool.query(
            `
            SELECT
              p.card_number,
              b.board,
              p.marked_numbers
            FROM players p
            LEFT JOIN bingo_cards b
              ON p.card_number =
                 b.card_number
            WHERE p.user_id = $1
            `,
            [user.id]
          );

        if (
          result.rows.length === 0
        ) {
          res.writeHead(200, {
            "Content-Type":
              "application/json"
          });

          return res.end(
            JSON.stringify({
              cardNumber: null,
              board: null,
              markedNumbers: []
            })
          );
        }

        const row =
          result.rows[0];

        res.writeHead(200, {
          "Content-Type":
            "application/json"
        });

        return res.end(
          JSON.stringify({
            cardNumber:
              row.card_number,
            board:
              row.board,
            markedNumbers:
              row.marked_numbers || []
          })
        );
      }

      /* ---------- READ JSON BODY ---------- */

      if (
        req.method === "POST" &&
        (
          req.url ===
            "/api/select-card" ||
          req.url ===
            "/api/mark" ||
          req.url ===
            "/api/unmark" ||
          req.url ===
            "/api/bingo"
        )
      ) {
        let body = "";

        req.on(
          "data",
          chunk => {
            body += chunk.toString();
          }
        );

        req.on(
          "end",
          async () => {
            try {
              const data =
                JSON.parse(body || "{}");

              /* ---------- SELECT CARD ---------- */

              if (
                req.url ===
                "/api/select-card"
              ) {
                const user =
                  validateTelegramInitData(
                    data.initData
                  );

                if (!user) {
                  res.writeHead(401, {
                    "Content-Type":
                      "application/json"
                  });

                  return res.end(
                    JSON.stringify({
                      error:
                        "Invalid Telegram data"
                    })
                  );
                }

                const cardNumber =
                  Number(
                    data.cardNumber
                  );

                if (
                  !Number.isInteger(
                    cardNumber
                  ) ||
                  cardNumber < 1 ||
                  cardNumber > 100
                ) {
                  res.writeHead(400, {
                    "Content-Type":
                      "application/json"
                  });

                  return res.end(
                    JSON.stringify({
                      error:
                        "Invalid card number"
                    })
                  );
                }

                await registerPlayer(user);

                const cardResult =
                  await pool.query(
                    `
                    SELECT
                      card_number,
                      board
                    FROM bingo_cards
                    WHERE card_number = $1
                    `,
                    [cardNumber]
                  );

                if (
                  cardResult.rows.length === 0
                ) {
                  res.writeHead(404, {
                    "Content-Type":
                      "application/json"
                  });

                  return res.end(
                    JSON.stringify({
                      error:
                        "Card not found"
                    })
                  );
                }

                try {
                  await pool.query(
                    `
                    UPDATE players
                    SET
                      card_number = $1,
                      marked_numbers = '[]'::jsonb
                    WHERE user_id = $2
                    `,
                    [
                      cardNumber,
                      user.id
                    ]
                  );
                } catch (error) {
                  if (
                    error.code ===
                    "23505"
                  ) {
                    res.writeHead(409, {
                      "Content-Type":
                        "application/json"
                    });

                    return res.end(
                      JSON.stringify({
                        error:
                          "This Bingo card is already selected by another player."
                      })
                    );
                  }

                  throw error;
                }

                res.writeHead(200, {
                  "Content-Type":
                    "application/json"
                });

                return res.end(
                  JSON.stringify({
                    success: true,
                    cardNumber:
                      cardNumber,
                    board:
                      cardResult.rows[0]
                        .board
                  })
                );
              }

              /* ---------- MARK ---------- */

              if (
                req.url ===
                "/api/mark"
              ) {
                const user =
                  validateTelegramInitData(
                    data.initData
                  );

                if (!user) {
                  res.writeHead(401, {
                    "Content-Type":
                      "application/json"
                  });

                  return res.end(
                    JSON.stringify({
                      error:
                        "Invalid Telegram data"
                    })
                  );
                }

                const number =
                  data.number;

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
                  res.writeHead(404, {
                    "Content-Type":
                      "application/json"
                  });

                  return res.end(
                    JSON.stringify({
                      error:
                        "Player not found"
                    })
                  );
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

                return res.end(
                  JSON.stringify({
                    success: true,
                    markedNumbers:
                      marked
                  })
                );
              }

              /* ---------- UNMARK ---------- */

              if (
                req.url ===
                "/api/unmark"
              ) {
                const user =
                  validateTelegramInitData(
                    data.initData
                  );

                if (!user) {
                  res.writeHead(401, {
                    "Content-Type":
                      "application/json"
                  });

                  return res.end(
                    JSON.stringify({
                      error:
                        "Invalid Telegram data"
                    })
                  );
                }

                const number =
                  data.number;

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
                  res.writeHead(404, {
                    "Content-Type":
                      "application/json"
                  });

                  return res.end(
                    JSON.stringify({
                      error:
                        "Player not found"
                    })
                  );
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

                return res.end(
                  JSON.stringify({
                    success: true,
                    markedNumbers:
                      marked
                  })
                );
              }

              /* ---------- BINGO ---------- */

              if (
                req.url ===
                "/api/bingo"
              ) {
                const user =
                  validateTelegramInitData(
                    data.initData
                  );

                if (!user) {
                  res.writeHead(401, {
                    "Content-Type":
                      "application/json"
                  });

                  return res.end(
                    JSON.stringify({
                      error:
                        "Invalid Telegram data"
                    })
                  );
                }

                res.writeHead(200, {
                  "Content-Type":
                    "application/json"
                });

                return res.end(
                  JSON.stringify({
                    success: true,
                    message:
                      "Bingo checking will be added with the game system."
                  })
                );
              }
            } catch (error) {
              console.error(
                "API ERROR:",
                error
              );

              if (!res.headersSent) {
                res.writeHead(500, {
                  "Content-Type":
                    "application/json"
                });

                res.end(
                  JSON.stringify({
                    error:
                      error.message ||
                      "Server error"
                  })
                );
              }
            }
          }
        );

        return;
      }

      /* ---------- NOT FOUND ---------- */

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
        "SERVER ERROR:",
        error
      );

      if (!res.headersSent) {
        res.writeHead(500, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify({
            error:
              "Internal server error"
          })
        );
      }
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
