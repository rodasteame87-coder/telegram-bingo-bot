const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const { Telegraf, Markup } = require("telegraf");

const app = express();

app.use(express.json());

/* =====================================================
   CONFIG
===================================================== */

const PORT = process.env.PORT || 10000;

const BOT_TOKEN =
  process.env.BOT_TOKEN;

const DATABASE_URL =
  process.env.DATABASE_URL;

const MINIAPP_URL =
  process.env.MINIAPP_URL ||
  "https://telegram-bingo-bot-q54q.onrender.com/miniapp";

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


/* =====================================================
   DATABASE
===================================================== */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


/* =====================================================
   BOT
===================================================== */

const bot =
  new Telegraf(BOT_TOKEN);


/* =====================================================
   EXPRESS
===================================================== */

app.get("/", (req, res) => {

  res.send(
    "Telegram Bingo Bot is running."
  );

});


/* =====================================================
   MINI APP
===================================================== */

app.get("/miniapp", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "miniapp",
      "index.html"
    )
  );

});


/* =====================================================
   HELPERS
===================================================== */

function normalizeBoard(board) {

  if (!board) {
    return null;
  }

  if (typeof board === "string") {

    try {
      board = JSON.parse(board);
    } catch {
      return null;
    }

  }


  /* ARRAY FORMAT */

  if (Array.isArray(board)) {

    if (board.length !== 5) {
      return null;
    }

    for (const row of board) {

      if (
        !Array.isArray(row) ||
        row.length !== 5
      ) {

        return null;

      }

    }

    return board;

  }


  /* B I N G O FORMAT */

  if (
    typeof board === "object" &&
    board !== null
  ) {

    const B = board.B;
    const I = board.I;
    const N = board.N;
    const G = board.G;
    const O = board.O;

    if (
      !Array.isArray(B) ||
      !Array.isArray(I) ||
      !Array.isArray(N) ||
      !Array.isArray(G) ||
      !Array.isArray(O)
    ) {

      return null;

    }

    if (
      B.length !== 5 ||
      I.length !== 5 ||
      N.length !== 5 ||
      G.length !== 5 ||
      O.length !== 5
    ) {

      return null;

    }

    return {

      B,
      I,
      N,
      G,
      O

    };

  }

  return null;

}


function boardToColumns(board) {

  const normalized =
    normalizeBoard(board);

  if (!normalized) {
    return null;
  }


  if (
    !Array.isArray(normalized)
  ) {

    return normalized;

  }


  return {

    B: normalized.map(row => row[0]),
    I: normalized.map(row => row[1]),
    N: normalized.map(row => row[2]),
    G: normalized.map(row => row[3]),
    O: normalized.map(row => row[4])

  };

}


function boardToRows(board) {

  const normalized =
    normalizeBoard(board);

  if (!normalized) {
    return null;
  }


  if (Array.isArray(normalized)) {
    return normalized;
  }


  return [

    [
      normalized.B[0],
      normalized.I[0],
      normalized.N[0],
      normalized.G[0],
      normalized.O[0]
    ],

    [
      normalized.B[1],
      normalized.I[1],
      normalized.N[1],
      normalized.G[1],
      normalized.O[1]
    ],

    [
      normalized.B[2],
      normalized.I[2],
      normalized.N[2],
      normalized.G[2],
      normalized.O[2]
    ],

    [
      normalized.B[3],
      normalized.I[3],
      normalized.N[3],
      normalized.G[3],
      normalized.O[3]
    ],

    [
      normalized.B[4],
      normalized.I[4],
      normalized.N[4],
      normalized.G[4],
      normalized.O[4]
    ]

  ];

}


/* =====================================================
   GENERATE BINGO CARD
===================================================== */

function randomNumbers(
  min,
  max,
  count
) {

  const numbers = [];

  for (
    let i = min;
    i <= max;
    i++
  ) {

    numbers.push(i);

  }


  for (
    let i = numbers.length - 1;
    i > 0;
    i--
  ) {

    const j =
      Math.floor(
        Math.random() * (i + 1)
      );

    [
      numbers[i],
      numbers[j]
    ] = [
      numbers[j],
      numbers[i]
    ];

  }


  return numbers.slice(
    0,
    count
  );

}


function generateBoard() {

  const B =
    randomNumbers(
      1,
      15,
      5
    );

  const I =
    randomNumbers(
      16,
      30,
      5
    );

  const N =
    randomNumbers(
      31,
      45,
      5
    );

  const G =
    randomNumbers(
      46,
      60,
      5
    );

  const O =
    randomNumbers(
      61,
      75,
      5
    );


  N[2] = "FREE";


  return {

    B,
    I,
    N,
    G,
    O

  };

}


/* =====================================================
   DATABASE SETUP
===================================================== */

async function setupDatabase() {

  console.log(
    "Setting up database..."
  );


  /* PLAYERS */

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
    ADD COLUMN IF NOT EXISTS username TEXT
  `);


  await pool.query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS first_name TEXT
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
    ADD COLUMN IF NOT EXISTS marked_numbers JSONB
  `);


  await pool.query(`
    UPDATE players
    SET marked_numbers = '[]'::jsonb
    WHERE marked_numbers IS NULL
  `);


  /* BINGO CARDS */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bingo_cards (
      card_number INTEGER PRIMARY KEY,
      board JSONB NOT NULL
    )
  `);


  /* GAME STATE */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_state (
      id INTEGER PRIMARY KEY,
      game_id BIGINT NOT NULL,
      status TEXT NOT NULL,
      called_numbers JSONB DEFAULT '[]'::jsonb,
      winner_user_id BIGINT,
      winner_name TEXT,
      winner_card_number INTEGER
    )
  `);


  /* REMOVE OLD INVALID RESERVATIONS */

  await pool.query(`
    UPDATE players
    SET
      card_number = NULL,
      card_game_id = NULL,
      marked_numbers = '[]'::jsonb
    WHERE card_game_id IS NULL
  `);


  /* GENERATE PERMANENT CARDS */

  const existingCards =
    await pool.query(`
      SELECT card_number
      FROM bingo_cards
    `);


  const existingNumbers =
    new Set(
      existingCards.rows.map(
        row =>
          Number(
            row.card_number
          )
      )
    );


  for (
    let number = 1;
    number <= 100;
    number++
  ) {

    if (
      existingNumbers.has(number)
    ) {
      continue;
    }


    const board =
      generateBoard();


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
        JSON.stringify(board)
      ]
    );

  }


  /* CREATE FIRST GAME */

  const game =
    await pool.query(`
      SELECT *
      FROM game_state
      WHERE id = 1
    `);


  if (
    game.rows.length === 0
  ) {

    await pool.query(`
      INSERT INTO game_state
      (
        id,
        game_id,
        status,
        called_numbers
      )
      VALUES
      (
        1,
        1,
        'playing',
        '[]'::jsonb
      )
    `);

    console.log(
      "Created Game 1"
    );

  }


  console.log(
    "Database ready."
  );

}


/* =====================================================
   START NEW GAME
===================================================== */

async function startNewGame() {

  try {

    console.log(
      "Starting new Bingo game..."
    );


    /*
     * Release ALL card reservations
     * from previous game.
     */

    await pool.query(`
      UPDATE players
      SET
        card_number = NULL,
        card_game_id = NULL,
        marked_numbers = '[]'::jsonb
    `);


    const result =
      await pool.query(`
        SELECT game_id
        FROM game_state
        WHERE id = 1
        FOR UPDATE
      `);


    let nextGameId = 1;


    if (
      result.rows.length > 0
    ) {

      nextGameId =
        Number(
          result.rows[0].game_id
        ) + 1;

    }


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


    console.log(
      `Started Game ${nextGameId}`
    );


    return nextGameId;

  } catch (error) {

    console.error(
      "START NEW GAME ERROR:",
      error
    );

    return null;

  }

}


/* =====================================================
   FINISH GAME
===================================================== */

async function finishGame(
  winnerUserId = null,
  winnerName = null,
  winnerCardNumber = null
) {

  try {

    const result =
      await pool.query(`
        SELECT
          game_id,
          status
        FROM game_state
        WHERE id = 1
      `);


    if (
      result.rows.length === 0
    ) {
      return;
    }


    const gameId =
      Number(
        result.rows[0].game_id
      );


    /*
     * Don't finish an already finished
     * game again.
     */

    if (
      result.rows[0].status ===
      "finished"
    ) {

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
        winnerName,
        winnerCardNumber
      ]
    );


    if (
      winnerUserId
    ) {

      console.log(
        `Game ${gameId} finished. Winner: ${winnerName} - Card #${winnerCardNumber}`
      );

    } else {

      console.log(
        `Game ${gameId} finished with NO WINNER.`
      );

    }


    /*
     * Start next game after 5 seconds.
     */

    setTimeout(
      async () => {

        try {

          await startNewGame();

        } catch (error) {

          console.error(
            "AUTO NEW GAME ERROR:",
            error
          );

        }

      },
      NEW_GAME_DELAY
    );

  } catch (error) {

    console.error(
      "FINISH GAME ERROR:",
      error
    );

  }

}


/* =====================================================
   CALL NEXT NUMBER
===================================================== */

async function callNextNumber() {

  try {

    const result =
      await pool.query(`
        SELECT *
        FROM game_state
        WHERE id = 1
      `);


    if (
      result.rows.length === 0
    ) {
      return;
    }


    const game =
      result.rows[0];


    if (
      game.status !== "playing"
    ) {

      return;

    }


    const called =
      Array.isArray(
        game.called_numbers
      )
      ? game.called_numbers.map(Number)
      : [];


    /*
     * IMPORTANT FIX:
     *
     * If all 75 numbers have already
     * been called, finish the game
     * even if nobody won.
     */

    if (
      called.length >= 75
    ) {

      console.log(
        `Game ${game.game_id}: all 75 numbers called. No winner.`
      );


      await finishGame(
        null,
        null,
        null
      );


      return;

    }


    const available = [];


    for (
      let number = 1;
      number <= 75;
      number++
    ) {

      if (
        !called.includes(number)
      ) {

        available.push(number);

      }

    }


    if (
      available.length === 0
    ) {

      await finishGame(
        null,
        null,
        null
      );

      return;

    }


    const randomIndex =
      Math.floor(
        Math.random() *
        available.length
      );


    const nextNumber =
      available[randomIndex];


    const newCalled = [
      ...called,
      nextNumber
    ];


    await pool.query(
      `
      UPDATE game_state
      SET called_numbers = $1
      WHERE id = 1
      `,
      [
        JSON.stringify(
          newCalled
        )
      ]
    );


    console.log(
      `Game ${game.game_id}: called ${nextNumber}`
    );


    /*
     * If this was number 75,
     * immediately finish as no winner.
     */

    if (
      newCalled.length >= 75
    ) {

      console.log(
        `Game ${game.game_id}: number 75 reached. No winner.`
      );


      await finishGame(
        null,
        null,
        null
      );

    }

  } catch (error) {

    console.error(
      "CALL NUMBER ERROR:",
      error
    );

  }

}


/* =====================================================
   AUTOMATIC CALLER
===================================================== */

setInterval(
  callNextNumber,
  CALL_INTERVAL
);


/* =====================================================
   API: ALL CARDS
===================================================== */

app.get(
  "/api/cards",
  async (req, res) => {

    try {

      const gameResult =
        await pool.query(`
          SELECT *
          FROM game_state
          WHERE id = 1
        `);


      if (
        gameResult.rows.length === 0
      ) {

        return res.json({
          success: false,
          error: "Game not found."
        });

      }


      const game =
        gameResult.rows[0];


      const cardsResult =
        await pool.query(`
          SELECT
            card_number,
            board
          FROM bingo_cards
          ORDER BY card_number
        `);


      const playersResult =
        await pool.query(
          `
          SELECT
            p.card_number,
            p.user_id,
            p.username,
            p.first_name
          FROM players p
          WHERE
            p.card_number IS NOT NULL
            AND p.card_game_id = $1
          `,
          [
            game.game_id
          ]
        );


      const usedCards =
        playersResult.rows.map(
          row =>
            Number(
              row.card_number
            )
        );


      const usedBy = {};


      for (
        const player of
        playersResult.rows
      ) {

        usedBy[
          String(
            player.card_number
          )
        ] = {

          userId:
            player.user_id,

          name:
            player.username ||
            player.first_name ||
            "Player"

        };

      }


      const cards =
        cardsResult.rows.map(
          row => {

            const board =
              boardToColumns(
                row.board
              );


            return {

              cardNumber:
                Number(
                  row.card_number
                ),

              board

            };

          }
        );


      const cardsByNumber = {};


      for (
        const card of cards
      ) {

        cardsByNumber[
          String(
            card.cardNumber
          )
        ] =
          card.board;

      }


      const calledNumbers =
        Array.isArray(
          game.called_numbers
        )
        ? game.called_numbers.map(Number)
        : [];


      const currentNumber =
        calledNumbers.length > 0
        ? calledNumbers[
            calledNumbers.length - 1
          ]
        : null;


      res.json({

        success: true,

        gameId:
          Number(
            game.game_id
          ),

        status:
          game.status,

        currentNumber,

        calledNumbers,

        cards,

        cardsByNumber,

        usedCards,

        usedBy,

        winner: {

          userId:
            game.winner_user_id,

          name:
            game.winner_name,

          cardNumber:
            game.winner_card_number

        }

      });

    } catch (error) {

      console.error(
        "API CARDS ERROR:",
        error
      );


      res.status(500).json({

        success: false,

        error:
          "Could not load cards.",

        details:
          error.message

      });

    }

  }
);


/* =====================================================
   API: ONE CARD
===================================================== */

app.get(
  "/api/card",
  async (req, res) => {

    try {

      const cardNumber =
        Number(
          req.query.number
        );


      if (
        !Number.isInteger(cardNumber) ||
        cardNumber < 1 ||
        cardNumber > 100
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Invalid card number."

        });

      }


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
        cardResult.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          error:
            "Card not found."

        });

      }


      const gameResult =
        await pool.query(`
          SELECT *
          FROM game_state
          WHERE id = 1
        `);


      const game =
        gameResult.rows[0];


      const ownerResult =
        await pool.query(
          `
          SELECT
            user_id,
            username,
            first_name
          FROM players
          WHERE
            card_number = $1
            AND card_game_id = $2
          `,
          [
            cardNumber,
            game.game_id
          ]
        );


      const owner =
        ownerResult.rows[0] ||
        null;


      const board =
        boardToColumns(
          cardResult.rows[0].board
        );


      res.json({

        success: true,

        cardNumber,

        board,

        gameId:
          Number(
            game.game_id
          ),

        status:
          game.status,

        available:
          !owner,

        takenBy:
          owner
          ? {

              userId:
                owner.user_id,

              name:
                owner.username ||
                owner.first_name ||
                "Player"

            }
          : null

      });

    } catch (error) {

      console.error(
        "API CARD ERROR:",
        error
      );


      res.status(500).json({

        success: false,

        error:
          "Could not load card.",

        details:
          error.message

      });

    }

  }
);


/* =====================================================
   API: SELECT CARD
===================================================== */

app.post(
  "/api/select-card",
  async (req, res) => {

    const client =
      await pool.connect();


    try {

      const {
        userId,
        cardNumber,
        username,
        firstName,
        initData
      } = req.body;


      if (!userId) {

        return res.status(400).json({

          success: false,

          error:
            "User ID is required."

        });

      }


      const number =
        Number(cardNumber);


      if (
        !Number.isInteger(number) ||
        number < 1 ||
        number > 100
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Invalid card number."

        });

      }


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


      if (
        gameResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(500).json({

          success: false,

          error:
            "Game not found."

        });

      }


      const game =
        gameResult.rows[0];


      if (
        game.status !== "playing"
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          success: false,

          error:
            "The game is not currently accepting cards."

        });

      }


      const cardResult =
        await client.query(
          `
          SELECT
            card_number,
            board
          FROM bingo_cards
          WHERE card_number = $1
          `,
          [
            number
          ]
        );


      if (
        cardResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({

          success: false,

          error:
            "Bingo card not found."

        });

      }


      const existingPlayer =
        await client.query(
          `
          SELECT
            card_number
          FROM players
          WHERE
            user_id = $1
            AND card_game_id = $2
          FOR UPDATE
          `,
          [
            userId,
            game.game_id
          ]
        );


      if (
        existingPlayer.rows.length > 0 &&
        existingPlayer.rows[0].card_number
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          success: false,

          error:
            `You already selected Card #${existingPlayer.rows[0].card_number} in this game.`

        });

      }


      const cardOwner =
        await client.query(
          `
          SELECT
            user_id,
            username,
            first_name
          FROM players
          WHERE
            card_number = $1
            AND card_game_id = $2
          FOR UPDATE
          `,
          [
            number,
            game.game_id
          ]
        );


      if (
        cardOwner.rows.length > 0
      ) {

        const owner =
          cardOwner.rows[0];


        await client.query(
          "ROLLBACK"
        );


        return res.status(400).json({

          success: false,

          error:
            `Card #${number} is already taken.`,

          takenBy:
            owner.username ||
            owner.first_name ||
            "Another player"

        });

      }


      const board =
        boardToColumns(
          cardResult.rows[0].board
        );


      if (!board) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(500).json({

          success: false,

          error:
            "This Bingo card has an invalid board."

        });

      }


      await client.query(
        `
        INSERT INTO players
        (
          user_id,
          username,
          first_name,
          card_number,
          card_game_id,
          marked_numbers
        )
        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          '[]'::jsonb
        )
        ON CONFLICT (user_id)
        DO UPDATE SET
          username = EXCLUDED.username,
          first_name = EXCLUDED.first_name,
          card_number = EXCLUDED.card_number,
          card_game_id = EXCLUDED.card_game_id,
          marked_numbers = '[]'::jsonb
        `,
        [
          userId,
          username || null,
          firstName || null,
          number,
          game.game_id
        ]
      );


      await client.query(
        "COMMIT"
      );


      res.json({

        success: true,

        cardNumber:
          number,

        board,

        gameId:
          Number(
            game.game_id
          ),

        status:
          game.status,

        calledNumbers:
          Array.isArray(
            game.called_numbers
          )
          ? game.called_numbers.map(Number)
          : [],

        markedNumbers: []

      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}


      console.error(
        "SELECT CARD ERROR:",
        error
      );


      res.status(500).json({

        success: false,

        error:
          "Could not select card.",

        details:
          error.message

      });

    } finally {

      client.release();

    }

  }
);


/* =====================================================
   API: MY CARD
===================================================== */

app.get(
  "/api/my-card",
  async (req, res) => {

    try {

      const userId =
        Number(
          req.query.userId
        );


      if (!userId) {

        return res.status(400).json({

          success: false,

          error:
            "User ID is required."

        });

      }


      const gameResult =
        await pool.query(`
          SELECT *
          FROM game_state
          WHERE id = 1
        `);


      const game =
        gameResult.rows[0];


      const playerResult =
        await pool.query(
          `
          SELECT *
          FROM players
          WHERE
            user_id = $1
            AND card_game_id = $2
          `,
          [
            userId,
            game.game_id
          ]
        );


      if (
        playerResult.rows.length === 0 ||
        !playerResult.rows[0].card_number
      ) {

        return res.json({

          success: true,

          cardNumber: null,

          gameId:
            Number(
              game.game_id
            ),

          status:
            game.status

        });

      }


      const player =
        playerResult.rows[0];


      const cardResult =
        await pool.query(
          `
          SELECT board
          FROM bingo_cards
          WHERE card_number = $1
          `,
          [
            player.card_number
          ]
        );


      if (
        cardResult.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          error:
            "Bingo card not found."

        });

      }


      const board =
        boardToColumns(
          cardResult.rows[0].board
        );


      const markedNumbers =
        Array.isArray(
          player.marked_numbers
        )
        ? player.marked_numbers.map(Number)
        : [];


      const calledNumbers =
        Array.isArray(
          game.called_numbers
        )
        ? game.called_numbers.map(Number)
        : [];


      const currentNumber =
        calledNumbers.length > 0
        ? calledNumbers[
            calledNumbers.length - 1
          ]
        : null;


      res.json({

        success: true,

        cardNumber:
          Number(
            player.card_number
          ),

        board,

        gameId:
          Number(
            game.game_id
          ),

        status:
          game.status,

        calledNumbers,

        currentNumber,

        markedNumbers

      });

    } catch (error) {

      console.error(
        "MY CARD ERROR:",
        error
      );


      res.status(500).json({

        success: false,

        error:
          "Could not load your card.",

        details:
          error.message

      });

    }

  }
);


/* =====================================================
   API: MARK
===================================================== */

app.post(
  "/api/mark",
  async (req, res) => {

    try {

      const {
        userId,
        number
      } = req.body;


      if (!userId) {

        return res.status(400).json({

          success: false,

          error:
            "User ID is required."

        });

      }


      const markNumber =
        Number(number);


      const gameResult =
        await pool.query(`
          SELECT *
          FROM game_state
          WHERE id = 1
        `);


      const game =
        gameResult.rows[0];


      if (
        game.status !== "playing"
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Game is not currently playing."

        });

      }


      const called =
        Array.isArray(
          game.called_numbers
        )
        ? game.called_numbers.map(Number)
        : [];


      if (
        !called.includes(
          markNumber
        )
      ) {

        return res.status(400).json({

          success: false,

          error:
            "This number has not been called yet."

        });

      }


      const playerResult =
        await pool.query(
          `
          SELECT
            marked_numbers
          FROM players
          WHERE
            user_id = $1
            AND card_game_id = $2
          `,
          [
            userId,
            game.game_id
          ]
        );


      if (
        playerResult.rows.length === 0
      ) {

        return res.status(400).json({

          success: false,

          error:
            "You have not selected a card."

        });

      }


      let marked =
        Array.isArray(
          playerResult.rows[0]
            .marked_numbers
        )
        ? playerResult.rows[0]
            .marked_numbers
            .map(Number)
        : [];


      if (
        !marked.includes(markNumber)
      ) {

        marked.push(
          markNumber
        );

      }


      await pool.query(
        `
        UPDATE players
        SET marked_numbers = $1
        WHERE
          user_id = $2
          AND card_game_id = $3
        `,
        [
          JSON.stringify(marked),
          userId,
          game.game_id
        ]
      );


      res.json({

        success: true,

        markedNumbers:
          marked

      });

    } catch (error) {

      console.error(
        "MARK ERROR:",
        error
      );


      res.status(500).json({

        success: false,

        error:
          "Could not mark number.",

        details:
          error.message

      });

    }

  }
);


/* =====================================================
   API: UNMARK
===================================================== */

app.post(
  "/api/unmark",
  async (req, res) => {

    try {

      const {
        userId,
        number
      } = req.body;


      if (!userId) {

        return res.status(400).json({

          success: false,

          error:
            "User ID is required."

        });

      }


      const unmarkNumber =
        Number(number);


      const gameResult =
        await pool.query(`
          SELECT *
          FROM game_state
          WHERE id = 1
        `);


      const game =
        gameResult.rows[0];


      const playerResult =
        await pool.query(
          `
          SELECT marked_numbers
          FROM players
          WHERE
            user_id = $1
            AND card_game_id = $2
          `,
          [
            userId,
            game.game_id
          ]
        );


      if (
        playerResult.rows.length === 0
      ) {

        return res.status(400).json({

          success: false,

          error:
            "You have not selected a card."

        });

      }


      let marked =
        Array.isArray(
          playerResult.rows[0]
            .marked_numbers
        )
        ? playerResult.rows[0]
            .marked_numbers
            .map(Number)
        : [];


      marked =
        marked.filter(
          n =>
            n !== unmarkNumber
        );


      await pool.query(
        `
        UPDATE players
        SET marked_numbers = $1
        WHERE
          user_id = $2
          AND card_game_id = $3
        `,
        [
          JSON.stringify(marked),
          userId,
          game.game_id
        ]
      );


      res.json({

        success: true,

        markedNumbers:
          marked

      });

    } catch (error) {

      console.error(
        "UNMARK ERROR:",
        error
      );


      res.status(500).json({

        success: false,

        error:
          "Could not unmark number.",

        details:
          error.message

      });

    }

  }
);


/* =====================================================
   BINGO VALIDATION
===================================================== */

function hasWinningLine(
  board,
  calledNumbers,
  markedNumbers
) {

  const rows =
    boardToRows(board);


  if (!rows) {
    return false;
  }


  const marked =
    new Set(
      markedNumbers.map(Number)
    );


  const called =
    new Set(
      calledNumbers.map(Number)
    );


  function isMarked(
    value,
    row,
    col
  ) {

    if (
      row === 2 &&
      col === 2
    ) {

      return true;

    }


    const number =
      Number(value);


    return (
      marked.has(number) ||
      called.has(number)
    );

  }


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
          rows[row][col],
          row,
          col
        )
      ) {

        complete = false;
        break;

      }

    }


    if (complete) {
      return true;
    }

  }


  /* COLUMNS */

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
          rows[row][col],
          row,
          col
        )
      ) {

        complete = false;
        break;

      }

    }


    if (complete) {
      return true;
    }

  }


  /* MAIN DIAGONAL */

  let diagonal1 = true;


  for (
    let i = 0;
    i < 5;
    i++
  ) {

    if (
      !isMarked(
        rows[i][i],
        i,
        i
      )
    ) {

      diagonal1 = false;
      break;

    }

  }


  if (diagonal1) {
    return true;
  }


  /* SECOND DIAGONAL */

  let diagonal2 = true;


  for (
    let i = 0;
    i < 5;
    i++
  ) {

    const col =
      4 - i;


    if (
      !isMarked(
        rows[i][col],
        i,
        col
      )
    ) {

      diagonal2 = false;
      break;

    }

  }


  if (diagonal2) {
    return true;
  }


  return false;

}


/* =====================================================
   API: BINGO
===================================================== */

app.post(
  "/api/bingo",
  async (req, res) => {

    try {

      const {
        userId
      } = req.body;


      if (!userId) {

        return res.status(400).json({

          success: false,

          error:
            "User ID is required."

        });

      }


      const gameResult =
        await pool.query(`
          SELECT *
          FROM game_state
          WHERE id = 1
          FOR UPDATE
        `);


      const game =
        gameResult.rows[0];


      if (
        game.status !== "playing"
      ) {

        return res.status(400).json({

          success: false,

          error:
            "The game is already finished."

        });

      }


      const playerResult =
        await pool.query(
          `
          SELECT *
          FROM players
          WHERE
            user_id = $1
            AND card_game_id = $2
          `,
          [
            userId,
            game.game_id
          ]
        );


      if (
        playerResult.rows.length === 0
      ) {

        return res.status(400).json({

          success: false,

          error:
            "You have not selected a card."

        });

      }


      const player =
        playerResult.rows[0];


      const cardResult =
        await pool.query(
          `
          SELECT board
          FROM bingo_cards
          WHERE card_number = $1
          `,
          [
            player.card_number
          ]
        );


      if (
        cardResult.rows.length === 0
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Bingo card not found."

        });

      }


      const board =
        cardResult.rows[0].board;


      const calledNumbers =
        Array.isArray(
          game.called_numbers
        )
        ? game.called_numbers.map(Number)
        : [];


      const markedNumbers =
        Array.isArray(
          player.marked_numbers
        )
        ? player.marked_numbers.map(Number)
        : [];


      const valid =
        hasWinningLine(
          board,
          calledNumbers,
          markedNumbers
        );


      if (!valid) {

        return res.json({

          success: true,

          bingo: false,

          message:
            "Bingo is not valid yet."

        });

      }


      const winnerName =
        player.username ||
        player.first_name ||
        "Player";


      await finishGame(
        Number(userId),
        winnerName,
        Number(
          player.card_number
        )
      );


      res.json({

        success: true,

        bingo: true,

        winnerName,

        winnerCardNumber:
          Number(
            player.card_number
          )

      });

    } catch (error) {

      console.error(
        "BINGO ERROR:",
        error
      );


      res.status(500).json({

        success: false,

        error:
          "Could not check Bingo.",

        details:
          error.message

      });

    }

  }
);


/* =====================================================
   API: GAME
===================================================== */

app.get(
  "/api/game",
  async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT *
          FROM game_state
          WHERE id = 1
        `);


      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          error:
            "Game not found."

        });

      }


      const game =
        result.rows[0];


      const calledNumbers =
        Array.isArray(
          game.called_numbers
        )
        ? game.called_numbers.map(Number)
        : [];


      const currentNumber =
        calledNumbers.length > 0
        ? calledNumbers[
            calledNumbers.length - 1
          ]
        : null;


      res.json({

        success: true,

        gameId:
          Number(
            game.game_id
          ),

        status:
          game.status,

        calledNumbers,

        currentNumber,

        winner: {

          userId:
            game.winner_user_id,

          name:
            game.winner_name,

          cardNumber:
            game.winner_card_number

        },

        winnerUserId:
          game.winner_user_id,

        winnerName:
          game.winner_name,

        winnerCardNumber:
          game.winner_card_number

      });

    } catch (error) {

      console.error(
        "GAME API ERROR:",
        error
      );


      res.status(500).json({

        success: false,

        error:
          "Could not load game.",

        details:
          error.message

      });

    }

  }
);


/* =====================================================
   GAME STATE ALIAS
===================================================== */

app.get(
  "/api/game-state",
  async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT *
          FROM game_state
          WHERE id = 1
        `);


      const game =
        result.rows[0];


      if (!game) {

        return res.status(404).json({

          success: false,

          error:
            "Game not found."

        });

      }


      const calledNumbers =
        Array.isArray(
          game.called_numbers
        )
        ? game.called_numbers.map(Number)
        : [];


      const currentNumber =
        calledNumbers.length > 0
        ? calledNumbers[
            calledNumbers.length - 1
          ]
        : null;


      res.json({

        success: true,

        gameId:
          Number(
            game.game_id
          ),

        status:
          game.status,

        calledNumbers,

        currentNumber,

        winnerName:
          game.winner_name,

        winnerCardNumber:
          game.winner_card_number,

        winnerUserId:
          game.winner_user_id

      });

    } catch (error) {

      res.status(500).json({

        success: false,

        error:
          "Could not load game state."

      });

    }

  }
);


/* =====================================================
   BOT MENU
===================================================== */

const menuKeyboard =
  Markup.keyboard([

    ["▶️ Start", "🎮 Play"],

    ["💰 Deposit", "💳 Balance"],

    ["💸 Withdraw", "❓ HIW"],

    ["🎁 Invite", "🆘 Support"]

  ])
  .resize();


/* =====================================================
   BOT START
===================================================== */

bot.start(
  async ctx => {

    await ctx.reply(

      "🎱 Welcome to Roda Bingo!\n\nChoose an option below:",

      menuKeyboard

    );

  }
);


/* =====================================================
   PLAY
===================================================== */

bot.hears(
  "🎮 Play",
  async ctx => {

    await ctx.reply(

      "🎱 Choose your Bingo card:",

      Markup.inlineKeyboard([

        [
          Markup.button.webApp(
            "🎮 OPEN BINGO",
            MINIAPP_URL
          )
        ]

      ])

    );

  }
);


/* =====================================================
   START MENU
===================================================== */

bot.hears(
  "▶️ Start",
  async ctx => {

    await ctx.reply(
      "🎱 Welcome to Roda Bingo!\n\nChoose an option below:",
      menuKeyboard
    );

  }
);


/* =====================================================
   PLACEHOLDER BUTTONS
===================================================== */

bot.hears(
  "💰 Deposit",
  async ctx => {

    await ctx.reply(
      "Deposit system is not connected yet."
    );

  }
);


bot.hears(
  "💳 Balance",
  async ctx => {

    await ctx.reply(
      "Balance system is not connected yet."
    );

  }
);


bot.hears(
  "💸 Withdraw",
  async ctx => {

    await ctx.reply(
      "Withdraw system is not connected yet."
    );

  }
);


bot.hears(
  "❓ HIW",
  async ctx => {

    await ctx.reply(
      "How to Play:\n\n1. Choose a card from 1–100.\n2. Wait for numbers to be called.\n3. Mark called numbers on your card.\n4. Press BINGO when you complete a winning line."
    );

  }
);


bot.hears(
  "🎁 Invite",
  async ctx => {

    await ctx.reply(
      "Invite system is not connected yet."
    );

  }
);


bot.hears(
  "🆘 Support",
  async ctx => {

    await ctx.reply(
      "Support system is not connected yet."
    );

  }
);


/* =====================================================
   WEBHOOK
===================================================== */

app.post(
  "/telegram-webhook",
  async (req, res) => {

    try {

      await bot.handleUpdate(
        req.body
      );

      res.sendStatus(200);

    } catch (error) {

      console.error(
        "WEBHOOK ERROR:",
        error
      );

      res.sendStatus(500);

    }

  }
);


/* =====================================================
   START SERVER
===================================================== */

async function startServer() {

  try {

    await setupDatabase();


    app.listen(
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

  } catch (error) {

    console.error(
      "SERVER START ERROR:",
      error
    );

    process.exit(1);

  }

}


startServer();
