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

const MINIAPP_URL =
  `${RENDER_URL}/miniapp`;

const MINIAPP_FILE =
  path.join(__dirname, "miniapp", "index.html");

const CALL_INTERVAL = 3000;
const NEW_GAME_DELAY = 5000;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}


/* =========================
   DATABASE
========================= */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


/* =========================
   TELEGRAM BOT
========================= */

const bot = new Telegraf(BOT_TOKEN);


/* =========================
   BINGO CARD GENERATOR
========================= */

function randomNumbers(min, max, count) {

  const numbers = [];

  for (let i = min; i <= max; i++) {
    numbers.push(i);
  }

  for (let i = numbers.length - 1; i > 0; i--) {

    const j =
      Math.floor(Math.random() * (i + 1));

    [
      numbers[i],
      numbers[j]
    ] = [
      numbers[j],
      numbers[i]
    ];
  }

  return numbers.slice(0, count);
}


function generateCard() {

  const B = randomNumbers(1, 15, 5);
  const I = randomNumbers(16, 30, 5);
  const N = randomNumbers(31, 45, 5);
  const G = randomNumbers(46, 60, 5);
  const O = randomNumbers(61, 75, 5);

  const board = [];

  for (let row = 0; row < 5; row++) {

    board.push([
      B[row],
      I[row],
      row === 2 ? "FREE" : N[row],
      G[row],
      O[row]
    ]);
  }

  return board;
}


/* =========================
   DATABASE INITIALIZATION
========================= */

async function initDatabase() {

  console.log("Initializing database...");


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
      marked_numbers JSONB DEFAULT '[]'::jsonb,
      card_game_id BIGINT
    )
  `);


  await pool.query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS card_game_id BIGINT
  `);


  await pool.query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS marked_numbers JSONB
  `);


  await pool.query(`
    DROP INDEX IF EXISTS players_card_number_unique
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
      game_id BIGINT,
      status TEXT,
      called_numbers JSONB DEFAULT '[]'::jsonb,
      current_number INTEGER,
      started_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ,
      winner_user_id BIGINT,
      winner_name TEXT,
      winner_card_number INTEGER
    )
  `);


  await pool.query(`
    ALTER TABLE game_state
    ADD COLUMN IF NOT EXISTS winner_user_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE game_state
    ADD COLUMN IF NOT EXISTS winner_name TEXT
  `);

  await pool.query(`
    ALTER TABLE game_state
    ADD COLUMN IF NOT EXISTS winner_card_number INTEGER
  `);


  const existing =
    await pool.query(`
      SELECT id
      FROM game_state
      WHERE id = 1
    `);


  if (existing.rows.length === 0) {

    await pool.query(`
      INSERT INTO game_state
      (
        id,
        game_id,
        status,
        called_numbers,
        current_number,
        started_at,
        updated_at,
        winner_user_id,
        winner_name,
        winner_card_number
      )
      VALUES
      (
        1,
        0,
        'waiting',
        '[]'::jsonb,
        NULL,
        NULL,
        NOW(),
        NULL,
        NULL,
        NULL
      )
    `);
  }


  /*
   * Remove old reservations that do not have
   * a valid game ID.
   */
  await pool.query(`
    UPDATE players
    SET
      card_number = NULL,
      card_game_id = NULL,
      marked_numbers = '[]'::jsonb
    WHERE
      card_number IS NOT NULL
      AND card_game_id IS NULL
  `);


  await generatePermanentCards();

  console.log("Database ready.");
}


/* =========================
   PERMANENT CARDS 1-100
========================= */

async function generatePermanentCards() {

  for (
    let cardNumber = 1;
    cardNumber <= 100;
    cardNumber++
  ) {

    const existing =
      await pool.query(
        `
        SELECT card_number
        FROM bingo_cards
        WHERE card_number = $1
        `,
        [cardNumber]
      );


    /*
     * NEVER replace an existing card.
     */
    if (existing.rows.length > 0) {
      continue;
    }


    let board;
    let unique = false;


    while (!unique) {

      board = generateCard();


      const check =
        await pool.query(
          `
          SELECT card_number
          FROM bingo_cards
          WHERE board = $1::jsonb
          `,
          [JSON.stringify(board)]
        );


      if (check.rows.length === 0) {
        unique = true;
      }
    }


    await pool.query(
      `
      INSERT INTO bingo_cards
      (
        card_number,
        board
      )
      VALUES
      (
        $1,
        $2::jsonb
      )
      `,
      [
        cardNumber,
        JSON.stringify(board)
      ]
    );
  }


  console.log(
    "Permanent cards 1-100 ready."
  );
}


/* =========================
   TELEGRAM INIT DATA
========================= */

function validateInitData(initData) {

  if (!initData) {
    return null;
  }


  try {

    const params =
      new URLSearchParams(initData);

    const hash =
      params.get("hash");


    if (!hash) {
      return null;
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


    if (calculatedHash !== hash) {
      return null;
    }


    const userString =
      params.get("user");


    if (!userString) {
      return null;
    }


    return JSON.parse(userString);

  } catch (error) {

    console.error(
      "InitData validation error:",
      error
    );

    return null;
  }
}


/* =========================
   PLAYER REGISTRATION
========================= */

async function registerPlayer(user) {

  if (!user) {
    return;
  }


  const name =
    [
      user.first_name,
      user.last_name
    ]
      .filter(Boolean)
      .join(" ")
      .trim() ||
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
    (
      $1,
      $2
    )
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
   BOT MENU
========================= */

bot.start(async (ctx) => {

  try {
    await registerPlayer(ctx.from);
  } catch (error) {
    console.error(error);
  }


  await ctx.reply(
    "🎱 Welcome to Bingo!\n\nChoose an option:",
    {
      reply_markup: {
        keyboard: [
          [{ text: "▶️ Start" }],
          [{ text: "🎮 Play" }],
          [{ text: "💰 Deposit" }],
          [{ text: "💵 Balance" }],
          [{ text: "🏧 Withdraw" }],
          [{ text: "❓ HIW" }],
          [{ text: "👥 Invite" }],
          [{ text: "🆘 Support" }]
        ],
        resize_keyboard: true
      }
    }
  );
});


bot.hears(
  "▶️ Start",
  async (ctx) => {

    await ctx.reply(
      "🎱 Welcome!\n\nPress 🎮 Play to choose your Bingo card."
    );
  }
);


bot.hears(
  "🎮 Play",
  async (ctx) => {

    await ctx.reply(
      "🎮 Open Bingo:",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎱 PLAY BINGO",
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
);


bot.hears(
  "💰 Deposit",
  async (ctx) => {

    await ctx.reply(
      "💰 Deposit feature will be added later."
    );
  }
);


bot.hears(
  "💵 Balance",
  async (ctx) => {

    await ctx.reply(
      "💵 Balance feature will be added later."
    );
  }
);


bot.hears(
  "🏧 Withdraw",
  async (ctx) => {

    await ctx.reply(
      "🏧 Withdraw feature will be added later."
    );
  }
);


bot.hears(
  "❓ HIW",
  async (ctx) => {

    await ctx.reply(
      "❓ HOW TO PLAY\n\n" +
      "1. Press Play.\n" +
      "2. Choose a card number from 1-100.\n" +
      "3. Each number has its own permanent Bingo board.\n" +
      "4. Called numbers can be marked.\n" +
      "5. Complete a valid Bingo line.\n" +
      "6. Press BINGO.\n\n" +
      "Only one player can use each card number during one game."
    );
  }
);


bot.hears(
  "👥 Invite",
  async (ctx) => {

    await ctx.reply(
      "👥 Invite your friends and play Bingo together!"
    );
  }
);


bot.hears(
  "🆘 Support",
  async (ctx) => {

    await ctx.reply(
      "🆘 Support\n\nPlease contact the bot administrator."
    );
  }
);


/* =========================
   GAME STATE
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
        updated_at,
        winner_user_id,
        winner_name,
        winner_card_number
      FROM game_state
      WHERE id = 1
    `);


  if (result.rows.length === 0) {
    return null;
  }


  const row =
    result.rows[0];


  return {

    gameId:
      Number(row.game_id || 0),

    status:
      row.status || "waiting",

    calledNumbers:
      Array.isArray(row.called_numbers)
        ? row.called_numbers.map(Number)
        : [],

    currentNumber:
      row.current_number !== null &&
      row.current_number !== undefined
        ? Number(row.current_number)
        : null,

    startedAt:
      row.started_at,

    updatedAt:
      row.updated_at,

    winnerUserId:
      row.winner_user_id !== null &&
      row.winner_user_id !== undefined
        ? String(row.winner_user_id)
        : null,

    winnerName:
      row.winner_name || null,

    winnerCardNumber:
      row.winner_card_number !== null &&
      row.winner_card_number !== undefined
        ? Number(row.winner_card_number)
        : null
  };
}


/* =========================
   START NEW GAME
========================= */

async function startNewGame() {

  const client =
    await pool.connect();


  try {

    await client.query("BEGIN");


    const state =
      await client.query(`
        SELECT game_id
        FROM game_state
        WHERE id = 1
        FOR UPDATE
      `);


    const oldGameId =
      Number(
        state.rows[0]?.game_id || 0
      );


    const newGameId =
      oldGameId + 1;


    /*
     * Release all player card reservations.
     *
     * Permanent boards in bingo_cards are NOT changed.
     */
    await client.query(`
      UPDATE players
      SET
        card_number = NULL,
        card_game_id = NULL,
        marked_numbers = '[]'::jsonb
    `);


    await client.query(`
      UPDATE game_state
      SET
        game_id = $1,
        status = 'playing',
        called_numbers = '[]'::jsonb,
        current_number = NULL,
        started_at = NOW(),
        updated_at = NOW(),
        winner_user_id = NULL,
        winner_name = NULL,
        winner_card_number = NULL
      WHERE id = 1
    `, [newGameId]);


    await client.query("COMMIT");


    console.log(
      `New Bingo game started: ${newGameId}`
    );


    return newGameId;

  } catch (error) {

    await client.query("ROLLBACK");

    console.error(
      "startNewGame error:",
      error
    );

    throw error;

  } finally {

    client.release();
  }
}


/* =========================
   FINISH GAME
========================= */

async function finishGame(
  winnerUserId,
  winnerName,
  winnerCardNumber
) {

  const client =
    await pool.connect();


  try {

    await client.query("BEGIN");


    const result =
      await client.query(`
        UPDATE game_state
        SET
          status = 'finished',
          winner_user_id = $1,
          winner_name = $2,
          winner_card_number = $3,
          updated_at = NOW()
        WHERE
          id = 1
          AND status = 'playing'
        RETURNING game_id
      `,
      [
        winnerUserId,
        winnerName,
        winnerCardNumber
      ]);


    await client.query("COMMIT");


    if (result.rows.length === 0) {
      return false;
    }


    const finishedGameId =
      Number(
        result.rows[0].game_id
      );


    console.log(
      `Game ${finishedGameId} finished. Winner: ${winnerName}, card #${winnerCardNumber}`
    );


    setTimeout(
      async () => {

        try {

          const state =
            await getGameState();


          if (
            state &&
            state.gameId === finishedGameId &&
            state.status === "finished"
          ) {

            await startNewGame();
          }

        } catch (error) {

          console.error(
            "Delayed new game error:",
            error
          );
        }

      },
      NEW_GAME_DELAY
    );


    return true;

  } catch (error) {

    await client.query("ROLLBACK");

    console.error(
      "finishGame error:",
      error
    );

    throw error;

  } finally {

    client.release();
  }
}


/* =========================
   CALL NEXT NUMBER
========================= */

async function callNextNumber() {

  const client =
    await pool.connect();


  try {

    await client.query("BEGIN");


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


    if (result.rows.length === 0) {

      await client.query("COMMIT");
      return;
    }


    const row =
      result.rows[0];


    if (row.status !== "playing") {

      await client.query("COMMIT");
      return;
    }


    const called =
      Array.isArray(row.called_numbers)
        ? row.called_numbers.map(Number)
        : [];


    const available = [];


    for (let i = 1; i <= 75; i++) {

      if (!called.includes(i)) {
        available.push(i);
      }
    }


    if (available.length === 0) {

      const gameId =
        Number(row.game_id);


      await client.query(`
        UPDATE game_state
        SET
          status = 'finished',
          winner_user_id = NULL,
          winner_name = NULL,
          winner_card_number = NULL,
          updated_at = NOW()
        WHERE id = 1
      `);


      await client.query("COMMIT");


      console.log(
        `Game ${gameId} ended: all numbers called.`
      );


      setTimeout(
        async () => {

          try {

            const state =
              await getGameState();


            if (
              state &&
              state.gameId === gameId &&
              state.status === "finished"
            ) {

              await startNewGame();
            }

          } catch (error) {

            console.error(
              "New game after all numbers error:",
              error
            );
          }

        },
        NEW_GAME_DELAY
      );


      return;
    }


    const randomIndex =
      Math.floor(
        Math.random() * available.length
      );


    const number =
      available[randomIndex];


    const newCalled =
      [
        ...called,
        number
      ];


    await client.query(`
      UPDATE game_state
      SET
        called_numbers = $1::jsonb,
        current_number = $2,
        updated_at = NOW()
      WHERE id = 1
    `,
    [
      JSON.stringify(newCalled),
      number
    ]);


    await client.query("COMMIT");


    console.log(
      `Game ${row.game_id}: called ${number}`
    );

  } catch (error) {

    await client.query("ROLLBACK");

    console.error(
      "callNextNumber error:",
      error
    );

  } finally {

    client.release();
  }
}


/* =========================
   AUTOMATIC CALLER
========================= */

async function automaticCaller() {

  try {

    const state =
      await getGameState();


    if (!state) {
      return;
    }


    if (state.status === "waiting") {

      await startNewGame();

      return;
    }


    if (state.status === "playing") {

      await callNextNumber();

      return;
    }


    if (state.status === "finished") {
      return;
    }

  } catch (error) {

    console.error(
      "Automatic caller error:",
      error
    );
  }
}


function startAutomaticCaller() {

  console.log(
    `Automatic Bingo caller started: every ${CALL_INTERVAL}ms`
  );


  setInterval(
    automaticCaller,
    CALL_INTERVAL
  );
}


/* =========================
   GET ALL PERMANENT CARDS
========================= */

async function getAllCards() {

  const result =
    await pool.query(`
      SELECT
        card_number,
        board
      FROM bingo_cards
      ORDER BY card_number
    `);


  const cards = {};


  for (const row of result.rows) {

    cards[String(row.card_number)] =
      row.board;
  }


  return cards;
}


/* =========================
   HTTP SERVER
========================= */

const server =
  http.createServer(
    async (req, res) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );


        /* =====================
           HEALTH
        ===================== */

        if (
          req.method === "GET" &&
          url.pathname === "/health"
        ) {

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


          return;
        }


        /* =====================
           MINI APP
        ===================== */

        if (
          req.method === "GET" &&
          (
            url.pathname === "/" ||
            url.pathname === "/miniapp"
          )
        ) {

          if (
            !fs.existsSync(MINIAPP_FILE)
          ) {

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


          res.writeHead(
            200,
            {
              "Content-Type":
                "text/html; charset=utf-8",
              "Cache-Control":
                "no-store, no-cache, must-revalidate"
            }
          );


          res.end(html);

          return;
        }


        /* =====================
           TELEGRAM WEBHOOK
        ===================== */

        if (
          req.method === "POST" &&
          url.pathname === "/telegram-webhook"
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
           SINGLE CARD
           
           NEW ENDPOINT
        ===================== */

        if (
          req.method === "GET" &&
          url.pathname === "/api/card"
        ) {

          const cardNumber =
            Number(
              url.searchParams.get("number")
            );


          if (
            !Number.isInteger(cardNumber) ||
            cardNumber < 1 ||
            cardNumber > 100
          ) {

            res.writeHead(
              400,
              {
                "Content-Type":
                  "application/json",
                "Cache-Control":
                  "no-store"
              }
            );


            res.end(
              JSON.stringify({
                success: false,
                message:
                  "Invalid card number. Choose 1-100."
              })
            );


            return;
          }


          const result =
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
            result.rows.length === 0
          ) {

            res.writeHead(
              404,
              {
                "Content-Type":
                  "application/json",
                "Cache-Control":
                  "no-store"
              }
            );


            res.end(
              JSON.stringify({
                success: false,
                message:
                  `Card #${cardNumber} not found.`
              })
            );


            return;
          }


          const board =
            result.rows[0].board;


          console.log(
            `Card endpoint requested: #${cardNumber}`
          );


          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json",
              "Cache-Control":
                "no-store, no-cache, must-revalidate"
            }
          );


          res.end(
            JSON.stringify({
              success: true,

              cardNumber:
                Number(
                  result.rows[0].card_number
                ),

              board
            })
          );


          return;
        }


        /* =====================
           GET ALL CARDS
        ===================== */

        if (
          req.method === "GET" &&
          url.pathname === "/api/cards"
        ) {

          const state =
            await getGameState();


          if (!state) {

            res.writeHead(
              500,
              {
                "Content-Type":
                  "application/json"
              }
            );


            res.end(
              JSON.stringify({
                success: false,
                message:
                  "Game state unavailable."
              })
            );


            return;
          }


          const cards =
            await getAllCards();


          const players =
            await pool.query(
              `
              SELECT
                user_id,
                name,
                card_number,
                card_game_id
              FROM players
              WHERE
                card_number IS NOT NULL
                AND card_game_id = $1
              `,
              [state.gameId]
            );


          const usedCards =
            players.rows.map(
              row =>
                Number(row.card_number)
            );


          const usedBy = {};


          for (const row of players.rows) {

            usedBy[
              String(row.card_number)
            ] = {

              userId:
                String(row.user_id),

              name:
                row.name || "Player"
            };
          }


          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json",
              "Cache-Control":
                "no-store, no-cache, must-revalidate"
            }
          );


          res.end(
            JSON.stringify({

              success: true,

              gameId:
                state.gameId,

              status:
                state.status,

              cards,

              usedCards,

              usedBy
            })
          );


          return;
        }


        /* =====================
           GAME STATE
        ===================== */

        if (
          req.method === "GET" &&
          url.pathname === "/api/game-state"
        ) {

          const state =
            await getGameState();


          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json",
              "Cache-Control":
                "no-store"
            }
          );


          res.end(
            JSON.stringify(
              state || {}
            )
          );


          return;
        }


        /* =====================
           MY CARD
        ===================== */

        if (
          req.method === "GET" &&
          url.pathname === "/api/my-card"
        ) {

          const initData =
            url.searchParams.get(
              "initData"
            );


          const user =
            validateInitData(
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


            res.end(
              JSON.stringify({
                success: false,
                message:
                  "Invalid Telegram data."
              })
            );


            return;
          }


          const state =
            await getGameState();


          if (!state) {

            res.writeHead(
              500,
              {
                "Content-Type":
                  "application/json"
              }
            );


            res.end(
              JSON.stringify({
                success: false,
                message:
                  "Game state unavailable."
              })
            );


            return;
          }


          const player =
            await pool.query(
              `
              SELECT
                p.card_number,
                p.card_game_id,
                p.marked_numbers,
                c.board
              FROM players p
              LEFT JOIN bingo_cards c
                ON c.card_number = p.card_number
              WHERE p.user_id = $1
              `,
              [user.id]
            );


          if (
            player.rows.length === 0 ||
            !player.rows[0].card_number ||
            Number(
              player.rows[0].card_game_id
            ) !== Number(state.gameId)
          ) {

            res.writeHead(
              200,
              {
                "Content-Type":
                  "application/json",
                "Cache-Control":
                  "no-store"
              }
            );


            res.end(
              JSON.stringify({
                success: true,
                cardNumber: null,
                gameId:
                  state.gameId
              })
            );


            return;
          }


          const row =
            player.rows[0];


          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json",
              "Cache-Control":
                "no-store"
            }
          );


          res.end(
            JSON.stringify({

              success: true,

              cardNumber:
                Number(row.card_number),

              card:
                row.board,

              board:
                row.board,

              markedNumbers:
                Array.isArray(row.marked_numbers)
                  ? row.marked_numbers.map(Number)
                  : [],

              gameId:
                state.gameId
            })
          );


          return;
        }


        /* =====================
           POST API ROUTES
        ===================== */

        if (
          req.method === "POST" &&
          (
            url.pathname === "/api/select-card" ||
            url.pathname === "/api/mark" ||
            url.pathname === "/api/unmark" ||
            url.pathname === "/api/bingo"
          )
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
                  JSON.parse(
                    body || "{}"
                  );


                const user =
                  validateInitData(
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


                  res.end(
                    JSON.stringify({
                      success: false,
                      message:
                        "Invalid Telegram data."
                    })
                  );


                  return;
                }


                await registerPlayer(user);


                /* =====================
                   SELECT CARD
                ===================== */

                if (
                  url.pathname ===
                  "/api/select-card"
                ) {

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


                    res.end(
                      JSON.stringify({
                        success: false,
                        message:
                          "Choose a card from 1 to 100."
                      })
                    );


                    return;
                  }


                  const client =
                    await pool.connect();


                  try {

                    await client.query(
                      "BEGIN"
                    );


                    const lockedState =
                      await client.query(`
                        SELECT
                          game_id,
                          status
                        FROM game_state
                        WHERE id = 1
                        FOR UPDATE
                      `);


                    if (
                      lockedState.rows.length === 0 ||
                      lockedState.rows[0].status !==
                        "playing"
                    ) {

                      await client.query(
                        "ROLLBACK"
                      );


                      res.writeHead(
                        400,
                        {
                          "Content-Type":
                            "application/json"
                        }
                      );


                      res.end(
                        JSON.stringify({
                          success: false,
                          message:
                            "Please wait for the new game."
                        })
                      );


                      return;
                    }


                    const gameId =
                      Number(
                        lockedState.rows[0]
                          .game_id
                      );


                    /*
                     * Remove reservations from
                     * older games.
                     */
                    await client.query(
                      `
                      UPDATE players
                      SET
                        card_number = NULL,
                        card_game_id = NULL,
                        marked_numbers = '[]'::jsonb
                      WHERE
                        card_number IS NOT NULL
                        AND (
                          card_game_id IS NULL
                          OR card_game_id <> $1
                        )
                      `,
                      [gameId]
                    );


                    /*
                     * Check whether selected card
                     * is already used in this game.
                     */
                    const existingCard =
                      await client.query(
                        `
                        SELECT
                          user_id,
                          name
                        FROM players
                        WHERE
                          card_number = $1
                          AND card_game_id = $2
                        FOR UPDATE
                        `,
                        [
                          cardNumber,
                          gameId
                        ]
                      );


                    if (
                      existingCard.rows.length > 0 &&
                      String(
                        existingCard.rows[0].user_id
                      ) !== String(user.id)
                    ) {

                      const takenBy =
                        existingCard.rows[0].name ||
                        "another player";


                      await client.query(
                        "ROLLBACK"
                      );


                      res.writeHead(
                        409,
                        {
                          "Content-Type":
                            "application/json"
                        }
                      );


                      res.end(
                        JSON.stringify({
                          success: false,
                          message:
                            `Card #${cardNumber} is already taken by ${takenBy}.`,
                          cardNumber,
                          takenBy
                        })
                      );


                      return;
                    }


                    /*
                     * Get permanent board.
                     */
                    const card =
                      await client.query(
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
                      card.rows.length === 0
                    ) {

                      await client.query(
                        "ROLLBACK"
                      );


                      res.writeHead(
                        404,
                        {
                          "Content-Type":
                            "application/json"
                        }
                      );


                      res.end(
                        JSON.stringify({
                          success: false,
                          message:
                            "Card not found."
                        })
                      );


                      return;
                    }


                    /*
                     * Release this user's old card
                     * from the current game.
                     */
                    await client.query(
                      `
                      UPDATE players
                      SET
                        card_number = NULL,
                        card_game_id = NULL,
                        marked_numbers = '[]'::jsonb
                      WHERE
                        user_id = $1
                        AND card_game_id = $2
                      `,
                      [
                        user.id,
                        gameId
                      ]
                    );


                    /*
                     * Reserve new card.
                     */
                    await client.query(
                      `
                      UPDATE players
                      SET
                        card_number = $1,
                        card_game_id = $2,
                        marked_numbers = '[]'::jsonb
                      WHERE user_id = $3
                      `,
                      [
                        cardNumber,
                        gameId,
                        user.id
                      ]
                    );


                    await client.query(
                      "COMMIT"
                    );


                    console.log(
                      `Game ${gameId}: user ${user.id} selected card #${cardNumber}`
                    );


                    res.writeHead(
                      200,
                      {
                        "Content-Type":
                          "application/json",
                        "Cache-Control":
                          "no-store"
                      }
                    );


                    res.end(
                      JSON.stringify({

                        success: true,

                        gameId,

                        cardNumber,

                        card:
                          card.rows[0].board,

                        board:
                          card.rows[0].board
                      })
                    );


                  } catch (error) {

                    await client.query(
                      "ROLLBACK"
                    );


                    if (
                      error.code === "23505"
                    ) {

                      res.writeHead(
                        409,
                        {
                          "Content-Type":
                            "application/json"
                        }
                      );


                      res.end(
                        JSON.stringify({
                          success: false,
                          message:
                            `Card #${cardNumber} was just taken by another player.`
                        })
                      );


                      return;
                    }


                    console.error(
                      "select-card error:",
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
                        success: false,
                        message:
                          "Could not select card."
                      })
                    );

                  } finally {

                    client.release();
                  }


                  return;
                }


                /* =====================
                   MARK
                ===================== */

                if (
                  url.pathname ===
                  "/api/mark"
                ) {

                  const number =
                    Number(data.number);


                  const state =
                    await getGameState();


                  if (
                    !state ||
                    state.status !== "playing"
                  ) {

                    res.writeHead(
                      400,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );


                    res.end(
                      JSON.stringify({
                        success: false,
                        message:
                          "Game is not active."
                      })
                    );


                    return;
                  }


                  if (
                    !state.calledNumbers.includes(
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


                    res.end(
                      JSON.stringify({
                        success: false,
                        message:
                          "This number has not been called."
                      })
                    );


                    return;
                  }


                  const result =
                    await pool.query(
                      `
                      SELECT
                        marked_numbers,
                        card_game_id
                      FROM players
                      WHERE user_id = $1
                      `,
                      [user.id]
                    );


                  if (
                    result.rows.length === 0 ||
                    Number(
                      result.rows[0].card_game_id
                    ) !== Number(state.gameId)
                  ) {

                    res.writeHead(
                      400,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );


                    res.end(
                      JSON.stringify({
                        success: false,
                        message:
                          "You do not have a card in this game."
                      })
                    );


                    return;
                  }


                  let marked =
                    result.rows[0]
                      .marked_numbers || [];


                  marked =
                    marked.map(Number);


                  if (
                    !marked.includes(number)
                  ) {

                    marked.push(number);
                  }


                  await pool.query(
                    `
                    UPDATE players
                    SET marked_numbers = $1::jsonb
                    WHERE
                      user_id = $2
                      AND card_game_id = $3
                    `,
                    [
                      JSON.stringify(marked),
                      user.id,
                      state.gameId
                    ]
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
                      success: true,
                      markedNumbers: marked
                    })
                  );


                  return;
                }


                /* =====================
                   UNMARK
                ===================== */

                if (
                  url.pathname ===
                  "/api/unmark"
                ) {

                  const state =
                    await getGameState();


                  if (
                    !state ||
                    state.status !== "playing"
                  ) {

                    res.writeHead(
                      400,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );


                    res.end(
                      JSON.stringify({
                        success: false,
                        message:
                          "Game is not active."
                      })
                    );


                    return;
                  }


                  const number =
                    Number(data.number);


                  const result =
                    await pool.query(
                      `
                      SELECT
                        marked_numbers,
                        card_game_id
                      FROM players
                      WHERE user_id = $1
                      `,
                      [user.id]
                    );


                  if (
                    result.rows.length === 0 ||
                    Number(
                      result.rows[0].card_game_id
                    ) !== Number(state.gameId)
                  ) {

                    res.writeHead(
                      400,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );


                    res.end(
                      JSON.stringify({
                        success: false,
                        message:
                          "You do not have a card in this game."
                      })
                    );


                    return;
                  }


                  let marked =
                    result.rows[0]
                      .marked_numbers || [];


                  marked =
                    marked
                      .map(Number)
                      .filter(
                        n => n !== number
                      );


                  await pool.query(
                    `
                    UPDATE players
                    SET marked_numbers = $1::jsonb
                    WHERE
                      user_id = $2
                      AND card_game_id = $3
                    `,
                    [
                      JSON.stringify(marked),
                      user.id,
                      state.gameId
                    ]
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
                      success: true,
                      markedNumbers: marked
                    })
                  );


                  return;
                }


                /* =====================
                   BINGO
                ===================== */

                if (
                  url.pathname ===
                  "/api/bingo"
                ) {

                  const state =
                    await getGameState();


                  if (
                    !state ||
                    state.status !== "playing"
                  ) {

                    res.writeHead(
                      400,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );


                    res.end(
                      JSON.stringify({
                        bingo: false,
                        message:
                          "This game has already ended."
                      })
                    );


                    return;
                  }


                  const playerResult =
                    await pool.query(
                      `
                      SELECT
                        p.name,
                        p.card_number,
                        p.card_game_id,
                        p.marked_numbers,
                        c.board
                      FROM players p
                      LEFT JOIN bingo_cards c
                        ON c.card_number = p.card_number
                      WHERE p.user_id = $1
                      `,
                      [user.id]
                    );


                  if (
                    playerResult.rows.length === 0 ||
                    !playerResult.rows[0].card_number ||
                    Number(
                      playerResult.rows[0].card_game_id
                    ) !== Number(state.gameId)
                  ) {

                    res.writeHead(
                      400,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );


                    res.end(
                      JSON.stringify({
                        bingo: false,
                        message:
                          "You have not selected a card for this game."
                      })
                    );


                    return;
                  }


                  const player =
                    playerResult.rows[0];


                  const board =
                    player.board;


                  if (
                    !Array.isArray(board) ||
                    board.length !== 5
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
                        bingo: false,
                        message:
                          "The Bingo board is invalid."
                      })
                    );


                    return;
                  }


                  const marked =
                    new Set(
                      (
                        player.marked_numbers ||
                        []
                      ).map(Number)
                    );


                  function isMarked(
                    row,
                    col
                  ) {

                    if (
                      row === 2 &&
                      col === 2
                    ) {
                      return true;
                    }


                    const value =
                      Number(
                        board[row][col]
                      );


                    return marked.has(value);
                  }


                  let valid = false;


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
                        !isMarked(
                          row,
                          col
                        )
                      ) {

                        complete = false;
                        break;
                      }
                    }


                    if (complete) {

                      valid = true;
                      break;

                    }
                  }


                  /* COLUMNS */

                  if (!valid) {

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
                          !isMarked(
                            row,
                            col
                          )
                        ) {

                          complete = false;
                          break;
                        }
                      }


                      if (complete) {

                        valid = true;
                        break;

                      }
                    }
                  }


                  /* MAIN DIAGONAL */

                  if (!valid) {

                    let complete = true;


                    for (
                      let i = 0;
                      i < 5;
                      i++
                    ) {

                      if (
                        !isMarked(
                          i,
                          i
                        )
                      ) {

                        complete = false;
                        break;
                      }
                    }


                    if (complete) {
                      valid = true;
                    }
                  }


                  /* SECOND DIAGONAL */

                  if (!valid) {

                    let complete = true;


                    for (
                      let i = 0;
                      i < 5;
                      i++
                    ) {

                      if (
                        !isMarked(
                          i,
                          4 - i
                        )
                      ) {

                        complete = false;
                        break;
                      }
                    }


                    if (complete) {
                      valid = true;
                    }
                  }


                  if (!valid) {

                    res.writeHead(
                      200,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );


                    res.end(
                      JSON.stringify({
                        bingo: false,
                        message:
                          "Bingo is not valid yet."
                      })
                    );


                    return;
                  }


                  /* VALID BINGO */

                  const winnerName =
                    player.name ||
                    user.first_name ||
                    "Player";


                  const winnerCardNumber =
                    Number(
                      player.card_number
                    );


                  const won =
                    await finishGame(
                      user.id,
                      winnerName,
                      winnerCardNumber
                    );


                  if (!won) {

                    res.writeHead(
                      409,
                      {
                        "Content-Type":
                          "application/json"
                      }
                    );


                    res.end(
                      JSON.stringify({
                        bingo: false,
                        message:
                          "Another player already won this game."
                      })
                    );


                    return;
                  }


                  console.log(
                    `WINNER: ${winnerName} - Card #${winnerCardNumber}`
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

                      bingo: true,

                      gameFinished: true,

                      winner: true,

                      winnerName,

                      winnerCardNumber,

                      message:
                        "BINGO! Your winning card is valid."
                    })
                  );


                  return;
                }

              } catch (error) {

                console.error(
                  "API error:",
                  error
                );


                if (!res.headersSent) {

                  res.writeHead(
                    500,
                    {
                      "Content-Type":
                        "application/json"
                    }
                  );


                  res.end(
                    JSON.stringify({
                      success: false,
                      message:
                        "Server error."
                    })
                  );
                }
              }

            }
          );


          return;
        }


        /* =====================
           NOT FOUND
        ===================== */

        res.writeHead(
          404,
          {
            "Content-Type":
              "application/json"
          }
        );


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


        if (!res.headersSent) {

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

async function startServer() {

  try {

    await initDatabase();


    server.listen(
      PORT,
      () => {

        console.log(
          `Server running on port ${PORT}`
        );

        console.log(
          `Mini App: ${MINIAPP_URL}`
        );
      }
    );


    try {

      await bot.telegram.setWebhook(
        `${RENDER_URL}/telegram-webhook`
      );


      console.log(
        "Telegram webhook configured."
      );

    } catch (error) {

      console.error(
        "Webhook setup error:",
        error
      );
    }


    startAutomaticCaller();

  } catch (error) {

    console.error(
      "Startup error:",
      error
    );

    process.exit(1);
  }
}


startServer();
