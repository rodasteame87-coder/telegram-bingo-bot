const { Telegraf } = require("telegraf");
const { Pool } = require("pg");
const http = require("http");
const fs = require("fs");
const path = require("path");

const bot = new Telegraf(process.env.BOT_TOKEN);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

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

  // Add the column to existing databases without deleting anything.
  await pool.query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS marked_numbers JSONB NOT NULL DEFAULT '[]'
  `);

  console.log("Database ready");
}

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
      const n =
        Math.floor(Math.random() * (max - min + 1)) + min;

      if (!numbers.includes(n)) {
        numbers.push(n);
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

function hasBingo(card, markedNumbers) {
  const marked = new Set(
    (markedNumbers || []).map(String)
  );

  function isMarked(value) {
    return value === "FREE" || marked.has(String(value));
  }

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

  // Diagonal
  let diagonal1 = true;

  for (let i = 0; i < 5; i++) {
    if (!isMarked(card[i][i])) {
      diagonal1 = false;
      break;
    }
  }

  if (diagonal1) {
    return true;
  }

  // Other diagonal
  let diagonal2 = true;

  for (let i = 0; i < 5; i++) {
    if (!isMarked(card[i][4 - i])) {
      diagonal2 = false;
      break;
    }
  }

  return diagonal2;
}

// ==========================
// /newgame
// ==========================

bot.command("newgame", async (ctx) => {
  if (!ctx.chat) return;

  const chatId = ctx.chat.id;
  const hostId = ctx.from.id;
  const hostName =
    ctx.from.first_name ||
    ctx.from.username ||
    "Host";

  try {
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
      "🎱 New Bingo game started!\n\n" +
      "Players can join with /join"
    );
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not start the game.");
  }
});

// ==========================
// /join
// ==========================

bot.command("join", async (ctx) => {
  if (!ctx.chat || !ctx.from) return;

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const name =
    ctx.from.first_name ||
    ctx.from.username ||
    "Player";

  try {
    const gameResult = await pool.query(
      `SELECT * FROM games WHERE chat_id = $1`,
      [chatId]
    );

    if (gameResult.rows.length === 0) {
      await ctx.reply(
        "❌ No active game.\n\nUse /newgame first."
      );
      return;
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
      await ctx.reply(
        "✅ You are already in the game.\n\nUse /play to open your card."
      );
      return;
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
      `🎟️ ${name}, you joined the Bingo game!\n\n` +
      "Use /play to open your Bingo card."
    );
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not join the game.");
  }
});

// ==========================
// /players
// ==========================

bot.command("players", async (ctx) => {
  if (!ctx.chat) return;

  try {
    const result = await pool.query(
      `
      SELECT name
      FROM players
      WHERE chat_id = $1
      ORDER BY name
      `,
      [ctx.chat.id]
    );

    if (result.rows.length === 0) {
      await ctx.reply("👥 No players yet.");
      return;
    }

    const list = result.rows
      .map((player, index) => `${index + 1}. ${player.name}`)
      .join("\n");

    await ctx.reply(
      `👥 Players (${result.rows.length})\n\n${list}`
    );
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not load players.");
  }
});

// ==========================
// /call
// ==========================

bot.command("call", async (ctx) => {
  if (!ctx.chat) return;

  const chatId = ctx.chat.id;

  try {
    const gameResult = await pool.query(
      `SELECT * FROM games WHERE chat_id = $1`,
      [chatId]
    );

    if (gameResult.rows.length === 0) {
      await ctx.reply("❌ No active game.");
      return;
    }

    const game = gameResult.rows[0];

    if (game.winner) {
      await ctx.reply(
        `🏆 Game already finished!\nWinner: ${game.winner}`
      );
      return;
    }

    const calledNumbers = game.called_numbers || [];

    if (calledNumbers.length >= 75) {
      await ctx.reply(
        "🎱 All 75 numbers have been called."
      );
      return;
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

    let letter;

    if (number <= 15) {
      letter = "B";
    } else if (number <= 30) {
      letter = "I";
    } else if (number <= 45) {
      letter = "N";
    } else if (number <= 60) {
      letter = "G";
    } else {
      letter = "O";
    }

    await ctx.reply(
      `🎱 CALLED: ${letter}-${number}\n\n` +
      `📊 ${calledNumbers.length}/75 numbers called`
    );
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not call a number.");
  }
});

// ==========================
// /play
// ==========================

bot.command("play", async (ctx) => {
  if (!ctx.chat) return;

  const chatId = ctx.chat.id;

  const url =
    `https://t.me/Rudivollerbingo_bot?startapp=${chatId}`;

  await ctx.reply(
    "🎟️ Open your Bingo card:\n\n" +
    url
  );
});

// ==========================
// /bingo
// ==========================

bot.command("bingo", async (ctx) => {
  if (!ctx.chat || !ctx.from) return;

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  try {
    const gameResult = await pool.query(
      `SELECT * FROM games WHERE chat_id = $1`,
      [chatId]
    );

    if (gameResult.rows.length === 0) {
      await ctx.reply("❌ No active game.");
      return;
    }

    const game = gameResult.rows[0];

    if (game.winner) {
      await ctx.reply(
        `🏆 The game is already finished!\nWinner: ${game.winner}`
      );
      return;
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
      await ctx.reply(
        "❌ You are not in this game.\nUse /join first."
      );
      return;
    }

    const player = playerResult.rows[0];

    const markedNumbers =
      player.marked_numbers || [];

    if (!hasBingo(player.card, markedNumbers)) {
      await ctx.reply(
        "❌ No Bingo yet!\n\n" +
        "You need a complete row, column, or diagonal."
      );
      return;
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
      `🏆 BINGO!\n\n` +
      `🎉 Winner: ${player.name}`
    );
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not verify Bingo.");
  }
});

// ==========================
// /endgame
// ==========================

bot.command("endgame", async (ctx) => {
  if (!ctx.chat || !ctx.from) return;

  try {
    const result = await pool.query(
      `SELECT * FROM games WHERE chat_id = $1`,
      [ctx.chat.id]
    );

    if (result.rows.length === 0) {
      await ctx.reply("❌ No active game.");
      return;
    }

    const game = result.rows[0];

    if (Number(game.host_id) !== Number(ctx.from.id)) {
      await ctx.reply(
        "❌ Only the game host can end the game."
      );
      return;
    }

    await pool.query(
      `DELETE FROM games WHERE chat_id = $1`,
      [ctx.chat.id]
    );

    await ctx.reply("🛑 Bingo game ended.");
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Could not end the game.");
  }
});

// ==========================
// HTTP SERVER
// ==========================

const miniAppPath = path.join(
  __dirname,
  "miniapp",
  "index.html"
);

const server = http.createServer(async (req, res) => {
  try {
    // Mini App
    if (req.url === "/miniapp" || req.url === "/miniapp/") {
      const html = fs.readFileSync(
        miniAppPath,
        "utf8"
      );

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });

      res.end(html);
      return;
    }

    // ==========================
    // GET CARD
    // ==========================

    if (req.url.startsWith("/api/card")) {
      const url = new URL(
        req.url,
        `http://${req.headers.host}`
      );

      const chatId = url.searchParams.get("chatId");
      const userId = url.searchParams.get("userId");

      if (!chatId || !userId) {
        res.writeHead(400, {
          "Content-Type": "application/json"
        });

        res.end(
          JSON.stringify({
            error: "Missing chatId or userId"
          })
        );

        return;
      }

      const gameResult = await pool.query(
        `
        SELECT
          host_name,
          called_numbers,
          winner
        FROM games
        WHERE chat_id = $1
        `,
        [chatId]
      );

      if (gameResult.rows.length === 0) {
        res.writeHead(404, {
          "Content-Type": "application/json"
        });

        res.end(
          JSON.stringify({
            error: "Game not found"
          })
        );

        return;
      }

      const game = gameResult.rows[0];

      const playerResult = await pool.query(
        `
        SELECT
          name,
          card,
          marked_numbers
        FROM players
        WHERE chat_id = $1 AND user_id = $2
        `,
        [chatId, userId]
      );

      if (playerResult.rows.length === 0) {
        res.writeHead(404, {
          "Content-Type": "application/json"
        });

        res.end(
          JSON.stringify({
            error: "Player not found"
          })
        );

        return;
      }

      const player = playerResult.rows[0];

      const countResult = await pool.query(
        `
        SELECT COUNT(*) AS count
        FROM players
        WHERE chat_id = $1
        `,
        [chatId]
      );

      const playerCount =
        Number(countResult.rows[0].count);

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      });

      res.end(
        JSON.stringify({
          name: player.name,
          hostName: game.host_name,
          playerCount: playerCount,
          card: player.card,
          markedNumbers: player.marked_numbers || [],
          calledNumbers: game.called_numbers || [],
          winner: game.winner
        })
      );

      return;
    }

    // ==========================
    // SAVE MARK
    // ==========================

    if (
      req.method === "POST" &&
      req.url === "/api/mark"
    ) {
      let body = "";

      req.on("data", chunk => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const data = JSON.parse(body);

          const chatId = data.chatId;
          const userId = data.userId;
          const number = data.number;

          if (!chatId || !userId || number === undefined) {
            res.writeHead(400, {
              "Content-Type": "application/json"
            });

            res.end(
              JSON.stringify({
                error: "Missing data"
              })
            );

            return;
          }

          const playerResult = await pool.query(
            `
            SELECT marked_numbers
            FROM players
            WHERE chat_id = $1 AND user_id = $2
            `,
            [chatId, userId]
          );

          if (playerResult.rows.length === 0) {
            res.writeHead(404, {
              "Content-Type": "application/json"
            });

            res.end(
              JSON.stringify({
                error: "Player not found"
              })
            );

            return;
          }

          let marked =
            playerResult.rows[0].marked_numbers || [];

          const numberString = String(number);

          if (!marked.map(String).includes(numberString)) {
            marked.push(number);
          }

          await pool.query(
            `
            UPDATE players
            SET marked_numbers = $1
            WHERE chat_id = $2 AND user_id = $3
            `,
            [
              JSON.stringify(marked),
              chatId,
              userId
            ]
          );

          res.writeHead(200, {
            "Content-Type": "application/json"
          });

          res.end(
            JSON.stringify({
              success: true,
              markedNumbers: marked
            })
          );
        } catch (error) {
          console.error(error);

          res.writeHead(500, {
            "Content-Type": "application/json"
          });

          res.end(
            JSON.stringify({
              error: "Server error"
            })
          );
        }
      });

      return;
    }

    // ==========================
    // UNMARK
    // ==========================

    if (
      req.method === "POST" &&
      req.url === "/api/unmark"
    ) {
      let body = "";

      req.on("data", chunk => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const data = JSON.parse(body);

          const chatId = data.chatId;
          const userId = data.userId;
          const number = data.number;

          if (!chatId || !userId || number === undefined) {
            res.writeHead(400, {
              "Content-Type": "application/json"
            });

            res.end(
              JSON.stringify({
                error: "Missing data"
              })
            );

            return;
          }

          const playerResult = await pool.query(
            `
            SELECT marked_numbers
            FROM players
            WHERE chat_id = $1 AND user_id = $2
            `,
            [chatId, userId]
          );

          if (playerResult.rows.length === 0) {
            res.writeHead(404, {
              "Content-Type": "application/json"
            });

            res.end(
              JSON.stringify({
                error: "Player not found"
              })
            );

            return;
          }

          let marked =
            playerResult.rows[0].marked_numbers || [];

          marked = marked.filter(
            value => String(value) !== String(number)
          );

          await pool.query(
            `
            UPDATE players
            SET marked_numbers = $1
            WHERE chat_id = $2 AND user_id = $3
            `,
            [
              JSON.stringify(marked),
              chatId,
              userId
            ]
          );

          res.writeHead(200, {
            "Content-Type": "application/json"
          });

          res.end(
            JSON.stringify({
              success: true,
              markedNumbers: marked
            })
          );
        } catch (error) {
          console.error(error);

          res.writeHead(500, {
            "Content-Type": "application/json"
          });

          res.end(
            JSON.stringify({
              error: "Server error"
            })
          );
        }
      });

      return;
    }

    // ==========================
    // BINGO API
    // ==========================

    if (req.url.startsWith("/api/bingo")) {
      const url = new URL(
        req.url,
        `http://${req.headers.host}`
      );

      const chatId = url.searchParams.get("chatId");
      const userId = url.searchParams.get("userId");

      if (!chatId || !userId) {
        res.writeHead(400, {
          "Content-Type": "application/json"
        });

        res.end(
          JSON.stringify({
            error: "Missing chatId or userId"
          })
        );

        return;
      }

      const gameResult = await pool.query(
        `SELECT * FROM games WHERE chat_id = $1`,
        [chatId]
      );

      if (gameResult.rows.length === 0) {
        res.writeHead(404, {
          "Content-Type": "application/json"
        });

        res.end(
          JSON.stringify({
            error: "Game not found"
          })
        );

        return;
      }

      const game = gameResult.rows[0];

      if (game.winner) {
        res.writeHead(200, {
          "Content-Type": "application/json"
        });

        res.end(
          JSON.stringify({
            bingo: true,
            winner: game.winner
          })
        );

        return;
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
        res.writeHead(404, {
          "Content-Type": "application/json"
        });

        res.end(
          JSON.stringify({
            error: "Player not found"
          })
        );

        return;
      }

      const player = playerResult.rows[0];

      const bingo = hasBingo(
        player.card,
        player.marked_numbers || []
      );

      if (bingo) {
        await pool.query(
          `
          UPDATE games
          SET winner = $1
          WHERE chat_id = $2
          `,
          [player.name, chatId]
        );

        try {
          await bot.telegram.sendMessage(
            chatId,
            `🏆 BINGO!\n\n🎉 Winner: ${player.name}`
          );
        } catch (error) {
          console.error(
            "Could not announce winner:",
            error
          );
        }

        res.writeHead(200, {
          "Content-Type": "application/json"
        });

        res.end(
          JSON.stringify({
            bingo: true,
            winner: player.name
          })
        );
      } else {
        res.writeHead(200, {
          "Content-Type": "application/json"
        });

        res.end(
          JSON.stringify({
            bingo: false
          })
        );
      }

      return;
    }

    // Health check
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    res.end("Telegram Bingo Bot is running!");
  } catch (error) {
    console.error(error);

    res.writeHead(500, {
      "Content-Type": "text/plain"
    });

    res.end("Server error");
  }
});

// ==========================
// START
// ==========================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

initDatabase()
  .then(() => {
    bot.launch();
    console.log("Bot started");
  })
  .catch(error => {
    console.error(
      "Database initialization failed:",
      error
    );
    process.exit(1);
  });

process.once("SIGINT", () => {
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
});
