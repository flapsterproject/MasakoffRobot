// Notes: Requires BOT_TOKEN env var and Deno KV. Deploy as webhook at SECRET_PATH.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const TOKEN = Deno.env.get("BOT_TOKEN")!;
if (!TOKEN) throw new Error("BOT_TOKEN env var is required");

const API = `https://api.telegram.org/bot${TOKEN}`;
const SECRET_PATH = Deno.env.get("SECRET_PATH"); // Adjust this to your deployed webhook path
const ADMIN_USERNAME = "Masakoff"; // without @

// Deno KV instance
const kv = await Deno.openKv();

// Runtime storage for active matches and queues
let queue: string[] = [];
let starQueue: string[] = [];
const battles: Record<string, any> = {};
const searchTimeouts: Record<string, number> = {};

// State helpers using KV for multi-step processes like withdrawals
async function getWithdrawalState(userId: string): Promise<{ amount: number; step: "amount" | "phone" } | null> {
  const res = await kv.get<{ amount: number; step: "amount" | "phone" }>(["states", "withdrawal", userId]);
  return res.value;
}

async function setWithdrawalState(userId: string, state: { amount: number; step: "amount" | "phone" } | null) {
  if (state) {
    await kv.set(["states", "withdrawal", userId], state);
  } else {
    await kv.delete(["states", "withdrawal", userId]);
  }
}

// User language storage
async function getUserLanguage(userId: string): Promise<string> {
  const res = await kv.get<string>(["users", userId, "language"]);
  return res.value ?? "EN"; // Default to English
}

async function setUserLanguage(userId: string, language: string) {
  await kv.set(["users", userId, "language"], language);
}

// -------------------- Telegram API Helpers --------------------
async function sendMessage(chatId: string | number, text: string, options: any = {}): Promise<number | null> {
  try {
    const body: any = { chat_id: chatId, text, ...options };
    const res = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("sendMessage failed:", data.error);
      return null;
    }
    return data.result?.message_id ?? null;
  } catch (e) {
    console.error("sendMessage error", e);
    return null;
  }
}

async function editMessageText(chatId: string | number, messageId: number, text: string, options: any = {}) {
  try {
    const body = { chat_id: chatId, message_id: messageId, text, ...options };
    const res = await fetch(`${API}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn("editMessageText failed:", data.error);
    }
  } catch (e) {
    console.warn("editMessageText failed", e?.message ?? e);
  }
}

async function answerCallbackQuery(id: string, text = "", showAlert = false) {
  try {
    await fetch(`${API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, text, show_alert: showAlert }),
    });
  } catch (e) {
    console.warn("answerCallbackQuery failed", e?.message ?? e);
  }
}

// -------------------- Language Helper --------------------
// Returns messages based on the user's selected language
function getLocalizedMessage(userId: string, enMessage: string, ruMessage: string): string {
  const lang = getUserLanguage(userId).then(l => l);
  return lang === "RU" ? ruMessage : enMessage;
}

// Example localized messages object (can be expanded)
const messages: Record<string, Record<string, string>> = {
  welcome: {
    EN: "🌟 Welcome! Choose your language:",
    RU: "🌟 Добро пожаловать! Выберите язык:",
  },
  lang_selected: {
    EN: "Language set to English!",
    RU: "Язык установлен на русский!",
  },
  // Add more messages here...
};

// -------------------- Profile helpers --------------------
type Profile = {
  id: string;
  username?: string;
  displayName: string;
  trophies: number;
  stars: number; // Star balance
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  lastActive: number;
  lastLoginBonus: number; // Timestamp of last bonus claim
};

function getDisplayName(p: Profile) {
  if (p.username) return `@${p.username}`;
  return p.displayName && p.displayName !== "" ? p.displayName : `ID:${p.id}`;
}

async function initProfile(userId: string, username?: string, displayName?: string): Promise<{ profile: Profile; isNew: boolean }> {
  const key = ["profiles", userId];
  const res = await kv.get(key);
  if (!res.value) {
    const profile: Profile = {
      id: userId,
      username,
      displayName: displayName || `ID:${userId}`,
      trophies: 0,
      stars: 0,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      lastActive: Date.now(),
      lastLoginBonus: 0, // No bonus claimed yet
    };
    await kv.set(key, profile);
    return { profile, isNew: true };
  } else {
    const existing = res.value as Profile;
    let changed = false;
    if (username && username !== existing.username) {
      existing.username = username;
      changed = true;
    }
    if (displayName && displayName !== existing.displayName) {
      existing.displayName = displayName;
      changed = true;
    }
    existing.lastActive = Date.now();
    if (changed) {
      await kv.set(key, existing);
    }
    return { profile: existing, isNew: false };
  }
}

async function getProfile(userId: string): Promise<Profile | null> {
  const res = await kv.get(["profiles", userId]);
  return (res.value as Profile) ?? null;
}

async function updateProfile(userId: string, delta: Partial<Profile>) {
  const existing = (await getProfile(userId)) || (await initProfile(userId)).profile;
  const newProfile: Profile = {
    ...existing,
    username: delta.username ?? existing.username,
    displayName: delta.displayName ?? existing.displayName,
    trophies: Math.max(0, (existing.trophies || 0) + (delta.trophies ?? 0)),
    stars: Math.max(0, (existing.stars || 0) + (delta.stars ?? 0)),
    gamesPlayed: (existing.gamesPlayed || 0) + (delta.gamesPlayed ?? 0),
    wins: (existing.wins || 0) + (delta.wins ?? 0),
    losses: (existing.losses || 0) + (delta.losses ?? 0),
    draws: (existing.draws || 0) + (delta.draws ?? 0),
    lastActive: Date.now(),
    lastLoginBonus: delta.lastLoginBonus ?? existing.lastLoginBonus,
    id: existing.id,
  };
  await kv.set(["profiles", userId], newProfile);
  return newProfile;
}

async function sendProfile(chatId: string) {
  const p = (await getProfile(chatId))!;
  const winRate = p.gamesPlayed ? ((p.wins / p.gamesPlayed) * 100).toFixed(1) : "0";
  const lang = await getUserLanguage(chatId);
  const msg = `🏅 *Profile: ${getDisplayName(p)}*
🆔 ID: \`${p.id}\`
🏆 Trophies: *${p.trophies}*
⭐ Stars: *${p.stars}*
🎲 Games Played: *${p.gamesPlayed}*
✅ Wins: *${p.wins}* | ❌ Losses: *${p.losses}* | 🤝 Draws: *${p.draws}*
📈 Win Rate: *${winRate}%*`;

  await sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

// -------------------- Leaderboard helpers --------------------
async function getLeaderboard(top = 10, offset = 0): Promise<{ top: Profile[], total: number }> {
  const players: Profile[] = [];
  try {
    for await (const entry of kv.list({ prefix: ["profiles"] })) {
      if (!entry.value) continue;
      players.push(entry.value as Profile);
    }
  } catch (e) {
    console.error("getLeaderboard kv.list error", e);
  }
  players.sort((a, b) => {
    if (b.trophies !== a.trophies) return b.trophies - a.trophies;
    return b.wins - a.wins;
  });

  return { top: players.slice(offset, offset + top), total: players.length };
}

async function sendLeaderboard(chatId: string, page = 0) {
  const perPage = 10;
  const offset = page * perPage;
  const { top: topPlayers, total } = await getLeaderboard(perPage, offset);
  if (topPlayers.length === 0) {
    const msg = page === 0 ? "No players yet! Start playing to get on the leaderboard!" : "No more pages!";
    await sendMessage(chatId, msg);
    return;
  }
  let msg = `🏆 *Leaderboard* — Page ${page + 1}
`;
  topPlayers.forEach((p, i) => {
    const rankNum = offset + i + 1;
    const name = getDisplayName(p);
    const winRate = p.gamesPlayed ? ((p.wins / p.gamesPlayed) * 100).toFixed(1) : "0";
    msg += `*${rankNum}.* [${name}](tg://user?id=${p.id}) — 🏆 *${p.trophies}* | 📈 *${winRate}%*
`;
  });

  const keyboard: any = { inline_keyboard: [] };
  const row: any[] = [];
  if (page > 0) row.push({ text: "⬅️ Previous", callback_data: `leaderboard:${page - 1}` });
  if (offset + topPlayers.length < total) row.push({ text: "Next ➡️", callback_data: `leaderboard:${page + 1}` });
  if (row.length) keyboard.inline_keyboard.push(row);

  await sendMessage(chatId, msg, { reply_markup: keyboard, parse_mode: "Markdown" });
}

// -------------------- Game logic --------------------
function createEmptyBoard(): string[] {
  return Array(9).fill("");
}

function boardToText(board: string[]) {
  const map: any = { "": "▫️", X: "❌", O: "⭕" };
  let text = "
";
  for (let i = 0; i < 9; i += 3) {
    text += `${map[board[i]]}${map[board[i + 1]]}${map[board[i + 2]]}
`;
  }
  return text;
}

function checkWin(board: string[]) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a, b, c] };
    }
  }
  if (board.every((c) => c !== "")) return { winner: "draw" };
  return null;
}

function makeInlineKeyboard(board: string[], disabled = false) {
  const keyboard: any[] = [];
  for (let r = 0; r < 3; r++) {
    const row: any[] = [];
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      const cell = board[i];
      let text = cell === "X" ? "❌" : cell === "O" ? "⭕" : `${i + 1}`;
      const callback_data = disabled ? "noop" : `move:${i}`;
      row.push({ text, callback_data });
    }
    keyboard.push(row);
  }
  keyboard.push([{ text: "🏳️ Surrender", callback_data: "surrender" }]);
  return { inline_keyboard: keyboard };
}

// -------------------- Battle control --------------------
async function startBattle(p1: string, p2: string, isStarBattle: boolean = false, rounds: number = 3) {
  if (searchTimeouts[p1]) {
    clearTimeout(searchTimeouts[p1]);
    delete searchTimeouts[p1];
  }
  if (searchTimeouts[p2]) {
    clearTimeout(searchTimeouts[p2]);
    delete searchTimeouts[p2];
  }

  const battle = {
    players: [p1, p2],
    board: createEmptyBoard(),
    turn: p1, // Player 1 starts
    marks: { [p1]: "X", [p2]: "O" },
    messageIds: {} as Record<string, number>,
    idleTimerId: undefined as number | undefined,
    moveTimerId: undefined as number | undefined,
    round: 1,
    roundWins: { [p1]: 0, [p2]: 0 },
    isStarBattle: isStarBattle,
    rounds,
  };

  battles[p1] = battle;
  battles[p2] = battle;

  await initProfile(p1);
  await initProfile(p2);

  const battleTypeText = isStarBattle ? "⭐ *Star Match*" : "🏆 *Trophy Match*";
  const stakeText = isStarBattle ? "
Stakes: Both players stake 1 star. Winner gets +0.5 stars." : "";

  await sendMessage(p1, `${battleTypeText}
You are ❌ (X).${stakeText}
*Match Format:* Best of ${rounds} rounds vs ID:${p2}`, { parse_mode: "Markdown" });
  await sendMessage(p2, `${battleTypeText}
You are ⭕ (O).${stakeText}
*Match Format:* Best of ${rounds} rounds vs ID:${p1}`, { parse_mode: "Markdown" });

  await sendRoundStart(battle);
}

function headerForPlayer(battle: any, player: string) {
  const opponent = battle.players.find((p: string) => p !== player)!;
  const yourMark = battle.marks[player];
  const opponentMark = battle.marks[opponent];
  const battleTypeText = battle.isStarBattle ? "⭐ *Star Match*" : "🏆 *Trophy Match*";
  return `${battleTypeText} — You (${yourMark}) vs ID:${opponent} (${opponentMark})`;
}

async function endTurnIdle(battle: any) {
  const loser = battle.turn;
  const winner = battle.players.find((p: string) => p !== loser)!;
  await sendMessage(loser, "⚠️ You ran out of time. You surrendered.");
  await sendMessage(winner, "⚠️ Opponent ran out of time. You won!");
  if (battle.idleTimerId) {
    clearTimeout(battle.idleTimerId);
    delete battle.idleTimerId;
  }
  if (battle.moveTimerId) {
    clearTimeout(battle.moveTimerId);
    delete battle.moveTimerId;
  }
  await finishMatch(battle, { winner: winner, loser: loser });
}

async function sendRoundStart(battle: any) {
  for (const player of battle.players) {
    const header = headerForPlayer(battle, player);
    const yourTurn = battle.turn === player;
    const text =
      `${header}
` +
      `*Round ${battle.round}/${battle.rounds}*
` +
      `📊 Score: ${battle.roundWins[battle.players[0]]} - ${battle.roundWins[battle.players[1]]}
` +
      `🎲 Turn: ${yourTurn ? "*Your turn*" : "Opponent's turn"}
` +
      boardToText(battle.board);
    const msgId = await sendMessage(player, text, { reply_markup: makeInlineKeyboard(battle.board), parse_mode: "Markdown" });
    if (msgId) battle.messageIds[player] = msgId;
  }

  // Set idle timer for the entire match
  if (battle.idleTimerId) {
    clearTimeout(battle.idleTimerId);
  }
  battle.idleTimerId = setTimeout(() => endBattleIdle(battle), 3 * 60 * 1000); // 3 minutes idle

  // Set move timer for the current player
  if (battle.moveTimerId) {
    clearTimeout(battle.moveTimerId);
  }
  battle.moveTimerId = setTimeout(() => endTurnIdle(battle), 30 * 1000); // 30 seconds per move
}

async function endBattleIdle(battle: any) {
  const [p1, p2] = battle.players;
  await sendMessage(p1, "⚠️ Match ended due to inactivity (3 minutes).");
  await sendMessage(p2, "⚠️ Match ended due to inactivity (3 minutes).");

  // Refund stars if it was a star match
  if (battle.isStarBattle) {
    await updateProfile(p1, { stars: 1 });
    await updateProfile(p2, { stars: 1 });
    await sendMessage(p1, "💸 Inactivity refund: 1 star returned.");
    await sendMessage(p2, "💸 Inactivity refund: 1 star returned.");
  }

  // Clean up battle state
  delete battles[p1];
  delete battles[p2];
}

async function finishMatch(battle: any, result: { winner?: string; loser?: string; draw?: boolean }) {
  try {
    // Clear timers
    if (battle.idleTimerId) {
      clearTimeout(battle.idleTimerId);
      delete battle.idleTimerId;
    }
    if (battle.moveTimerId) {
      clearTimeout(battle.moveTimerId);
      delete battle.moveTimerId;
    }

    const [p1, p2] = battle.players;

    // Update message for both players
    for (const player of battle.players) {
      const msgId = battle.messageIds[player];
      const header = headerForPlayer(battle, player);
      let text: string;
      if (result.draw) {
        text = `${header}
*Match Result:* 🤝 *Draw!*
${boardToText(battle.board)}`;
      } else if (result.winner === player) {
        text = `${header}
*Match Result:* 🎉 *You won!*
${boardToText(battle.board)}`;
      } else {
        text = `${header}
*Match Result:* 😢 *You lost.*
${boardToText(battle.board)}`;
      }
      if (msgId) {
        await editMessageText(player, msgId, text, { reply_markup: makeInlineKeyboard(battle.board, true), parse_mode: "Markdown" });
      } else {
        await sendMessage(player, text, { parse_mode: "Markdown" });
      }
    }

    if (result.draw) {
      // Update stats for draw
      await updateProfile(p1, { gamesPlayed: 1, draws: 1 });
      await updateProfile(p2, { gamesPlayed: 1, draws: 1 });
      await sendMessage(p1, "🤝 The match was a draw!");
      await sendMessage(p2, "🤝 The match was a draw!");

      // Refund stars on draw if it was a star match
      if (battle.isStarBattle) {
        await updateProfile(p1, { stars: 1 });
        await updateProfile(p2, { stars: 1 });
        await sendMessage(p1, "💸 Draw refund: 1 star returned.");
        await sendMessage(p2, "💸 Draw refund: 1 star returned.");
      }
    } else if (result.winner) {
      const winner = result.winner!;
      const loser = result.loser!;
      await initProfile(winner);
      await initProfile(loser);

      // Update stats based on match type
      if (battle.isStarBattle) {
        await updateProfile(winner, { gamesPlayed: 1, wins: 1, stars: 1.5 }); // 1.5 = 1 stake back + 0.5 win bonus
        await updateProfile(loser, { gamesPlayed: 1, losses: 1, stars: -1 }); // -1 for losing stake
        await sendMessage(winner, `🎉 You won the match!
⭐ *+0.5 stars!*`);
        await sendMessage(loser, `😢 You lost the match.
⭐ *-1 star.*`);
      } else { // Trophy match
        await updateProfile(winner, { gamesPlayed: 1, wins: 1, trophies: 1 });
        await updateProfile(loser, { gamesPlayed: 1, losses: 1, trophies: -1 });
        await sendMessage(winner, `🎉 You won the match!
🏆 *+1 trophy!*`);
        await sendMessage(loser, `😢 You lost the match.
🏆 *-1 trophy.*`);
      }
    }

    // Clean up battle state
    delete battles[p1];
    delete battles[p2];
  } catch (err) {
    console.error("finishMatch error:", err);
  }
}

// -------------------- Callback handler --------------------
async function handleCallback(cb: any) {
  const fromId = String(cb.from.id);
  const data = cb.data ?? null;
  const callbackId = cb.id;

  if (!data) {
    await answerCallbackQuery(callbackId);
    return;
  }

  // Handle language selection callback
  if (data.startsWith("set_lang:")) {
    const lang = data.split(":")[1];
    if (lang === "EN" || lang === "RU") {
      await setUserLanguage(fromId, lang);
      const msg = lang === "EN" ? "Language set to English!" : "Язык установлен на русский!";
      await sendMessage(fromId, msg);
      await showMainMenu(fromId); // Show main menu after language selection
    }
    await answerCallbackQuery(callbackId);
    return;
  }

  // Handle leaderboard pagination
  if (data.startsWith("leaderboard:")) {
    const page = parseInt(data.split(":")[1]) || 0;
    await sendLeaderboard(fromId, page);
    await answerCallbackQuery(callbackId);
    return;
  }

  // Handle no-op clicks (disabled buttons)
  if (data === "noop") {
    await answerCallbackQuery(callbackId);
    return;
  }

  // Check if user is in a battle
  const battle = battles[fromId];
  if (!battle) {
    if (data === "surrender") {
      await answerCallbackQuery(callbackId, "You are not in a game.", true);
    }
    await answerCallbackQuery(callbackId);
    return;
  }

  // Reset move timer as user made a move
  if (battle.moveTimerId) {
    clearTimeout(battle.moveTimerId);
    battle.moveTimerId = setTimeout(() => endTurnIdle(battle), 30 * 1000);
  }

  // Handle surrender
  if (data === "surrender") {
    const opponent = battle.players.find((p: string) => p !== fromId)!;
    await sendMessage(fromId, "🏳️ You surrendered.");
    await sendMessage(opponent, "🏳️ Opponent surrendered. You won!");
    await finishMatch(battle, { winner: opponent, loser: fromId });
    await answerCallbackQuery(callbackId, "You surrendered.");
    return;
  }

  // Handle move
  if (data.startsWith("move:")) {
    const idx = parseInt(data.split(":")[1]);
    if (isNaN(idx) || idx < 0 || idx > 8) {
      await answerCallbackQuery(callbackId, "Invalid move.", true);
      return;
    }

    if (battle.turn !== fromId) {
      await answerCallbackQuery(callbackId, "Not your turn.", true);
      return;
    }

    if (battle.board[idx] !== "") {
      await answerCallbackQuery(callbackId, "Cell already occupied.", true);
      return;
    }

    const mark = battle.marks[fromId];
    battle.board[idx] = mark;

    const winResult = checkWin(battle.board);
    let roundWinner: string | undefined;
    if (winResult) {
      const { winner, line } = winResult as any;
      if (winner !== "draw") {
        roundWinner = battle.players.find((p: string) => battle.marks[p] === winner)!;
        battle.roundWins[roundWinner] = (battle.roundWins[roundWinner] || 0) + 1;
      }

      let boardText = boardToText(battle.board);
      if (line) {
        boardText += `
🎉 *Line:* ${line.map((i: number) => i + 1).join("-")}`;
      } else if (winner === "draw") {
        boardText += `
🤝 *Draw!*`;
      }

      // Send round result to both players
      for (const player of battle.players) {
        const msgId = battle.messageIds[player];
        const header = headerForPlayer(battle, player);
        let text = `${header}
*Round ${battle.round} Result!*
`;
        if (winner === "draw") text += `🤝 Round was a draw!
`;
        else text += `${roundWinner === player ? "🎉 You won the round!" : "😢 You lost the round"}
`;
        text += `📊 Score: ${battle.roundWins[battle.players[0]]} - ${battle.roundWins[battle.players[1]]}
${boardText}`;
        if (msgId) await editMessageText(player, msgId, text, { reply_markup: makeInlineKeyboard(battle.board, true), parse_mode: "Markdown" });
        else await sendMessage(player, text, { parse_mode: "Markdown" });
      }

      // Check if match is over (best of 3)
      const neededWins = Math.ceil(battle.rounds / 2);
      if (battle.roundWins[battle.players[0]] >= neededWins || battle.roundWins[battle.players[1]] >= neededWins || battle.round === battle.rounds) {
        if (battle.roundWins[battle.players[0]] > battle.roundWins[battle.players[1]]) {
          await finishMatch(battle, { winner: battle.players[0], loser: battle.players[1] });
        } else if (battle.roundWins[battle.players[1]] > battle.roundWins[battle.players[0]]) {
          await finishMatch(battle, { winner: battle.players[1], loser: battle.players[0] });
        } else {
          await finishMatch(battle, { draw: true }); // If rounds finish and scores are tied
        }
        await answerCallbackQuery(callbackId);
        return;
      }

      // Prepare for next round
      battle.round++;
      battle.board = createEmptyBoard();
      battle.turn = battle.players[(battle.round - 1) % 2]; // Alternate turns
      if (battle.moveTimerId) clearTimeout(battle.moveTimerId);
      battle.moveTimerId = setTimeout(() => endTurnIdle(battle), 30 * 1000);
      await sendRoundStart(battle);
      await answerCallbackQuery(callbackId, "Move made!");
      return;
    }

    // Continue the game, switch turns
    battle.turn = battle.players.find((p: string) => p !== fromId)!;
    for (const player of battle.players) {
      const header = headerForPlayer(battle, player);
      const yourTurn = battle.turn === player;
      const text =
        `${header}
` +
        `*Round: ${battle.round}/${battle.rounds}*
` +
        `📊 Score: ${battle.roundWins[battle.players[0]]} - ${battle.roundWins[battle.players[1]]}
` +
        `🎲 Turn: ${yourTurn ? "*Your turn*" : "Opponent's turn"}
` +
        boardToText(battle.board);
      const msgId = battle.messageIds[player];
      if (msgId) await editMessageText(player, msgId, text, { reply_markup: makeInlineKeyboard(battle.board), parse_mode: "Markdown" });
      else await sendMessage(player, text, { reply_markup: makeInlineKeyboard(battle.board), parse_mode: "Markdown" });
    }
    await answerCallbackQuery(callbackId, "Move made!");
    return;
  }

  // Default callback answer if no other condition matches
  await answerCallbackQuery(callbackId);
}

// -------------------- Daily Login Bonus --------------------
async function claimDailyBonus(userId: string): Promise<boolean> {
  const profile = await getProfile(userId);
  if (!profile) return false;

  const now = Date.now();
  const lastBonus = profile.lastLoginBonus;
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (now - lastBonus >= oneDayMs) {
    await updateProfile(userId, { stars: 0.1, lastLoginBonus: now }); // Give 0.1 star daily
    return true;
  }
  return false;
}

// -------------------- Show main menu --------------------
async function showMainMenu(fromId: string) {
  const userCount = await getUserCount();
  const lang = await getUserLanguage(fromId);
  const helpText = lang === "RU" ?
    `🌟 Привет! Добро пожаловать в TkmXO BOT!
🎮 Играйте в крестики-нолики, соревнуйтесь и зарабатывайте. ⚔️
🎁 За победу в трофейном матче вы получаете +1 трофей, за поражение -1 трофей.
⭐ За победу в звездном матче вы получаете +0.5 звезд (возвращается 1 заложенная звезда + 0.5 бонус).
👥 Пригласите друзей и зарабатывайте звезды!
👥 Всего пользователей: ${userCount}
🚀 Выберите команду:` :
    `🌟 Welcome! Welcome to TkmXO BOT!
🎮 Play Tic-Tac-Toe, battle, and earn. ⚔️
🎁 Win a trophy match to get +1 trophy, lose to get -1 trophy.
⭐ Win a star match to get +0.5 stars (1 staked star back + 0.5 bonus).
👥 Invite friends and earn stars!
👥 Total users: ${userCount}
🚀 Choose a command:`;

  const mainMenu = {
    inline_keyboard: [
      [{ text: "🏆 Trophy Match", callback_data: "menu:battle" }, { text: "⭐ Star Match", callback_data: "menu:realbattle" }],
      [{ text: "📊 Profile", callback_data: "menu:profile" }, { text: "🏆 Leaderboard", callback_data: "menu:leaderboard" }],
      [{ text: "💸 Withdraw Stars", callback_data: "menu:withdraw" }, { text: "🎁 Daily Bonus", callback_data: "menu:daily" }],
    ]
  };
  await sendMessage(fromId, helpText, { parse_mode: "Markdown", reply_markup: mainMenu });
}

// -------------------- Withdrawal functionality --------------------
async function handleWithdrawal(fromId: string, text: string) {
  const state = await getWithdrawalState(fromId);
  if (state) {
    if (state.step === "amount") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        await sendMessage(fromId, "❌ Amount must be a positive number.");
        return;
      }
      if (amount < 50) {
        await sendMessage(fromId, "❌ Minimum withdrawal is 50 stars.");
        return;
      }
      const profile = await getProfile(fromId);
      if (!profile || profile.stars < amount) {
        await sendMessage(fromId, `❌ Insufficient stars. Balance: ${profile?.stars ?? 0} stars.`);
        await setWithdrawalState(fromId, null);
        return;
      }
      await setWithdrawalState(fromId, { amount, step: "phone" });
      await sendMessage(fromId, "📱 Enter your phone number:");
      return;
    } else if (state.step === "phone") {
      const phoneNumber = text.trim();
      if (phoneNumber.length < 5) { // Basic check
        await sendMessage(fromId, "❌ Enter a valid phone number.");
        return;
      }
      const amount = state.amount;
      const profile = await getProfile(fromId);
      if (!profile || profile.stars < amount) {
        await sendMessage(fromId, "❌ Insufficient balance. Please try again.");
        await setWithdrawalState(fromId, null);
        return;
      }
      try {
        await updateProfile(fromId, { stars: -amount });
        await sendMessage(
          fromId,
          `✅ Withdrawal request submitted! Amount: ${amount} stars
Phone: ${phoneNumber}
Processing...`,
        );
        // Find admin profile to send request
        const adminProfile = await getProfileByUsername(ADMIN_USERNAME);
        const adminId = adminProfile?.id || `@${ADMIN_USERNAME}`; // Fallback to username if ID not found
        const userDisplayName = getDisplayName(profile);
        const adminMessage = `💰 *WITHDRAWAL REQUEST*
User: ${userDisplayName} (ID: ${fromId})
Amount: ${amount} stars
Phone: ${phoneNumber}
Action required: Use inline button to complete.`;
        await sendMessage(adminId, adminMessage, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Complete", callback_data: `complete_withdrawal:${fromId}:${amount}` }]
            ]
          }
        });
        await setWithdrawalState(fromId, null);
      } catch (error) {
        console.error("Withdrawal error:", error);
        await sendMessage(fromId, "❌ An error occurred. Please try again.");
        await setWithdrawalState(fromId, null);
      }
      return;
    }
  } else {
    await sendMessage(fromId, "💰 Enter the amount of stars to withdraw:");
    await setWithdrawalState(fromId, { amount: 0, step: "amount" });
    return;
  }
}

async function getProfileByUsername(username: string): Promise<Profile | null> {
  try {
    for await (const entry of kv.list({ prefix: ["profiles"] })) {
      const profile = entry.value as Profile;
      if (!profile) continue;
      if (profile.username === username) return profile;
    }
  } catch (e) {
    console.error("getProfileByUsername error", e);
  }
  return null;
}

// -------------------- Admin Panel --------------------
async function sendStats(chatId: string) {
  let userCount = 0;
  let totalGamesPlayed = 0;
  let totalTrophies = 0;
  let totalStars = 0;
  let totalStarsWithdrawn = 0; // Assuming this is tracked separately if needed

  for await (const entry of kv.list({ prefix: ["profiles"] })) {
    if (!entry.value) continue;
    const p = entry.value as Profile;
    userCount++;
    totalGamesPlayed += p.gamesPlayed || 0;
    totalTrophies += p.trophies || 0;
    totalStars += p.stars || 0;
  }

  const msg =
    `📊 *Bot Statistics*
` +
    `👥 Total Users: *${userCount}*
` +
    `🎲 Total Games Played: *${totalGamesPlayed}*
` +
    `🏆 Total Trophies: *${totalTrophies}*
` +
    `⭐ Total Stars in Circulation: *${totalStars}*
` +
    `⭐ Total Stars Withdrawn: *${totalStarsWithdrawn}*`; // Placeholder, implement if tracking separately

  await sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

async function handleAdminCommand(fromId: string, text: string) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0];

  if (cmd === "/admin" || cmd === "/adminpanel") {
    await sendMessage(fromId, `Admin Panel:
/stats - View bot stats
/profile <userId> - View user profile
/addstars <userId> <amount> - Add stars to user
/subtractstars <userId> <amount> - Remove stars from user
/addtrophies <userId> <amount> - Add trophies to user
/subtracttrophies <userId> <amount> - Remove trophies from user
`);
    return;
  }

  if (cmd === "/stats") {
    await sendStats(fromId);
    return;
  }

  if (cmd === "/profile") {
    if (parts.length < 2) {
      await sendMessage(fromId, "Usage: /profile <userId>");
      return;
    }
    const userId = parts[1];
    await sendUserProfile(fromId, userId);
    return;
  }

  if (cmd === "/addstars" || cmd === "/subtractstars") {
    if (parts.length < 3) {
      await sendMessage(fromId, `Usage: ${cmd} <userId> <amount>`);
      return;
    }
    const userId = parts[1];
    const amount = parseFloat(parts[2]);
    if (isNaN(amount)) {
      await sendMessage(fromId, "Invalid amount.");
      return;
    }
    const updateAmount = cmd === "/addstars" ? amount : -amount;
    await updateProfile(userId, { stars: updateAmount });
    await sendMessage(fromId, `Updated ${updateAmount} stars for ID:${userId}`);
    return;
  }

  if (cmd === "/addtrophies" || cmd === "/subtracttrophies") {
    if (parts.length < 3) {
      await sendMessage(fromId, `Usage: ${cmd} <userId> <amount>`);
      return;
    }
    const userId = parts[1];
    const amount = parseFloat(parts[2]);
    if (isNaN(amount)) {
      await sendMessage(fromId, "Invalid amount.");
      return;
    }
    const updateAmount = cmd === "/addtrophies" ? amount : -amount;
    await updateProfile(userId, { trophies: updateAmount });
    await sendMessage(fromId, `Updated ${updateAmount} trophies for ID:${userId}`);
    return;
  }

  await sendMessage(fromId, "Unknown admin command. Use /admin for help.");
}

// Admin panel helper to send user profile to admin
async function sendUserProfile(adminChatId: string, userId: string) {
  const p = await getProfile(userId);
  if (!p) {
    await sendMessage(adminChatId, `❌ User ID:${userId} not found.`);
    return;
  }
  const winRate = p.gamesPlayed ? ((p.wins / p.gamesPlayed) * 100).toFixed(1) : "0";
  const msg =
    `🏅 *Profile: ${getDisplayName(p)}*
` +
    `🆔 ID: \`${p.id}\`
` +
    `🏆 Trophies: *${p.trophies}*
` +
    `⭐ Stars: *${p.stars}*
` +
    `🎲 Games Played: *${p.gamesPlayed}*
` +
    `✅ Wins: *${p.wins}* | ❌ Losses: *${p.losses}* | 🤝 Draws: *${p.draws}*
` +
    `📈 Win Rate: *${winRate}%*`;

  await sendMessage(adminChatId, msg, { parse_mode: "Markdown" });
}

// Admin panel helper to complete withdrawal
async function completeWithdrawal(adminId: string, userId: string, amount: number) {
  await sendMessage(userId, `✅ Your withdrawal of ${amount} stars has been processed and completed.`);
  await sendMessage(adminId, `✅ Withdrawal for ID:${userId} completed.`);
  // No need to update stars here as they were already deducted
}

// -------------------- User count helper --------------------
async function getUserCount(): Promise<number> {
  let count = 0;
  try {
    for await (const entry of kv.list({ prefix: ["profiles"] })) {
      if (!entry.value) continue;
      count++;
    }
  } catch (e) {
    console.error("getUserCount error", e);
  }
  return count;
}

// -------------------- Commands --------------------
async function handleCommand(fromId: string, username: string | undefined, displayName: string, text: string) {
  // Close any active states before handling new command
  if (await getWithdrawalState(fromId)) {
    await sendMessage(fromId, "Withdrawal process cancelled.");
    await setWithdrawalState(fromId, null);
  }

  if (text.startsWith("/start")) {
    // Check if user already has a language set
    const userLang = await getUserLanguage(fromId);
    if (userLang === "EN" || userLang === "RU") {
      // If language is already set, show main menu
      await showMainMenu(fromId);
    } else {
      // If not, prompt for language selection
      const langKeyboard = {
        inline_keyboard: [
          [{ text: "English (EN)", callback_data: "set_lang:EN" }],
          [{ text: "Русский (RU)", callback_data: "set_lang:RU" }]
        ]
      };
      await sendMessage(fromId, "🌟 Welcome! Choose your language:", { reply_markup: langKeyboard });
    }
    return;
  }

  if (text.startsWith("/battle")) {
    if (queue.includes(fromId) || starQueue.includes(fromId)) {
      await sendMessage(fromId, "You are already in a queue.");
      return;
    }
    if (battles[fromId]) {
      await sendMessage(fromId, "You are already in a game.");
      return;
    }
    queue.push(fromId);
    await sendMessage(fromId, "🔍 Searching for an opponent...");
    searchTimeouts[fromId] = setTimeout(async () => {
      const index = queue.indexOf(fromId);
      if (index !== -1) {
        queue.splice(index, 1);
        delete searchTimeouts[fromId];
        await sendMessage(fromId, "⏱️ Search timed out. No opponent found.");
      }
    }, 30_000) as unknown as number;
    if (queue.length >= 2) {
      const [p1, p2] = queue.splice(0, 2);
      await startBattle(p1, p2, false); // false for trophy match
    }
    return;
  }

  if (text.startsWith("/realbattle")) {
    const profile = await getProfile(fromId);
    if (!profile || profile.stars < 1) {
      await sendMessage(fromId, "❌ You need at least 1 star to play a star match.");
      return;
    }
    if (queue.includes(fromId) || starQueue.includes(fromId)) {
      await sendMessage(fromId, "You are already in a queue.");
      return;
    }
    if (battles[fromId]) {
      await sendMessage(fromId, "You are already in a game.");
      return;
    }
    await updateProfile(fromId, { stars: -1 }); // Deduct stake
    starQueue.push(fromId);
    await sendMessage(fromId, "🔍 Searching for an opponent... (1 star staked)");
    searchTimeouts[fromId] = setTimeout(async () => {
      const index = starQueue.indexOf(fromId);
      if (index !== -1) {
        starQueue.splice(index, 1);
        await updateProfile(fromId, { stars: 1 }); // Refund if not found
        await sendMessage(fromId, "⏱️ Search timed out. 1 star refunded.");
        delete searchTimeouts[fromId];
      }
    }, 30_000) as unknown as number;
    if (starQueue.length >= 2) {
      const [p1, p2] = starQueue.splice(0, 2);
      await startBattle(p1, p2, true); // true for star match
    }
    return;
  }

  if (text.startsWith("/profile")) {
    await sendProfile(fromId);
    return;
  }

  if (text.startsWith("/leaderboard")) {
    await sendLeaderboard(fromId, 0);
    return;
  }

  if (text.startsWith("/withdraw")) {
    const profile = await getProfile(fromId);
    if (!profile) {
      await sendMessage(fromId, "❌ Profile not found. Play a game first!");
      return;
    }
    if (profile.stars < 50) {
      await sendMessage(fromId, "❌ Minimum withdrawal is 50 stars.");
      return;
    }
    await handleWithdrawal(fromId, "");
    return;
  }

  if (text.startsWith("/daily")) {
    const success = await claimDailyBonus(fromId);
    if (success) {
      await sendMessage(fromId, "🎁 Daily bonus claimed! +0.1 stars added to your balance.");
    } else {
      await sendMessage(fromId, "⏰ You have already claimed your daily bonus today. Try again tomorrow.");
    }
    return;
  }

  if (text.startsWith("/admin") || text.startsWith("/adminpanel")) {
    if (username !== ADMIN_USERNAME) {
      await sendMessage(fromId, "❌ Unauthorized.");
      return;
    }
    await handleAdminCommand(fromId, text);
    return;
  }

  if (text.startsWith("/help")) {
    await showMainMenu(fromId);
    return;
  }

  await sendMessage(fromId, "❓ Unknown command. Use /help for options.");
}

// -------------------- Server / Webhook --------------------
serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    if (url.pathname !== SECRET_PATH) return new Response("Not found", { status: 404 });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const update = await req.json();

    // Handle normal messages
    if (update.message) {
      const msg = update.message;
      if (msg.chat.type !== "private") return new Response("OK"); // Ignore group chats
      const from = msg.from;
      const text = (msg.text || "").trim();
      const fromId = String(from.id);
      const username = from.username;
      const displayName = from.first_name || from.username || fromId;

      const { profile, isNew } = await initProfile(fromId, username, displayName);

      if (text.startsWith("/")) {
        await handleCommand(fromId, username, displayName, text);
      } else if (await getWithdrawalState(fromId)) {
        await handleWithdrawal(fromId, text);
      } else {
        await sendMessage(fromId, "❓ Unknown command. Use /help for options.");
      }
    }

    // Handle callback queries (inline buttons)
    else if (update.callback_query) {
      const cb = update.callback_query;
      const fromId = String(cb.from.id);
      const username = cb.from.username;
      const displayName = cb.from.first_name || cb.from.username || fromId;

      // Check if admin is completing a withdrawal
      if (username === ADMIN_USERNAME && cb.data?.startsWith("complete_withdrawal:")) {
        const parts = cb.data.split(":");
        if (parts.length === 3) {
          const userId = parts[1];
          const amount = parseFloat(parts[2]);
          if (!isNaN(amount)) {
            await completeWithdrawal(fromId, userId, amount);
            await answerCallbackQuery(cb.id, "Withdrawal completed.");
            return new Response("OK");
          }
        }
      }

      // Otherwise, handle general callback
      await handleCallback(cb);
    }

    return new Response("OK");
  } catch (e) {
    console.error("Server error", e);
    return new Response("Error", { status: 500 });
  }
});
```