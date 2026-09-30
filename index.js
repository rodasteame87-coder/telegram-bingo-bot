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

// Automatic caller: 5 seconds
const CALL_INTERVAL = 5000;

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

function shuffle(array) {
  const arr = [...array];

  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [arr[i], arr[j]] = [
      arr[j],
      arr[i]
    ];
  }

  return arr;
}

function generateCard() {
  const B = shuffle(
    Array.from(
      { length: 15 },
      (_, i) => i + 1
    )
  ).slice(0, 5);

  const I = shuffle(
    Array.from(
      { length: 15 },
      (_, i) => i + 16
    )
  ).slice(0, 5);

  const N = shuffle(
    Array.from(
      { length: 15 },
      (_, i) => i + 31
    )
  ).slice(0, 5);

  const G = shuffle(
    Array.from(
      { length: 15 },
      (_, i) => i + 46
    )
  ).slice(0, 5);

  const O = shuffle(
    Array.from(
      { length: 15 },
      (_, i) => i + 61
    )
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

async function initDatabase() {
  console.log(
    "Initializing database..."
  );

  // Permanent Bingo cards.
  // Do NOT drop this table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bingo_cards (
      card_number INTEGER PRIMARY KEY,
      board JSONB NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      user_id BIGINT PRIMARY KEY,
      name TEXT DEFAULT 'Player',
      card_number INTEGER,
      marked_numbers JSONB DEFAULT '[]'::jsonb
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    players_card_number_unique
    ON players(card_number)
    WHERE card_number IS NOT NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_state (
      id INTEGER PRIMARY KEY,
      game_id BIGINT NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'waiting',
      called_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
      current_number INTEGER,
      started_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE game_state
    ADD COLUMN IF NOT EXISTS
    game_id BIGINT NOT NULL DEFAULT 1
  `);

  await pool.query(`
    ALTER TABLE game_state
    ADD COLUMN IF NOT EXISTS
    status TEXT NOT NULL DEFAULT 'waiting'
  `);

  await pool.query(`
    ALTER TABLE game_state
    ADD COLUMN IF NOT EXISTS
    called_numbers JSONB NOT NULL DEFAULT '[]'::jsonb
  `);

  await pool.query(`
    ALTER TABLE game_state
    ADD COLUMN IF NOT EXISTS
    current_number INTEGER
  `);

  await pool.query(`
    ALTER TABLE game_state
    ADD COLUMN IF NOT EXISTS
    started_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE game_state
    ADD COLUMN IF NOT EXISTS
    updated_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await pool.query(`
    INSERT INTO game_state
      (
        id,
        game_id,
        status,
        called_numbers,
        current_number
      )
    VALUES
      (
        1,
        1,
        'waiting',
        '[]'::jsonb,
        NULL
      )
    ON CONFLICT (id)
    DO NOTHING
  `);

  await generatePermanentCards();

  console.log(
    "DATABASE READY"
  );
}

async function generatePermanentCards() {
  const result =
    await pool.query(`
      SELECT
        card_number,
        board
      FROM bingo_cards
      ORDER BY card_number
    `);

  const existingNumbers =
    new Set();

  const existingBoards =
    new Set();

  for (
    const row of result.rows
  ) {
    existingNumbers.add(
      row.card_number
    );

    existingBoards.add(
      JSON.stringify(
        row.board
      )
    );
  }

  for (
    let number = 1;
    number <= 100;
    number++
  ) {
    if (
      existingNumbers.has(
        number
      )
    ) {
      continue;
    }

    let board;
    let boardKey;

    do {
      board =
        generateCard();

      boardKey =
        JSON.stringify(
          board
        );
    } while (
      existingBoards.has(
        boardKey
      )
    );

    await pool.query(
      `
      INSERT INTO bingo_cards
        (
          card_number,
          board
        )
      VALUES
        ($1, $2)
      `,
      [
        number,
        JSON.stringify(
          board
        )
      ]
    );

    existingBoards.add(
      boardKey
    );
  }

  console.log(
    "100 permanent Bingo cards ready"
  );
}

function validateTelegramInitData(
  initData
) {
  if (!initData) {
    return null;
  }

  const params =
    new URLSearchParams(
      initData
    );

  const hash =
    params.get("hash");

  if (!hash) {
    return null;
  }

  params.delete("hash");

  const dataCheckString =
    [...params.entries()]
      .sort(
        ([a], [b]) =>
          a.localeCompare(b)
      )
      .map(
        ([key, value]) =>
          `${key}=${value}`
      )
      .join("\n");

  const secretKey =
    crypto
      .createHmac(
        "sha256",
        "WebAppData"
      )
      .update(
        BOT_TOKEN
      )
      .digest();

  const calculatedHash =
    crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(
        dataCheckString
      )
      .digest("hex");

  if (
    calculatedHash !==
    hash
  ) {
    return null;
  }

  const userString =
    params.get("user");

  if (!userString) {
    return null;
  }

  try {
    return JSON.parse(
      userString
    );
  } catch {
    return null;
  }
}

async function registerPlayer(
  user
) {
  if (
    !user ||
    !user.id
  ) {
    return;
  }

  const name =
    user.first_name ||
    user.username ||
    "Player";

  await pool.query(
    `
    INSERT INTO players
      (
        user_id,
        name
      )
    VALUES
      ($1, $2)
    ON CONFLICT (user_id)
    DO UPDATE SET
      name = EXCLUDED.name
    `,
    [
      user.id,
      name
    ]
  );
}

/* =========================
   BINGO GAME SYSTEM
========================= */

async function getGameState() {
  const result =
    await pool.query(`
      SELECT
        game_id,
        status,
        called_numbers,
        current_number,
        started_at,
        updated_at
      FROM game_state
      WHERE id = 1
    `);

  if (
    result.rows.length === 0
  ) {
    return null;
  }

  const row =
    result.rows[0];

  return {
    gameId:
      Number(row.game_id),

    status:
      row.status,

    calledNumbers:
      row.called_numbers ||
      [],

    currentNumber:
      row.current_number ===
      null
        ? null
        : Number(
            row.current_number
          ),

    startedAt:
      row.started_at,

    updatedAt:
      row.updated_at
  };
}

async function startNewGame() {
  const result =
    await pool.query(`
      SELECT
        COALESCE(
          MAX(game_id),
          0
        ) + 1 AS next_id
      FROM game_state
    `);

  let nextGameId =
    Number(
      result.rows[0]
        .next_id
    );

  if (
    !Number.isFinite(
      nextGameId
    )
  ) {
    nextGameId = 1;
  }

  await pool.query(
    `
    UPDATE game_state
    SET
      game_id = $1,
      status = 'playing',
      called_numbers =
        '[]'::jsonb,
      current_number = NULL,
      started_at = NOW(),
      updated_at = NOW()
    WHERE id = 1
    `,
    [
      nextGameId
    ]
  );

  console.log(
    `BINGO GAME #${nextGameId} STARTED`
  );
}

async function callNextNumber() {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const result =
      await client.query(`
        SELECT
          game_id,
          status,
          called_numbers
        FROM game_state
        WHERE id = 1
        FOR UPDATE
      `);

    if (
      result.rows.length ===
      0
    ) {
      await client.query(
        "ROLLBACK"
      );

      return;
    }

    const row =
      result.rows[0];

    let calledNumbers =
      row.called_numbers ||
      [];

    if (
      row.status !==
      "playing"
    ) {
      await client.query(
        "ROLLBACK"
      );

      return;
    }

    if (
      calledNumbers.length >=
      75
    ) {
      await client.query(`
        UPDATE game_state
        SET
          status = 'finished',
          current_number = NULL,
          updated_at = NOW()
        WHERE id = 1
      `);

      await client.query(
        "COMMIT"
      );

      console.log(
        `BINGO GAME #${row.game_id} FINISHED`
      );

      setTimeout(
        async () => {
          try {
            await startNewGame();
          } catch (error) {
            console.error(
              "NEW GAME ERROR:",
              error
            );
          }
        },
        5000
      );

      return;
    }

    const availableNumbers =
      [];

    for (
      let number = 1;
      number <= 75;
      number++
    ) {
      if (
        !calledNumbers.includes(
          number
        )
      ) {
        availableNumbers.push(
          number
        );
      }
    }

    if (
      availableNumbers.length ===
      0
    ) {
      await client.query(
        "ROLLBACK"
      );

      return;
    }

    const randomIndex =
      Math.floor(
        Math.random() *
          availableNumbers.length
      );

    const number =
      availableNumbers[
        randomIndex
      ];

    calledNumbers.push(
      number
    );

    await client.query(
      `
      UPDATE game_state
      SET
        called_numbers = $1,
        current_number = $2,
        updated_at = NOW()
      WHERE id = 1
      `,
      [
        JSON.stringify(
          calledNumbers
        ),
        number
      ]
    );

    await client.query(
      "COMMIT"
    );

    console.log(
      `GAME #${row.game_id}: CALLED ${number}`
    );

  } catch (error) {

    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {}

    console.error(
      "CALL NUMBER ERROR:",
      error
    );

  } finally {
    client.release();
  }
}

function startAutomaticCaller() {
  console.log(
    "Automatic Bingo caller started."
  );

  console.log(
    "Numbers will be called every 5 seconds."
  );

  setInterval(
    async () => {
      try {
        const game =
          await getGameState();

        if (!game) {
          return;
        }

        if (
          game.status ===
          "waiting"
        ) {
          await startNewGame();

          return;
        }

        if (
          game.status ===
          "playing"
        ) {
          await callNextNumber();

          return;
        }

      } catch (error) {

        console.error(
          "AUTOMATIC CALLER ERROR:",
          error
        );
      }
    },
    CALL_INTERVAL
  );
}

/* =========================
   TELEGRAM MENU
========================= */

const mainKeyboard = {
  keyboard: [
    [
      {
        text: "▶️ Start"
      }
    ],
    [
      {
        text: "🎮 Play"
      }
    ],
    [
      {
        text: "💰 Deposit"
      }
    ],
    [
      {
        text: "💵 Balance"
      }
    ],
    [
      {
        text: "🏧 Withdraw"
      }
    ],
    [
      {
        text:
          "❓ HIW / How to Play"
      }
    ],
    [
      {
        text: "📨 Invite"
      }
    ],
    [
      {
        text: "🆘 Support"
      }
    ]
  ],
  resize_keyboard: true
};

bot.start(
  async (ctx) => {
    try {
      await registerPlayer(
        ctx.from
      );

      await ctx.reply(
        `🎉 Welcome to Bingo!

Choose an option below:`,
        {
          reply_markup:
            mainKeyboard
        }
      );

    } catch (error) {

      console.error(
        "START ERROR:",
        error
      );

      await ctx.reply(
        "Something went wrong. Please try again."
      );
    }
  }
);

bot.hears(
  "▶️ Start",
  async (ctx) => {
    try {
      await registerPlayer(
        ctx.from
      );

      await ctx.reply(
        "🎉 Welcome back!\n\nChoose an option:",
        {
          reply_markup:
            mainKeyboard
        }
      );

    } catch (error) {

      console.error(
        "START BUTTON ERROR:",
        error
      );
    }
  }
);

bot.hears(
  "🎮 Play",
  async (ctx) => {
    try {
      await registerPlayer(
        ctx.from
      );

      await ctx.reply(
        "🎯 Choose your Bingo card:",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "🎯 OPEN BINGO",

                  web_app: {
                    url:
                      MINIAPP_URL
                  }
                }
              ]
            ]
          }
        }
      );

    } catch (error) {

      console.error(
        "PLAY ERROR:",
        error
      );
    }
  }
);

bot.hears(
  "💰 Deposit",
  async (ctx) => {
    await ctx.reply(
      `💰 Deposit

Deposit functionality is currently under development.

Your balance will appear here when the payment system is added.`
    );
  }
);

bot.hears(
  "💵 Balance",
  async (ctx) => {
    try {
      const result =
        await pool.query(
          `
          SELECT
            card_number
          FROM players
          WHERE user_id = $1
          `,
          [
            ctx.from.id
          ]
        );

      if (
        result.rows.length ===
        0
      ) {
        await registerPlayer(
          ctx.from
        );

        return ctx.reply(
          "💵 Balance: 0\n\n🎯 Card: Not selected"
        );
      }

      const cardNumber =
        result.rows[0]
          .card_number;

      await ctx.reply(
        `💵 Balance: 0

🎯 Card: ${
          cardNumber
            ? "#" +
              cardNumber
            : "Not selected"
        }`
      );

    } catch (error) {

      console.error(
        "BALANCE ERROR:",
        error
      );

      await ctx.reply(
        "Could not load your balance."
      );
    }
  }
);

bot.hears(
  "🏧 Withdraw",
  async (ctx) => {
    await ctx.reply(
      `🏧 Withdraw

Withdrawal functionality is currently under development.`
    );
  }
);

bot.hears(
  "❓ HIW / How to Play",
  async (ctx) => {
    await ctx.reply(
      `❓ HOW TO PLAY

1️⃣ Press 🎮 Play.
2️⃣ Open the Bingo game.
3️⃣ Choose a card from 1 to 100.
4️⃣ Preview your card.
5️⃣ Press OK to confirm.
6️⃣ The game automatically calls numbers from 1–75.
7️⃣ A new number appears every 5 seconds.
8️⃣ Mark numbers on your card when they are called.
9️⃣ Press BINGO when you have a winning line.

⭐ The center space is FREE.
🎯 All players see the same called numbers.

Good luck! 🍀`
    );
  }
);

bot.hears(
  "📨 Invite",
  async (ctx) => {
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
  }
);

bot.hears(
  "🆘 Support",
  async (ctx) => {
    await ctx.reply(
      `🆘 Support

Support contact will be added here.`
    );
  }
);

/* =========================
   HTTP SERVER
========================= */

const server =
  http.createServer(
    async (req, res) => {

      try {

        if (
          req.method ===
            "GET" &&
          req.url ===
            "/health"
        ) {
          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              status: "ok"
            })
          );
        }

        if (
          req.method ===
            "GET" &&
          (
            req.url === "/" ||
            req.url ===
              "/miniapp"
          )
        ) {

          if (
            !fs.existsSync(
              MINIAPP_FILE
            )
          ) {
            res.writeHead(
              404,
              {
                "Content-Type":
                  "application/json"
              }
            );

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

          res.writeHead(
            200,
            {
              "Content-Type":
                "text/html; charset=utf-8"
            }
          );

          return res.end(
            html
          );
        }

        if (
          req.method ===
            "POST" &&
          req.url ===
            "/telegram-webhook"
        ) {

          let body = "";

          req.on(
            "data",
            chunk => {
              body +=
                chunk.toString();
            }
          );

          req.on(
            "end",
            async () => {

              try {

                const update =
                  JSON.parse(
                    body
                  );

                await bot.handleUpdate(
                  update
                );

                res.writeHead(
                  200,
                  {
                    "Content-Type":
                      "application/json"
                  }
                );

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

                res.writeHead(
                  500,
                  {
                    "Content-Type":
                      "application/json"
                  }
                );

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

        /* GET CARDS */

        if (
          req.method ===
            "GET" &&
          req.url ===
            "/api/cards"
        ) {

          const result =
            await pool.query(`
              SELECT
                card_number,
                board
              FROM bingo_cards
              ORDER BY card_number
            `);

          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify(
              result.rows
            )
          );
        }

        /* GET GAME STATE */

        if (
          req.method ===
            "GET" &&
          req.url ===
            "/api/game-state"
        ) {

          const game =
            await getGameState();

          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify(
              game || {
                gameId: 0,
                status:
                  "waiting",
                calledNumbers: [],
                currentNumber:
                  null
              }
            )
          );
        }

        /* GET MY CARD */

        if (
          req.method ===
            "GET" &&
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

            res.writeHead(
              401,
              {
                "Content-Type":
                  "application/json"
              }
            );

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
              [
                user.id
              ]
            );

          if (
            result.rows.length ===
            0
          ) {

            res.writeHead(
              200,
              {
                "Content-Type":
                  "application/json"
              }
            );

            return res.end(
              JSON.stringify({
                cardNumber:
                  null,
                board:
                  null,
                markedNumbers:
                  []
              })
            );
          }

          const row =
            result.rows[0];

          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              cardNumber:
                row.card_number,

              board:
                row.board,

              markedNumbers:
                row.marked_numbers ||
                []
            })
          );
        }

        /* POST APIs */

        if (
          req.method ===
            "POST" &&
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
              body +=
                chunk.toString();
            }
          );

          req.on(
            "end",
            async () => {

              try {

                const data =
                  JSON.parse(
                    body || "{}"
                  );

                /* SELECT CARD */

                if (
                  req.url ===
                  "/api/select-card"
                ) {

                  const user =
                    validateTelegramInitData(
                      data.initData
                    );

                  if (!user) {

                    res.writeHead(
                      401,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );

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

                    res.writeHead(
                      400,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );

                    return res.end(
                      JSON.stringify({
                        error:
                          "Invalid card number"
                      })
                    );
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
                      [
                        cardNumber
                      ]
                    );

                  if (
                    cardResult.rows.length ===
                    0
                  ) {

                    res.writeHead(
                      404,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );

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
                        marked_numbers =
                          '[]'::jsonb
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

                      res.writeHead(
                        409,
                        {
                          "Content-Type":
                            "application/json"
                        }
                      );

                      return res.end(
                        JSON.stringify({
                          error:
                            "This Bingo card is already selected by another player."
                        })
                      );
                    }

                    throw error;
                  }

                  res.writeHead(
                    200,
                    {
                      "Content-Type":
                        "application/json"
                    }
                  );

                  return res.end(
                    JSON.stringify({
                      success:
                        true,

                      cardNumber,

                      board:
                        cardResult
                          .rows[0]
                          .board
                    })
                  );
                }

                /* MARK */

                if (
                  req.url ===
                  "/api/mark"
                ) {

                  const user =
                    validateTelegramInitData(
                      data.initData
                    );

                  if (!user) {

                    res.writeHead(
                      401,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );

                    return res.end(
                      JSON.stringify({
                        error:
                          "Invalid Telegram data"
                      })
                    );
                  }

                  const number =
                    Number(
                      data.number
                    );

                  if (
                    !Number.isInteger(
                      number
                    ) ||
                    number < 1 ||
                    number > 75
                  ) {

                    res.writeHead(
                      400,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );

                    return res.end(
                      JSON.stringify({
                        error:
                          "Invalid number"
                      })
                    );
                  }

                  const game =
                    await getGameState();

                  if (
                    !game.calledNumbers.includes(
                      number
                    )
                  ) {

                    res.writeHead(
                      400,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );

                    return res.end(
                      JSON.stringify({
                        error:
                          "This number has not been called yet."
                      })
                    );
                  }

                  const player =
                    await pool.query(
                      `
                      SELECT
                        marked_numbers
                      FROM players
                      WHERE user_id = $1
                      `,
                      [
                        user.id
                      ]
                    );

                  if (
                    player.rows.length ===
                    0
                  ) {

                    res.writeHead(
                      404,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );

                    return res.end(
                      JSON.stringify({
                        error:
                          "Player not found"
                      })
                    );
                  }

                  let marked =
                    player.rows[0]
                      .marked_numbers ||
                    [];

                  if (
                    !marked.includes(
                      number
                    )
                  ) {
                    marked.push(
                      number
                    );
                  }

                  await pool.query(
                    `
                    UPDATE players
                    SET
                      marked_numbers =
                        $1
                    WHERE user_id = $2
                    `,
                    [
                      JSON.stringify(
                        marked
                      ),
                      user.id
                    ]
                  );

                  res.writeHead(
                    200,
                    {
                      "Content-Type":
                        "application/json"
                    }
                  );

                  return res.end(
                    JSON.stringify({
                      success:
                        true,

                      markedNumbers:
                        marked
                    })
                  );
                }

                /* UNMARK */

                if (
                  req.url ===
                  "/api/unmark"
                ) {

                  const user =
                    validateTelegramInitData(
                      data.initData
                    );

                  if (!user) {

                    res.writeHead(
                      401,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );

                    return res.end(
                      JSON.stringify({
                        error:
                          "Invalid Telegram data"
                      })
                    );
                  }

                  const number =
                    Number(
                      data.number
                    );

                  const player =
                    await pool.query(
                      `
                      SELECT
                        marked_numbers
                      FROM players
                      WHERE user_id = $1
                      `,
                      [
                        user.id
                      ]
                    );

                  if (
                    player.rows.length ===
                    0
                  ) {

                    res.writeHead(
                      404,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );

                    return res.end(
                      JSON.stringify({
                        error:
                          "Player not found"
                      })
                    );
                  }

                  let marked =
                    player.rows[0]
                      .marked_numbers ||
                    [];

                  marked =
                    marked.filter(
                      n =>
                        n !==
                        number
                    );

                  await pool.query(
                    `
                    UPDATE players
                    SET
                      marked_numbers =
                        $1
                    WHERE user_id = $2
                    `,
                    [
                      JSON.stringify(
                        marked
                      ),
                      user.id
                    ]
                  );

                  res.writeHead(
                    200,
                    {
                      "Content-Type":
                        "application/json"
                    }
                  );

                  return res.end(
                    JSON.stringify({
                      success:
                        true,

                      markedNumbers:
                        marked
                    })
                  );
                }

                /* BINGO */

                if (
                  req.url ===
                  "/api/bingo"
                ) {

                  const user =
                    validateTelegramInitData(
                      data.initData
                    );

                  if (!user) {

                    res.writeHead(
                      401,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );

                    return res.end(
                      JSON.stringify({
                        error:
                          "Invalid Telegram data"
                      })
                    );
                  }

                  const player =
                    await pool.query(
                      `
                      SELECT
                        card_number,
                        marked_numbers
                      FROM players
                      WHERE user_id = $1
                      `,
                      [
                        user.id
                      ]
                    );

                  if (
                    player.rows.length ===
                      0 ||
                    !player.rows[0]
                      .card_number
                  ) {

                    res.writeHead(
                      400,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );

                    return res.end(
                      JSON.stringify({
                        success:
                          false,

                        message:
                          "You have not selected a Bingo card."
                      })
                    );
                  }

                  const cardNumber =
                    player.rows[0]
                      .card_number;

                  const marked =
                    player.rows[0]
                      .marked_numbers ||
                    [];

                  const cardResult =
                    await pool.query(
                      `
                      SELECT board
                      FROM bingo_cards
                      WHERE card_number = $1
                      `,
                      [
                        cardNumber
                      ]
                    );

                  if (
                    cardResult.rows.length ===
                    0
                  ) {

                    res.writeHead(
                      404,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );

                    return res.end(
                      JSON.stringify({
                        success:
                          false,

                        message:
                          "Card not found."
                      })
                    );
                  }

                  const board =
                    cardResult
                      .rows[0]
                      .board;

                  const winningLines =
                    [];

                  const columns = [
                    board.B,
                    board.I,
                    board.N,
                    board.G,
                    board.O
                  ];

                  // Rows
                  for (
                    let row = 0;
                    row < 5;
                    row++
                  ) {

                    const line =
                      [];

                    for (
                      let col = 0;
                      col < 5;
                      col++
                    ) {

                      line.push(
                        columns[col][row]
                      );
                    }

                    winningLines.push(
                      line
                    );
                  }

                  // Columns
                  for (
                    let col = 0;
                    col < 5;
                    col++
                  ) {

                    const line =
                      [];

                    for (
                      let row = 0;
                      row < 5;
                      row++
                    ) {

                      line.push(
                        columns[col][row]
                      );
                    }

                    winningLines.push(
                      line
                    );
                  }

                  // Diagonal
                  winningLines.push([
                    board.B[0],
                    board.I[1],
                    board.N[2],
                    board.G[3],
                    board.O[4]
                  ]);

                  winningLines.push([
                    board.B[4],
                    board.I[3],
                    board.N[2],
                    board.G[1],
                    board.O[0]
                  ]);

                  const game =
                    await getGameState();

                  const markedSet =
                    new Set(
                      marked
                    );

                  let valid =
                    false;

                  for (
                    const line of
                    winningLines
                  ) {

                    const complete =
                      line.every(
                        value =>
                          value ===
                            "FREE" ||
                          (
                            game.calledNumbers.includes(
                              Number(
                                value
                              )
                            ) &&
                            markedSet.has(
                              Number(
                                value
                              )
                            )
                          )
                      );

                    if (
                      complete
                    ) {
                      valid =
                        true;

                      break;
                    }
                  }

                  res.writeHead(
                    200,
                    {
                      "Content-Type":
                        "application/json"
                    }
                  );

                  if (valid) {

                    return res.end(
                      JSON.stringify({
                        success:
                          true,

                        bingo:
                          true,

                        message:
                          "🎉 BINGO! Your winning line is valid!"
                      })
                    );
                  }

                  return res.end(
                    JSON.stringify({
                      success:
                        true,

                      bingo:
                        false,

                      message:
                        "❌ Not Bingo yet. Keep playing!"
                    })
                  );
                }

              } catch (error) {

                console.error(
                  "API ERROR:",
                  error
                );

                if (
                  !res.headersSent
                ) {

                  res.writeHead(
                    500,
                    {
                      "Content-Type":
                        "application/json"
                    }
                  );

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

        res.writeHead(
          404,
          {
            "Content-Type":
              "application/json"
          }
        );

        res.end(
          JSON.stringify({
            error:
              "Not found"
          })
        );

      } catch (error) {

        console.error(
          "SERVER ERROR:",
          error
        );

        if (
          !res.headersSent
        ) {

          res.writeHead(
            500,
            {
              "Content-Type":
                "application/json"
            }
          );

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
   START SERVER
========================= */

async function start() {

  try {

    await initDatabase();

    let game =
      await getGameState();

    if (!game) {

      await startNewGame();

    } else if (
      game.status ===
      "finished"
    ) {

      await startNewGame();

    } else if (
      game.status ===
      "waiting"
    ) {

      await startNewGame();
    }

    const webhookUrl =
      `${RENDER_URL}/telegram-webhook`;

    await bot.telegram.setWebhook(
      webhookUrl,
      {
        drop_pending_updates:
          true
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
          "Automatic Bingo caller: EVERY 5 SECONDS"
        );
      }
    );

    startAutomaticCaller();

  } catch (error) {

    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);
  }
}

start();
