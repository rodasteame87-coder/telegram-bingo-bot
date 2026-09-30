const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const MINIAPP_URL = process.env.MINIAPP_URL;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

if (!MINIAPP_URL) {
  console.error("MINIAPP_URL is missing");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ============================================================
// GAME SETTINGS
// ============================================================

const CALL_INTERVAL = 3000;
const NEW_GAME_DELAY = 5000;

let callerTimer = null;
let startingNewGame = false;

// ============================================================
// HELPERS
// ============================================================

function sendJson(res, data, status = 200) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function normalizeBoard(board) {
  let value = board;

  // Sometimes PostgreSQL/client data can arrive as a JSON string.
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (e) {
      return null;
    }
  }

  if (!Array.isArray(value)) {
    return null;
  }

  if (value.length !== 5) {
    return null;
  }

  const normalized = [];

  for (let r = 0; r < 5; r++) {
    if (!Array.isArray(value[r]) || value[r].length !== 5) {
      return null;
    }

    const row = [];

    for (let c = 0; c < 5; c++) {
      let cell = value[r][c];

      if (typeof cell === "string") {
        const upper = cell.toUpperCase();

        if (upper === "FREE") {
          cell = "FREE";
        } else if (!isNaN(Number(cell))) {
          cell = Number(cell);
        }
      }

      row.push(cell);
    }

    normalized.push(row);
  }

  return normalized;
}

function generateColumnNumbers(min, max) {
  const numbers = [];

  for (let i = min; i <= max; i++) {
    numbers.push(i);
  }

  return numbers;
}

function shuffle(array) {
  const arr = [...array];

  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }

  return arr;
}

function generateBingoBoard() {
  const B = shuffle(generateColumnNumbers(1, 15)).slice(0, 5);
  const I = shuffle(generateColumnNumbers(16, 30)).slice(0, 5);
  const N = shuffle(generateColumnNumbers(31, 45)).slice(0, 5);
  const G = shuffle(generateColumnNumbers(46, 60)).slice(0, 5);
  const O = shuffle(generateColumnNumbers(61, 75)).slice(0, 5);

  return [
    [B[0], I[0], N[0], G[0], O[0]],
    [B[1], I[1], N[1], G[1], O[1]],
    [B[2], I[2], "FREE", G[2], O[2]],
    [B[3], I[3], N[3], G[3], O[3]],
    [B[4], I[4], N[4], G[4], O[4]]
  ];
}

function boardIsValid(board) {
  const b = normalizeBoard(board);

  if (!b) return false;

  const ranges = [
    [1, 15],
    [16, 30],
    [31, 45],
    [46, 60],
    [61, 75]
  ];

  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (r === 2 && c === 2) {
        if (b[r][c] !== "FREE") {
          return false;
        }

        continue;
      }

      const value = Number(b[r][c]);

      if (!Number.isInteger(value)) {
        return false;
      }

      const [min, max] = ranges[c];

      if (value < min || value > max) {
        return false;
      }
    }
  }

  return true;
}

// ============================================================
// DATABASE SETUP
// ============================================================

async function setupDatabase() {
  console.log("Setting up database...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      user_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      card_number INTEGER,
      card_game_id BIGINT,
      marked_numbers JSONB DEFAULT '[]'::jsonb
    )
  `);

  await pool.query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS card_number INTEGER
  `);

  await pool.query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS card_game_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS marked_numbers JSONB DEFAULT '[]'::jsonb
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bingo_cards (
      card_number INTEGER PRIMARY KEY,
      board JSONB NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_state (
      id INTEGER PRIMARY KEY,
      game_id BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'playing',
      called_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
      winner_user_id BIGINT,
      winner_name TEXT,
      winner_card_number INTEGER
    )
  `);

  await pool.query(`
    ALTER TABLE game_state
    ADD COLUMN IF NOT EXISTS winner_card_number INTEGER
  `);

  // Remove old/stale card reservations.
  await pool.query(`
    UPDATE players
    SET card_number = NULL,
        card_game_id = NULL,
        marked_numbers = '[]'::jsonb
    WHERE card_game_id IS NULL
  `);

  // Make sure we have exactly the permanent 1-100 cards.
  for (let cardNumber = 1; cardNumber <= 100; cardNumber++) {
    const existing = await pool.query(
      `
      SELECT board
      FROM bingo_cards
      WHERE card_number = $1
      `,
      [cardNumber]
    );

    if (existing.rows.length === 0) {
      const board = generateBingoBoard();

      await pool.query(
        `
        INSERT INTO bingo_cards(card_number, board)
        VALUES($1, $2::jsonb)
        `,
        [cardNumber, JSON.stringify(board)]
      );

      console.log(`Created permanent Bingo card #${cardNumber}`);
    } else {
      const board = normalizeBoard(existing.rows[0].board);

      if (!boardIsValid(board)) {
        console.error(
          `WARNING: Bingo card #${cardNumber} has an invalid board in database.`
        );
      }
    }
  }

  const game = await pool.query(`
    SELECT *
    FROM game_state
    WHERE id = 1
  `);

  if (game.rows.length === 0) {
    await pool.query(`
      INSERT INTO game_state(
        id,
        game_id,
        status,
        called_numbers,
        winner_user_id,
        winner_name,
        winner_card_number
      )
      VALUES(
        1,
        1,
        'playing',
        '[]'::jsonb,
        NULL,
        NULL,
        NULL
      )
    `);

    console.log("Created first Bingo game.");
  }

  // Current-game card uniqueness.
  await pool.query(`
    DROP INDEX IF EXISTS players_card_number_unique
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS players_card_number_unique
    ON players(card_number)
    WHERE card_number IS NOT NULL
  `);

  console.log("Database ready.");
}

// ============================================================
// GAME STATE
// ============================================================

async function getGame() {
  const result = await pool.query(`
    SELECT *
    FROM game_state
    WHERE id = 1
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

async function startNewGame() {
  if (startingNewGame) return;

  startingNewGame = true;

  try {
    const current = await getGame();

    const nextGameId = Number(current.game_id) + 1;

    // Release every card reservation.
    await pool.query(`
      UPDATE players
      SET card_number = NULL,
          card_game_id = NULL,
          marked_numbers = '[]'::jsonb
    `);

    await pool.query(
      `
      UPDATE game_state
      SET
        game_id = $1,
        status = 'playing',
        called_numbers = '[]'::jsonb,
        winner_user_id = NULL,
        winner_name = NULL,
        winner_card_number = NULL
      WHERE id = 1
      `,
      [nextGameId]
    );

    console.log(`New game started: Game ${nextGameId}`);
  } catch (error) {
    console.error("startNewGame error:", error);
  } finally {
    startingNewGame = false;
  }
}

async function finishGame(
  winnerUserId,
  winnerName,
  winnerCardNumber
) {
  try {
    const game = await getGame();

    if (!game || game.status !== "playing") {
      return;
    }

    await pool.query(
      `
      UPDATE game_state
      SET
        status = 'finished',
        winner_user_id = $1,
        winner_name = $2,
        winner_card_number = $3
      WHERE id = 1
      `,
      [
        winnerUserId,
        winnerName || "Player",
        winnerCardNumber
      ]
    );

    console.log(
      `Game ${game.game_id} finished. Winner: ${winnerName} - Card #${winnerCardNumber}`
    );

    setTimeout(async () => {
      await startNewGame();
    }, NEW_GAME_DELAY);
  } catch (error) {
    console.error("finishGame error:", error);
  }
}

// ============================================================
// AUTOMATIC NUMBER CALLER
// ============================================================

async function callNextNumber() {
  try {
    const game = await getGame();

    if (!game) return;

    if (game.status !== "playing") {
      return;
    }

    let called = game.called_numbers || [];

    if (typeof called === "string") {
      try {
        called = JSON.parse(called);
      } catch {
        called = [];
      }
    }

    if (!Array.isArray(called)) {
      called = [];
    }

    if (called.length >= 75) {
      console.log(`Game ${game.game_id}: all 75 numbers called.`);
      return;
    }

    const available = [];

    for (let n = 1; n <= 75; n++) {
      if (!called.includes(n)) {
        available.push(n);
      }
    }

    if (available.length === 0) return;

    const next =
      available[Math.floor(Math.random() * available.length)];

    called.push(next);

    await pool.query(
      `
      UPDATE game_state
      SET called_numbers = $1::jsonb
      WHERE id = 1
      `,
      [JSON.stringify(called)]
    );

    console.log(`Game ${game.game_id}: called ${next}`);
  } catch (error) {
    console.error("Number caller error:", error);
  }
}

function startCaller() {
  if (callerTimer) {
    clearInterval(callerTimer);
  }

  callerTimer = setInterval(async () => {
    const game = await getGame();

    if (!game) return;

    if (game.status === "playing") {
      await callNextNumber();
    }
  }, CALL_INTERVAL);

  console.log(`Automatic caller started: every ${CALL_INTERVAL} ms`);
}

// ============================================================
// GET ALL PERMANENT CARDS
// ============================================================

async function getAllCards() {
  const result = await pool.query(`
    SELECT card_number, board
    FROM bingo_cards
    ORDER BY card_number ASC
  `);

  const cardsObject = {};
  const cardsArray = [];

  for (const row of result.rows) {
    const cardNumber = Number(row.card_number);
    const board = normalizeBoard(row.board);

    if (!board) {
      console.error(
        `Invalid board returned from database for card #${cardNumber}`
      );
      continue;
    }

    cardsObject[String(cardNumber)] = board;

    cardsArray.push({
      card_number: cardNumber,
      board: board
    });
  }

  return {
    object: cardsObject,
    array: cardsArray
  };
}

// ============================================================
// MINI APP
// ============================================================

app.get("/", (req, res) => {
  res.send("Telegram Bingo Bot is running.");
});

app.get("/miniapp", (req, res) => {
  res.sendFile(__dirname + "/miniapp/index.html");
});

// ============================================================
// /api/cards
//
// IMPORTANT:
// Returns BOTH:
//   cards      -> array
//   cardsByNumber -> object
//
// This makes the endpoint compatible with different Mini App
// versions.
// ============================================================

app.get("/api/cards", async (req, res) => {
  try {
    const game = await getGame();

    const allCards = await getAllCards();

    const usedResult = await pool.query(`
      SELECT
        p.card_number,
        p.user_id,
        p.username,
        p.first_name
      FROM players p
      WHERE p.card_number IS NOT NULL
        AND p.card_game_id = $1
      ORDER BY p.card_number
    `, [game.game_id]);

    const usedCards = [];
    const usedBy = {};

    for (const row of usedResult.rows) {
      const cardNumber = Number(row.card_number);

      usedCards.push(cardNumber);

      usedBy[String(cardNumber)] = {
        userId: String(row.user_id),
        username: row.username || "",
        firstName: row.first_name || ""
      };
    }

    return sendJson(res, {
      success: true,

      // ARRAY — easiest format for Mini App.
      cards: allCards.array,

      // OBJECT — also supplied for compatibility.
      cardsByNumber: allCards.object,

      usedCards,
      usedBy,

      gameId: Number(game.game_id),
      status: game.status,

      calledNumbers: game.called_numbers || [],

      winner: game.status === "finished"
        ? {
            userId: game.winner_user_id
              ? String(game.winner_user_id)
              : null,
            name: game.winner_name || null,
            cardNumber: game.winner_card_number || null
          }
        : null
    });
  } catch (error) {
    console.error("/api/cards error:", error);

    return sendJson(
      res,
      {
        success: false,
        error: "Could not load cards.",
        details: error.message
      },
      500
    );
  }
});

// ============================================================
// DIRECT SINGLE CARD ENDPOINT
//
// Example:
// /api/card?number=32
//
// Returns ONLY card #32.
// ============================================================

app.get("/api/card", async (req, res) => {
  try {
    const number = Number(req.query.number);

    if (!Number.isInteger(number) || number < 1 || number > 100) {
      return sendJson(
        res,
        {
          success: false,
          error: "Card number must be between 1 and 100."
        },
        400
      );
    }

    const result = await pool.query(
      `
      SELECT card_number, board
      FROM bingo_cards
      WHERE card_number = $1
      `,
      [number]
    );

    if (result.rows.length === 0) {
      return sendJson(
        res,
        {
          success: false,
          error: `Card #${number} does not exist.`
        },
        404
      );
    }

    const board = normalizeBoard(result.rows[0].board);

    if (!board || !boardIsValid(board)) {
      console.error(
        `Card #${number} exists but its board is invalid.`
      );

      return sendJson(
        res,
        {
          success: false,
          error: `Card #${number} board is invalid in database.`
        },
        500
      );
    }

    const game = await getGame();

    const owner = await pool.query(
      `
      SELECT
        user_id,
        username,
        first_name
      FROM players
      WHERE card_number = $1
        AND card_game_id = $2
      LIMIT 1
      `,
      [number, game.game_id]
    );

    return sendJson(res, {
      success: true,
      cardNumber: number,
      board,

      gameId: Number(game.game_id),
      status: game.status,

      available: owner.rows.length === 0,

      takenBy:
        owner.rows.length > 0
          ? {
              userId: String(owner.rows[0].user_id),
              username: owner.rows[0].username || "",
              firstName: owner.rows[0].first_name || ""
            }
          : null
    });
  } catch (error) {
    console.error("/api/card error:", error);

    return sendJson(
      res,
      {
        success: false,
        error: "Could not load Bingo card.",
        details: error.message
      },
      500
    );
  }
});

// ============================================================
// SAVE / GET PLAYER
// ============================================================

async function savePlayer(userId, username, firstName) {
  await pool.query(
    `
    INSERT INTO players(
      user_id,
      username,
      first_name,
      marked_numbers
    )
    VALUES(
      $1,
      $2,
      $3,
      '[]'::jsonb
    )
    ON CONFLICT(user_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name
    `,
    [
      userId,
      username || "",
      firstName || ""
    ]
  );
}

// ============================================================
// SELECT CARD
// ============================================================

app.post("/api/select-card", async (req, res) => {
  try {
    const {
      userId,
      username,
      firstName,
      cardNumber
    } = req.body;

    if (!userId) {
      return sendJson(
        res,
        {
          success: false,
          error: "User ID is required."
        },
        400
      );
    }

    const number = Number(cardNumber);

    if (!Number.isInteger(number) || number < 1 || number > 100) {
      return sendJson(
        res,
        {
          success: false,
          error: "Invalid card number."
        },
        400
      );
    }

    await savePlayer(
      userId,
      username,
      firstName
    );

    const game = await getGame();

    if (!game || game.status !== "playing") {
      return sendJson(
        res,
        {
          success: false,
          error: "The game is not currently accepting cards."
        },
        400
      );
    }

    const cardResult = await pool.query(
      `
      SELECT card_number, board
      FROM bingo_cards
      WHERE card_number = $1
      `,
      [number]
    );

    if (cardResult.rows.length === 0) {
      return sendJson(
        res,
        {
          success: false,
          error: "Card does not exist."
        },
        404
      );
    }

    const board = normalizeBoard(cardResult.rows[0].board);

    if (!board || !boardIsValid(board)) {
      return sendJson(
        res,
        {
          success: false,
          error: "Bingo card board is invalid."
        },
        500
      );
    }

    // Check whether this player already has a card.
    const existingPlayer = await pool.query(
      `
      SELECT card_number, card_game_id
      FROM players
      WHERE user_id = $1
      `,
      [userId]
    );

    if (
      existingPlayer.rows.length > 0 &&
      existingPlayer.rows[0].card_number &&
      Number(existingPlayer.rows[0].card_game_id) === Number(game.game_id)
    ) {
      if (
        Number(existingPlayer.rows[0].card_number) === number
      ) {
        return sendJson(res, {
          success: true,
          message: "You already selected this card.",
          cardNumber: number,
          board,
          gameId: Number(game.game_id)
        });
      }

      return sendJson(
        res,
        {
          success: false,
          error: "You already selected a card for this game."
        },
        400
      );
    }

    // Check if another player owns this card.
    const owner = await pool.query(
      `
      SELECT
        user_id,
        username,
        first_name
      FROM players
      WHERE card_number = $1
        AND card_game_id = $2
      LIMIT 1
      `,
      [number, game.game_id]
    );

    if (owner.rows.length > 0) {
      return sendJson(
        res,
        {
          success: false,
          error: "This card is already taken."
        },
        409
      );
    }

    try {
      await pool.query(
        `
        UPDATE players
        SET
          card_number = $1,
          card_game_id = $2,
          marked_numbers = '[]'::jsonb
        WHERE user_id = $3
        `,
        [
          number,
          game.game_id,
          userId
        ]
      );
    } catch (error) {
      // Unique index can catch simultaneous selections.
      if (error.code === "23505") {
        return sendJson(
          res,
          {
            success: false,
            error: "This card was just taken by another player."
          },
          409
        );
      }

      throw error;
    }

    console.log(
      `Game ${game.game_id}: user ${userId} selected card #${number}`
    );

    return sendJson(res, {
      success: true,
      cardNumber: number,
      board,
      gameId: Number(game.game_id),
      message: "Card selected successfully."
    });
  } catch (error) {
    console.error("/api/select-card error:", error);

    return sendJson(
      res,
      {
        success: false,
        error: "Could not select card.",
        details: error.message
      },
      500
    );
  }
});

// ============================================================
// GET MY CARD
// ============================================================

app.get("/api/my-card", async (req, res) => {
  try {
    const userId = req.query.userId;

    if (!userId) {
      return sendJson(
        res,
        {
          success: false,
          error: "User ID is required."
        },
        400
      );
    }

    const game = await getGame();

    const result = await pool.query(
      `
      SELECT
        p.user_id,
        p.card_number,
        p.card_game_id,
        p.marked_numbers,
        b.board
      FROM players p
      LEFT JOIN bingo_cards b
        ON b.card_number = p.card_number
      WHERE p.user_id = $1
      `,
      [userId]
    );

    if (
      result.rows.length === 0 ||
      !result.rows[0].card_number ||
      Number(result.rows[0].card_game_id) !== Number(game.game_id)
    ) {
      return sendJson(res, {
        success: true,
        hasCard: false,
        gameId: Number(game.game_id)
      });
    }

    const row = result.rows[0];

    const board = normalizeBoard(row.board);

    if (!board || !boardIsValid(board)) {
      return sendJson(
        res,
        {
          success: false,
          error: "Your Bingo card board could not be loaded."
        },
        500
      );
    }

    let markedNumbers = row.marked_numbers || [];

    if (typeof markedNumbers === "string") {
      try {
        markedNumbers = JSON.parse(markedNumbers);
      } catch {
        markedNumbers = [];
      }
    }

    if (!Array.isArray(markedNumbers)) {
      markedNumbers = [];
    }

    return sendJson(res, {
      success: true,
      hasCard: true,
      cardNumber: Number(row.card_number),
      board,
      markedNumbers,
      gameId: Number(game.game_id),
      status: game.status,
      calledNumbers: game.called_numbers || []
    });
  } catch (error) {
    console.error("/api/my-card error:", error);

    return sendJson(
      res,
      {
        success: false,
        error: "Could not load your card.",
        details: error.message
      },
      500
    );
  }
});

// ============================================================
// MARK NUMBER
// ============================================================

app.post("/api/mark", async (req, res) => {
  try {
    const {
      userId,
      number
    } = req.body;

    const game = await getGame();

    if (!game || game.status !== "playing") {
      return sendJson(
        res,
        {
          success: false,
          error: "Game is not playing."
        },
        400
      );
    }

    const player = await pool.query(
      `
      SELECT
        card_number,
        card_game_id,
        marked_numbers
      FROM players
      WHERE user_id = $1
      `,
      [userId]
    );

    if (
      player.rows.length === 0 ||
      !player.rows[0].card_number ||
      Number(player.rows[0].card_game_id) !== Number(game.game_id)
    ) {
      return sendJson(
        res,
        {
          success: false,
          error: "You do not have a card in this game."
        },
        400
      );
    }

    const n = Number(number);

    const called = game.called_numbers || [];

    if (!called.includes(n)) {
      return sendJson(
        res,
        {
          success: false,
          error: "That number has not been called yet."
        },
        400
      );
    }

    let marked = player.rows[0].marked_numbers || [];

    if (typeof marked === "string") {
      try {
        marked = JSON.parse(marked);
      } catch {
        marked = [];
      }
    }

    if (!Array.isArray(marked)) {
      marked = [];
    }

    if (!marked.includes(n)) {
      marked.push(n);
    }

    await pool.query(
      `
      UPDATE players
      SET marked_numbers = $1::jsonb
      WHERE user_id = $2
      `,
      [
        JSON.stringify(marked),
        userId
      ]
    );

    return sendJson(res, {
      success: true,
      markedNumbers: marked
    });
  } catch (error) {
    console.error("/api/mark error:", error);

    return sendJson(
      res,
      {
        success: false,
        error: "Could not mark number."
      },
      500
    );
  }
});

// ============================================================
// UNMARK NUMBER
// ============================================================

app.post("/api/unmark", async (req, res) => {
  try {
    const {
      userId,
      number
    } = req.body;

    const player = await pool.query(
      `
      SELECT marked_numbers
      FROM players
      WHERE user_id = $1
      `,
      [userId]
    );

    if (player.rows.length === 0) {
      return sendJson(
        res,
        {
          success: false,
          error: "Player not found."
        },
        404
      );
    }

    let marked = player.rows[0].marked_numbers || [];

    if (typeof marked === "string") {
      try {
        marked = JSON.parse(marked);
      } catch {
        marked = [];
      }
    }

    marked = marked.filter(
      n => Number(n) !== Number(number)
    );

    await pool.query(
      `
      UPDATE players
      SET marked_numbers = $1::jsonb
      WHERE user_id = $2
      `,
      [
        JSON.stringify(marked),
        userId
      ]
    );

    return sendJson(res, {
      success: true,
      markedNumbers: marked
    });
  } catch (error) {
    console.error("/api/unmark error:", error);

    return sendJson(
      res,
      {
        success: false,
        error: "Could not unmark number."
      },
      500
    );
  }
});

// ============================================================
// BINGO VALIDATION
// ============================================================

function hasWinningLine(board, markedNumbers) {
  const marked = new Set(
    (markedNumbers || []).map(Number)
  );

  // FREE is always marked.
  const isMarked = (r, c) => {
    if (r === 2 && c === 2) {
      return true;
    }

    return marked.has(Number(board[r][c]));
  };

  // Rows
  for (let r = 0; r < 5; r++) {
    let win = true;

    for (let c = 0; c < 5; c++) {
      if (!isMarked(r, c)) {
        win = false;
        break;
      }
    }

    if (win) return true;
  }

  // Columns
  for (let c = 0; c < 5; c++) {
    let win = true;

    for (let r = 0; r < 5; r++) {
      if (!isMarked(r, c)) {
        win = false;
        break;
      }
    }

    if (win) return true;
  }

  // Main diagonal
  let diagonal1 = true;

  for (let i = 0; i < 5; i++) {
    if (!isMarked(i, i)) {
      diagonal1 = false;
      break;
    }
  }

  if (diagonal1) return true;

  // Other diagonal
  let diagonal2 = true;

  for (let i = 0; i < 5; i++) {
    if (!isMarked(i, 4 - i)) {
      diagonal2 = false;
      break;
    }
  }

  return diagonal2;
}

app.post("/api/bingo", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return sendJson(
        res,
        {
          success: false,
          error: "User ID is required."
        },
        400
      );
    }

    const game = await getGame();

    if (!game) {
      return sendJson(
        res,
        {
          success: false,
          error: "Game not found."
        },
        500
      );
    }

    if (game.status !== "playing") {
      return sendJson(res, {
        success: false,
        valid: false,
        gameOver: true,
        error: "Game is already finished."
      });
    }

    const player = await pool.query(
      `
      SELECT
        p.user_id,
        p.username,
        p.first_name,
        p.card_number,
        p.card_game_id,
        p.marked_numbers,
        b.board
      FROM players p
      LEFT JOIN bingo_cards b
        ON b.card_number = p.card_number
      WHERE p.user_id = $1
      `,
      [userId]
    );

    if (
      player.rows.length === 0 ||
      !player.rows[0].card_number ||
      Number(player.rows[0].card_game_id) !== Number(game.game_id)
    ) {
      return sendJson(
        res,
        {
          success: false,
          valid: false,
          error: "You do not have a card in this game."
        },
        400
      );
    }

    const row = player.rows[0];

    const board = normalizeBoard(row.board);

    if (!board || !boardIsValid(board)) {
      return sendJson(
        res,
        {
          success: false,
          valid: false,
          error: "Your Bingo card is invalid."
        },
        500
      );
    }

    let markedNumbers = row.marked_numbers || [];

    if (typeof markedNumbers === "string") {
      try {
        markedNumbers = JSON.parse(markedNumbers);
      } catch {
        markedNumbers = [];
      }
    }

    if (!Array.isArray(markedNumbers)) {
      markedNumbers = [];
    }

    const calledNumbers = game.called_numbers || [];

    // A player may only claim numbers that were actually called.
    const invalidMarked = markedNumbers.some(
      n => !calledNumbers.includes(Number(n))
    );

    if (invalidMarked) {
      return sendJson(res, {
        success: false,
        valid: false,
        error: "Your card contains a number that has not been called yet."
      });
    }

    const valid = hasWinningLine(
      board,
      markedNumbers
    );

    if (!valid) {
      return sendJson(res, {
        success: false,
        valid: false,
        error: "BINGO is not valid yet."
      });
    }

    const winnerName =
      row.first_name ||
      row.username ||
      "Player";

    const winnerCardNumber =
      Number(row.card_number);

    await finishGame(
      userId,
      winnerName,
      winnerCardNumber
    );

    return sendJson(res, {
      success: true,
      valid: true,
      winner: true,
      winnerName,
      winnerCardNumber,
      gameId: Number(game.game_id),
      message: "BINGO! Your winning card is valid."
    });
  } catch (error) {
    console.error("/api/bingo error:", error);

    return sendJson(
      res,
      {
        success: false,
        valid: false,
        error: "Could not verify Bingo.",
        details: error.message
      },
      500
    );
  }
});

// ============================================================
// GAME STATUS
// ============================================================

app.get("/api/game", async (req, res) => {
  try {
    const game = await getGame();

    if (!game) {
      return sendJson(
        res,
        {
          success: false,
          error: "Game not found."
        },
        500
      );
    }

    return sendJson(res, {
      success: true,
      gameId: Number(game.game_id),
      status: game.status,
      calledNumbers: game.called_numbers || [],

      winner:
        game.status === "finished"
          ? {
              userId: game.winner_user_id
                ? String(game.winner_user_id)
                : null,
              name: game.winner_name || null,
              cardNumber: game.winner_card_number || null
            }
          : null
    });
  } catch (error) {
    console.error("/api/game error:", error);

    return sendJson(
      res,
      {
        success: false,
        error: "Could not load game."
      },
      500
    );
  }
});

// ============================================================
// TELEGRAM BOT
// ============================================================

bot.start(async ctx => {
  const user = ctx.from;

  try {
    await savePlayer(
      user.id,
      user.username,
      user.first_name
    );
  } catch (error) {
    console.error("Could not save Telegram user:", error);
  }

  await ctx.reply(
    `Welcome ${user.first_name || "Player"}! 🎉\n\nChoose an option below:`,
    Markup.keyboard([
      ["▶️ Start"],
      ["🎮 Play"],
      ["💰 Deposit"],
      ["💵 Balance"],
      ["🏧 Withdraw"],
      ["❓ HIW"],
      ["📨 Invite"],
      ["🆘 Support"]
    ]).resize()
  );
});

bot.hears("▶️ Start", async ctx => {
  await ctx.reply(
    "Welcome to Bingo! 🎉\n\nPress 🎮 Play to choose your Bingo card."
  );
});

bot.hears("🎮 Play", async ctx => {
  await ctx.reply(
    "Choose your Bingo card from 1 to 100:",
    Markup.inlineKeyboard([
      [
        Markup.button.webApp(
          "🎮 Open Bingo",
          MINIAPP_URL
        )
      ]
    ])
  );
});

bot.hears("💰 Deposit", async ctx => {
  await ctx.reply(
    "Deposit feature is not connected yet."
  );
});

bot.hears("💵 Balance", async ctx => {
  await ctx.reply(
    "Balance feature is not connected yet."
  );
});

bot.hears("🏧 Withdraw", async ctx => {
  await ctx.reply(
    "Withdraw feature is not connected yet."
  );
});

bot.hears("❓ HIW", async ctx => {
  await ctx.reply(
    "How to Play:\n\n" +
    "1. Press Play.\n" +
    "2. Choose a card number from 1–100.\n" +
    "3. Press OK.\n" +
    "4. Watch the called numbers.\n" +
    "5. Mark called numbers on your card.\n" +
    "6. Complete a row, column, or diagonal.\n" +
    "7. Press BINGO."
  );
});

bot.hears("📨 Invite", async ctx => {
  await ctx.reply(
    "Invite feature is not connected yet."
  );
});

bot.hears("🆘 Support", async ctx => {
  await ctx.reply(
    "Support feature is not connected yet."
  );
});

// ============================================================
// TELEGRAM WEBHOOK
// ============================================================

app.post("/telegram-webhook", async (req, res) => {
  try {
    await bot.handleUpdate(req.body);

    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook error:", error);

    res.status(200).send("OK");
  }
});

// ============================================================
// START SERVER
// ============================================================

async function start() {
  try {
    await setupDatabase();

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    startCaller();
  } catch (error) {
    console.error("Startup error:", error);
    process.exit(1);
  }
}

start();
