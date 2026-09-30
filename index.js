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

const MINIAPP_FILE =
  path.join(__dirname, "miniapp", "index.html");

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing.");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* =========================================================
   DATABASE SETUP + AUTOMATIC MIGRATION
========================================================= */

async function initDatabase() {
  console.log("Checking database...");

  /*
   * Bingo cards
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bingo_cards (
      card_number INTEGER PRIMARY KEY,
      card JSONB NOT NULL
    )
  `);

  /*
   * Players table.
   *
   * We create it if it doesn't exist.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      user_id BIGINT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Player',
      card_number INTEGER,
      marked_numbers JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);

  /*
   * Upgrade old players table.
   */
  await pool.query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS name TEXT
  `);

  await pool.query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS card_number INTEGER
  `);

  await pool.query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS marked_numbers JSONB
  `);

  /*
   * Fix missing player names.
   */
  await pool.query(`
    UPDATE players
    SET name = 'Player'
    WHERE name IS NULL
  `);

  /*
   * Fix marked_numbers if old rows are NULL.
   */
  await pool.query(`
    UPDATE players
    SET marked_numbers = '[]'::jsonb
    WHERE marked_numbers IS NULL
  `);

  /*
   * Add default values for future players.
   */
  await pool.query(`
    ALTER TABLE players
    ALTER COLUMN name SET DEFAULT 'Player'
  `);

  await pool.query(`
    ALTER TABLE players
    ALTER COLUMN marked_numbers SET DEFAULT '[]'::jsonb
  `);

  /*
   * Add foreign key only if it doesn't already exist.
   */
  const fkCheck = await pool.query(`
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'players_card_number_fkey'
  `);

  if (fkCheck.rowCount === 0) {
    await pool.query(`
      ALTER TABLE players
      ADD CONSTRAINT players_card_number_fkey
      FOREIGN KEY (card_number)
      REFERENCES bingo_cards(card_number)
    `);
  }

  /*
   * Game state
   */
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
      (id, called_numbers, winner_user_id, winner_name, status)
    VALUES
      (1, '[]'::jsonb, NULL, NULL, 'waiting')
    ON CONFLICT (id) DO NOTHING
  `);

  await generatePermanentCards();

  console.log("Database is ready.");
}

/* =========================================================
   BINGO CARD GENERATION
========================================================= */

function shuffle(array) {
  const copy = [...array];

  for (let i = copy.length - 1; i > 0; i--) {
    const j =
      Math.floor(Math.random() * (i + 1));

    [copy[i], copy[j]] =
      [copy[j], copy[i]];
  }

  return copy;
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

  const card = [];

  for (let row = 0; row < 5; row++) {
    card.push([
      B[row],
      I[row],
      N[row],
      G[row],
      O[row]
    ]);
  }

  card[2][2] = "FREE";

  return card;
}

function cardKey(card) {
  return JSON.stringify(card);
}

async function generatePermanentCards() {
  const result = await pool.query(`
    SELECT card_number, card
    FROM bingo_cards
  `);

  const existingCards = new Set();

  for (const row of result.rows) {
    existingCards.add(
      cardKey(row.card)
    );
  }

  for (let number = 1; number <= 100; number++) {
    const exists = await pool.query(
      `
      SELECT card_number
      FROM bingo_cards
      WHERE card_number = $1
      `,
      [number]
    );

    if (exists.rowCount > 0) {
      continue;
    }

    let card;

    do {
      card = generateCard();
    } while (
      existingCards.has(
        cardKey(card)
      )
    );

    existingCards.add(
      cardKey(card)
    );

    await pool.query(
      `
      INSERT INTO bingo_cards
        (card_number, card)
      VALUES
        ($1, $2)
      `,
      [
        number,
        JSON.stringify(card)
      ]
    );
  }

  console.log(
    "Cards 1-100 are ready."
  );
}

/* =========================================================
   TELEGRAM MINI APP AUTHENTICATION
========================================================= */

function validateTelegramInitData(initData) {
  if (!initData) {
    throw new Error(
      "Telegram initData is missing."
    );
  }

  const params =
    new URLSearchParams(initData);

  const hash =
    params.get("hash");

  if (!hash) {
    throw new Error(
      "Telegram hash is missing."
    );
  }

  params.delete("hash");

  const dataCheckString =
    [...params.entries()]
      .sort(([a], [b]) =>
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

  const hashBuffer =
    Buffer.from(hash, "hex");

  const calculatedBuffer =
    Buffer.from(
      calculatedHash,
      "hex"
    );

  if (
    hashBuffer.length !==
      calculatedBuffer.length ||
    !crypto.timingSafeEqual(
      hashBuffer,
      calculatedBuffer
    )
  ) {
    throw new Error(
      "Invalid Telegram initData."
    );
  }

  const userString =
    params.get("user");

  if (!userString) {
    throw new Error(
      "Telegram user information is missing."
    );
  }

  return JSON.parse(userString);
}

function getInitDataFromRequest(
  req,
  body = null
) {
  const authorization =
    req.headers.authorization || "";

  if (
    authorization.startsWith("tma ")
  ) {
    return authorization.substring(4);
  }

  if (
    body &&
    body.initData
  ) {
    return body.initData;
  }

  const url =
    new URL(
      req.url,
      RENDER_URL
    );

  return url.searchParams.get(
    "initData"
  );
}

/* =========================================================
   TELEGRAM MENU
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
   START
========================================================= */

async function registerPlayer(user) {
  await pool.query(
    `
    INSERT INTO players
      (
        user_id,
        name,
        marked_numbers
      )
    VALUES
      ($1, $2, '[]'::jsonb)
    ON CONFLICT (user_id)
    DO UPDATE SET
      name = EXCLUDED.name
    `,
    [
      user.id,
      user.first_name ||
        user.username ||
        "Player"
    ]
  );
}

bot.start(async (ctx) => {
  await registerPlayer(
    ctx.from
  );

  await ctx.reply(
    `Welcome ${ctx.from.first_name || "Player"}! 🎉\n\nChoose an option below:`,
    {
      reply_markup:
        mainKeyboard
    }
  );
});

/* =========================================================
   PLAY
========================================================= */

async function sendPlayButton(ctx) {
  await registerPlayer(
    ctx.from
  );

  await ctx.reply(
    "🎮 Choose your Bingo card:",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🎱 Open Bingo",
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

bot.command(
  "play",
  async (ctx) => {
    await sendPlayButton(ctx);
  }
);

bot.hears(
  "▶️ Start",
  async (ctx) => {
    await registerPlayer(
      ctx.from
    );

    await ctx.reply(
      `Welcome ${ctx.from.first_name || "Player"}! 🎉`,
      {
        reply_markup:
          mainKeyboard
      }
    );
  }
);

bot.hears(
  "🎮 Play",
  async (ctx) => {
    await sendPlayButton(ctx);
  }
);

/* =========================================================
   HOW TO PLAY
========================================================= */

bot.hears(
  "❓ HIW / How to Play",
  async (ctx) => {
    await ctx.reply(
      `🎱 HOW TO PLAY\n\n` +
      `1️⃣ Press Play.\n` +
      `2️⃣ Choose a card from 1–100.\n` +
      `3️⃣ Preview the card.\n` +
      `4️⃣ Press OK to confirm.\n` +
      `5️⃣ Numbers will be called during the game.\n` +
      `6️⃣ Mark matching numbers.\n` +
      `7️⃣ Complete Bingo.\n\n` +
      `🍀 Good luck!`
    );
  }
);

/* =========================================================
   INVITE
========================================================= */

bot.hears(
  "📨 Invite",
  async (ctx) => {
    const me =
      await bot.telegram.getMe();

    const link =
      `https://t.me/${me.username}?start=invite`;

    await ctx.reply(
      `📨 Invite your friends!\n\n${link}`
    );
  }
);

/* =========================================================
   SUPPORT
========================================================= */

bot.hears(
  "🆘 Support",
  async (ctx) => {
    await ctx.reply(
      "🆘 Support\n\nPlease contact the bot administrator for help."
    );
  }
);

/* =========================================================
   PLACEHOLDER WALLET BUTTONS
========================================================= */

bot.hears(
  "💰 Deposit",
  async (ctx) => {
    await ctx.reply(
      "💰 Deposit\n\nDeposit functionality is not connected yet."
    );
  }
);

bot.hears(
  "💵 Balance",
  async (ctx) => {
    await ctx.reply(
      "💵 Balance\n\nBalance functionality is not connected yet."
    );
  }
);

bot.hears(
  "🏧 Withdraw",
  async (ctx) => {
    await ctx.reply(
      "🏧 Withdraw\n\nWithdrawal functionality is not connected yet."
    );
  }
);

/* =========================================================
   HTTP HELPERS
========================================================= */

function sendJSON(
  res,
  status,
  data
) {
  res.writeHead(
    status,
    {
      "Content-Type":
        "application/json; charset=utf-8"
    }
  );

  res.end(
    JSON.stringify(data)
  );
}

function readBody(req) {
  return new Promise(
    (resolve, reject) => {
      let body = "";

      req.on(
        "data",
        chunk => {
          body += chunk.toString();
        }
      );

      req.on(
        "end",
        () => {
          if (!body) {
            resolve({});
            return;
          }

          try {
            resolve(
              JSON.parse(body)
            );
          } catch {
            reject(
              new Error(
                "Invalid JSON body."
              )
            );
          }
        }
      );

      req.on(
        "error",
        reject
      );
    }
  );
}

/* =========================================================
   HTTP SERVER
========================================================= */

const server = http.createServer(
  async (req, res) => {
    try {

      /* HEALTH */

      if (
        req.method === "GET" &&
        req.url === "/health"
      ) {
        return sendJSON(
          res,
          200,
          {
            status: "ok"
          }
        );
      }

      /* MINIAPP */

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
          return sendJSON(
            res,
            500,
            {
              error:
                "miniapp/index.html not found",
              expectedPath:
                MINIAPP_FILE
            }
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

        return res.end(html);
      }

      /* TELEGRAM WEBHOOK */

      if (
        req.method === "POST" &&
        req.url ===
          "/telegram-webhook"
      ) {
        const update =
          await readBody(req);

        await bot.handleUpdate(
          update
        );

        return sendJSON(
          res,
          200,
          {
            ok: true
          }
        );
      }

      /* ALL CARDS */

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

        return sendJSON(
          res,
          200,
          {
            cards:
              result.rows.map(
                row => ({
                  cardNumber:
                    row.card_number,
                  card:
                    row.card
                })
              )
          }
        );
      }

      /* MY CARD */

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
              ON c.card_number =
                 p.card_number
            WHERE p.user_id = $1
            `,
            [user.id]
          );

        if (
          playerResult.rowCount === 0
        ) {
          return sendJSON(
            res,
            404,
            {
              error:
                "Player not found."
            }
          );
        }

        const player =
          playerResult.rows[0];

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

        const game =
          gameResult.rows[0];

        return sendJSON(
          res,
          200,
          {
            userId:
              player.user_id,
            name:
              player.name,
            cardNumber:
              player.card_number,
            card:
              player.card,
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
          }
        );
      }

      /* SELECT CARD */

      if (
        req.method === "POST" &&
        req.url ===
          "/api/select-card"
      ) {
        const body =
          await readBody(req);

        const initData =
          getInitDataFromRequest(
            req,
            body
          );

        const user =
          validateTelegramInitData(
            initData
          );

        const cardNumber =
          Number(
            body.cardNumber
          );

        if (
          !Number.isInteger(
            cardNumber
          ) ||
          cardNumber < 1 ||
          cardNumber > 100
        ) {
          return sendJSON(
            res,
            400,
            {
              error:
                "Card number must be between 1 and 100."
            }
          );
        }

        const cardResult =
          await pool.query(
            `
            SELECT card_number
            FROM bingo_cards
            WHERE card_number = $1
            `,
            [cardNumber]
          );

        if (
          cardResult.rowCount === 0
        ) {
          return sendJSON(
            res,
            404,
            {
              error:
                "Card not found."
            }
          );
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
            (
              $1,
              $2,
              $3,
              '[]'::jsonb
            )
          ON CONFLICT (user_id)
          DO UPDATE SET
            name =
              EXCLUDED.name,
            card_number =
              EXCLUDED.card_number,
            marked_numbers =
              '[]'::jsonb
          `,
          [
            user.id,
            user.first_name ||
              user.username ||
              "Player",
            cardNumber
          ]
        );

        return sendJSON(
          res,
          200,
          {
            success: true,
            cardNumber
          }
        );
      }

      /* MARK NUMBER */

      if (
        req.method === "POST" &&
        req.url === "/api/mark"
      ) {
        const body =
          await readBody(req);

        const user =
          validateTelegramInitData(
            getInitDataFromRequest(
              req,
              body
            )
          );

        const number =
          Number(
            body.number
          );

        if (
          !Number.isInteger(number) ||
          number < 1 ||
          number > 75
        ) {
          return sendJSON(
            res,
            400,
            {
              error:
                "Invalid Bingo number."
            }
          );
        }

        const gameResult =
          await pool.query(`
            SELECT called_numbers
            FROM game_state
            WHERE id = 1
          `);

        const called =
          gameResult.rows[0]
            .called_numbers || [];

        if (
          !called.includes(number)
        ) {
          return sendJSON(
            res,
            400,
            {
              error:
                "This number has not been called yet."
            }
          );
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
          return sendJSON(
            res,
            404,
            {
              error:
                "Player not found."
            }
          );
        }

        let marked =
          playerResult.rows[0]
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
            JSON.stringify(marked),
            user.id
          ]
        );

        return sendJSON(
          res,
          200,
          {
            success: true,
            markedNumbers:
              marked
          }
        );
      }

      /* UNMARK */

      if (
        req.method === "POST" &&
        req.url === "/api/unmark"
      ) {
        const body =
          await readBody(req);

        const user =
          validateTelegramInitData(
            getInitDataFromRequest(
              req,
              body
            )
          );

        const number =
          Number(
            body.number
          );

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
          return sendJSON(
            res,
            404,
            {
              error:
                "Player not found."
            }
          );
        }

        let marked =
          playerResult.rows[0]
            .marked_numbers || [];

        marked =
          marked.filter(
            n =>
              Number(n) !==
              number
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

        return sendJSON(
          res,
          200,
          {
            success: true,
            markedNumbers:
              marked
          }
        );
      }

      /* BINGO */

      if (
        req.method === "POST" &&
        req.url ===
          "/api/bingo"
      ) {
        const body =
          await readBody(req);

        const user =
          validateTelegramInitData(
            getInitDataFromRequest(
              req,
              body
            )
          );

        const client =
          await pool.connect();

        try {
          await client.query(
            "BEGIN"
          );

          const gameResult =
            await client.query(`
              SELECT *
              FROM game_state
              WHERE id = 1
              FOR UPDATE
            `);

          const game =
            gameResult.rows[0];

          if (
            game.winner_user_id
          ) {
            await client.query(
              "ROLLBACK"
            );

            return sendJSON(
              res,
              200,
              {
                success: false,
                message:
                  "There is already a winner."
              }
            );
          }

          const playerResult =
            await client.query(
              `
              SELECT
                p.user_id,
                p.name,
                p.marked_numbers,
                c.card
              FROM players p
              JOIN bingo_cards c
                ON c.card_number =
                   p.card_number
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

            return sendJSON(
              res,
              404,
              {
                error:
                  "Player/card not found."
              }
            );
          }

          const player =
            playerResult.rows[0];

          const marked =
            player.marked_numbers || [];

          const card =
            player.card;

          const markedSet =
            new Set(
              marked.map(Number)
            );

          let bingo = false;

          /* ROWS */

          for (
            let row = 0;
            row < 5;
            row++
          ) {
            let complete = true;

            for (
              let col = 0;
              col < 5;
              col++
            ) {
              if (
                row === 2 &&
                col === 2
              ) {
                continue;
              }

              const value =
                Number(
                  card[row][col]
                );

              if (
                !markedSet.has(
                  value
                )
              ) {
                complete = false;
                break;
              }
            }

            if (complete) {
              bingo = true;
              break;
            }
          }

          /* COLUMNS */

          if (!bingo) {
            for (
              let col = 0;
              col < 5;
              col++
            ) {
              let complete = true;

              for (
                let row = 0;
                row < 5;
                row++
              ) {
                if (
                  row === 2 &&
                  col === 2
                ) {
                  continue;
                }

                const value =
                  Number(
                    card[row][col]
                  );

                if (
                  !markedSet.has(
                    value
                  )
                ) {
                  complete = false;
                  break;
                }
              }

              if (complete) {
                bingo = true;
                break;
              }
            }
          }

          if (!bingo) {
            await client.query(
              "ROLLBACK"
            );

            return sendJSON(
              res,
              200,
              {
                success: false,
                message:
                  "Bingo is not complete."
              }
            );
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

          return sendJSON(
            res,
            200,
            {
              success: true,
              winner: true,
              message:
                `BINGO! Congratulations ${player.name}!`
            }
          );

        } catch (error) {
          await client.query(
            "ROLLBACK"
          );

          throw error;

        } finally {
          client.release();
        }
      }

      /* NOT FOUND */

      return sendJSON(
        res,
        404,
        {
          error:
            "Not found."
        }
      );

    } catch (error) {
      console.error(
        "REQUEST ERROR:",
        error
      );

      return sendJSON(
        res,
        500,
        {
          error:
            error.message ||
            "Internal server error."
        }
      );
    }
  }
);

/* =========================================================
   START
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
