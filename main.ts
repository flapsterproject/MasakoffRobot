// main.ts
// 🤖 Masakoff Sarcastic Bot with Group Message Tracking + Reply Relationship Analysis
// 💾 Stores per-user and per-group messages in Deno KV (timestamps in Ashgabat time)
// 💬 Replies in groups only once every 5th message (unless @MasakoffRobot is mentioned)
// 👤 Users can delete their own data in private with /delete, admins can delete others' data

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GoogleGenerativeAI } from "npm:@google/generative-ai@^0.19.0";

// -------------------- Telegram Setup --------------------
const TOKEN = Deno.env.get("BOT_TOKEN");
const API = `https://api.telegram.org/bot${TOKEN}`;

// -------------------- Gemini Setup --------------------
const GEMINI_API_KEY = "AIzaSyDfowIZzG7XuYwraMtjhtxi76ZP6oFSNdw";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// -------------------- Deno KV --------------------
const kv = await Deno.openKv();

// -------------------- Admins --------------------
const ADMINS = ["Masakoff"]; // Add more usernames if needed

// -------------------- Helpers --------------------
async function sendMessage(chatId: string | number, text: string, replyToMessageId?: number) {
  try {
    await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_to_message_id: replyToMessageId,
        allow_sending_without_reply: true,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    console.error("Failed to send message:", err);
  }
}

function ashgabatNowISO() {
  try {
    const dt = new Date();
    const local = dt.toLocaleString("sv-SE", { timeZone: "Asia/Ashgabat" }).replace(" ", "T");
    return `${local}+05:00`;
  } catch {
    const dt = new Date(Date.now() + 5 * 60 * 60 * 1000);
    return dt.toISOString();
  }
}

// -------------------- User Storage --------------------
async function getUserHistory(username: string): Promise<string[]> {
  const key = ["user", username];
  const data = await kv.get<string[]>(key);
  return data?.value || [];
}

async function saveUserMessage(username: string, message: string) {
  const key = ["user", username];
  const history = (await getUserHistory(username)) || [];
  history.push(message);
  await kv.set(key, history);
}

async function deleteUserHistory(username: string) {
  const key = ["user", username];
  const existing = await kv.get(key);
  if (existing?.value) {
    await kv.delete(key);
    console.log(`🗑 Deleted storage for user: ${username}`);
  } else {
    console.log(`⚠️ No storage found for user: ${username}`);
  }
}

// -------------------- Group Storage --------------------
type GroupMessage = {
  message_id: number;
  username: string;
  user_id?: number | string;
  text?: string;
  timestampAshgabat: string;
  replied_to_message_id?: number;
  replied_to_username?: string;
  replied_to_user_id?: number | string;
  replied_to_is_bot?: boolean;
  is_bot?: boolean;
};

async function getGroupHistory(chatId: string): Promise<GroupMessage[]> {
  const key = ["group", chatId];
  const data = await kv.get<GroupMessage[]>(key);
  return data?.value || [];
}

async function saveGroupMessage(chatId: string, msg: GroupMessage) {
  const key = ["group", chatId];
  const history = (await getGroupHistory(chatId)) || [];
  history.push(msg);
  const truncated = history.slice(-200);
  await kv.set(key, truncated);
}

// -------------------- Group Counter --------------------
async function incrementGroupCounter(chatId: string): Promise<number> {
  const key = ["group_count", chatId];
  const data = await kv.get<number>(key);
  const current = data?.value ?? 0;
  const next = current + 1;
  if (next >= 5) {
    await kv.set(key, 0);
    return 5;
  } else {
    await kv.set(key, next);
    return next;
  }
}

async function resetGroupCounter(chatId: string) {
  const key = ["group_count", chatId];
  await kv.set(key, 0);
}

// -------------------- Gemini Response Generator --------------------
async function generateResponse(prompt: string, isCreator: boolean, userHistory: string[], analysis?: string): Promise<string> {
  try {
    const style = isCreator
      ? `Respond as a witty, realistic human — use sarcasm, keep it very short (1–2 sentences), add emojis, and write naturally in Turkmen, as if chatting with a friend online.And you are @MasakoffRobot`
      : `Respond as a witty, realistic human — use sarcasm, keep it very short (1–2 sentences), add emojis, and write naturally in Turkmen, as if chatting with a friend online.And you are @MasakoffRobot`;

    let context = "";
    if (userHistory?.length) {
      context += `User's recent messages:\n${userHistory.slice(-10).map((m, i) => `${i + 1}. ${m}`).join("\n")}\n`;
    }
    if (analysis) context += `Group analysis:\n${analysis}\n`;
    context += `Now craft a <1-2 sentence> sarcastic reply to: "${prompt}"`;

    const result = await model.generateContent(`${style}\n${context}`);
    const text = typeof result.response.text === "function" ? result.response.text() : result.response;
    return;        //return (text as string) || "🤖 Meniň limitim gutardy 😅";
  } catch (err) {
    console.error("Gemini error:", err);
    return;        //return "🤖 Meniň limitim gutardy 😅";
  }
}

// -------------------- Group Message Analysis --------------------
function analyzeGroupMessagesForReply(history: GroupMessage[], currentMsg: GroupMessage) {
  const last = history.slice(-10);
  const counts: Record<string, number> = {};
  for (const m of last) counts[m.username] = (counts[m.username] || 0) + 1;
  const topActive = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([u, c]) => `${u}(${c})`)
    .join(", ") || "none";

  const repliedTo = currentMsg.replied_to_username || "no one";
  const repliedToIsBot = currentMsg.replied_to_is_bot ? "yes" : "no";

  const pairs: string[] = [];
  for (const m of last) if (m.replied_to_username) pairs.push(`${m.username}->${m.replied_to_username}`);
  const uniquePairs = Array.from(new Set(pairs)).slice(0, 10).join(", ") || "none";

  return [
    `Current message author: ${currentMsg.username}.`,
    `Replied to: ${repliedTo}. Replied-to-is-bot: ${repliedToIsBot}.`,
    `Top active users (last 10): ${topActive}.`,
    `Recent reply pairs: ${uniquePairs}.`,
    `Timestamp (Ashgabat): ${currentMsg.timestampAshgabat}.`,
  ].join("\n");
}

// -------------------- Webhook Handler --------------------
serve(async (req) => {
  try {
    const update = await req.json();
    if (!update?.message && !update?.edited_message) return new Response("ok");

    const msg = update.message || update.edited_message;
    const chatId = String(msg.chat.id);
    const text = msg.text || msg.caption || "";
    const messageId = msg.message_id;
    const username = msg.from?.username || msg.from?.first_name || "unknown";
    const userId = msg.from?.id;
    const isAdmin = ADMINS.includes(username.replace("@", ""));
    const isCreator = username.replace("@", "") === "Masakoff";
    const chatType = msg.chat.type;
    const isPrivate = chatType === "private";

    const repliedToMsg = msg.reply_to_message;
    const repliedToUsername = repliedToMsg?.from?.username || repliedToMsg?.from?.first_name;
    const repliedToUserId = repliedToMsg?.from?.id;
    const repliedToIsBot = Boolean(repliedToMsg?.from?.is_bot);

    // --- Private delete ---
    if (isPrivate && text.trim() === "/delete") {
      await deleteUserHistory(username);
      await sendMessage(chatId, "🗑 Siziň maglumatlaryňyz pozuldy.", messageId);
      return new Response("ok");
    }

    // --- Admin delete ---
    if (text.startsWith("/delete ")) {
      if (!isAdmin) {
        await sendMessage(chatId, "🚫 Seniň muny etmäge hakyň ýok!", messageId);
        return new Response("ok");
      }
      const parts = text.split(/\s+/);
      const targetUser = parts[1]?.replace("@", "").trim();
      if (!targetUser) {
        await sendMessage(chatId, "ℹ️ Ulanyş: /delete <username>", messageId);
        return new Response("ok");
      }
      await deleteUserHistory(targetUser);
      await sendMessage(chatId, `@${targetUser} 🗑 maglumatlaryň pozuldy.`, messageId);
      return new Response("ok");
    }

    const recordedText = text?.trim() || "[non-text]";
    await saveUserMessage(username, recordedText);

    // --- Group Handling ---
    if (chatType === "group" || chatType === "supergroup") {
      const groupMsg: GroupMessage = {
        message_id: messageId,
        username,
        user_id: userId,
        text: recordedText,
        timestampAshgabat: ashgabatNowISO(),
        replied_to_message_id: repliedToMsg?.message_id,
        replied_to_username: repliedToUsername,
        replied_to_user_id: repliedToUserId,
        replied_to_is_bot: repliedToIsBot,
        is_bot: Boolean(msg.from?.is_bot),
      };
      await saveGroupMessage(chatId, groupMsg);

      const mentionedBot = recordedText.includes("@MasakoffRobot");
      let shouldReply = false;
      let forcedByMention = false;
      if (mentionedBot) {
        shouldReply = true;
        forcedByMention = true;
        await resetGroupCounter(chatId);
      } else {
        const count = await incrementGroupCounter(chatId);
        if (count === 5) shouldReply = true;
      }

      if (!shouldReply) return new Response("ok");

      const groupHistory = await getGroupHistory(chatId);
      const analysis = analyzeGroupMessagesForReply(groupHistory, groupMsg);

      let analysisHint = "";
      const repliedToIsProbablyBot = Boolean(groupMsg.replied_to_is_bot) ||
        (groupMsg.replied_to_username && groupMsg.replied_to_username.toLowerCase().includes("bot"));
      if (repliedToIsProbablyBot) {
        analysisHint = `Note: This message replies to a bot (${groupMsg.replied_to_username}). Craft a sarcastic reply teasing that.`;
      } else if (groupMsg.replied_to_username) {
        analysisHint = `Note: This message replies to @${groupMsg.replied_to_username}. Use this to make a realistic sarcastic comeback.`;
      } else {
        analysisHint = `Note: This message isn't a reply. Use recent group context to sound natural.`;
      }

      const finalPrompt = `${analysis}\n${analysisHint}`;
      const userHistory = await getUserHistory(username);
      const botResponse = await generateResponse(recordedText, isCreator, userHistory, finalPrompt);

      await sendMessage(chatId, botResponse, messageId);
      return new Response("ok");
    }

    // --- Private chat replies ---
    if (isPrivate) {
      const userHistory = await getUserHistory(username);
      const botResponse = await generateResponse(recordedText, isCreator, userHistory);
      await sendMessage(chatId, botResponse, messageId);
    }
  } catch (err) {
    console.error("Error handling update:", err);
  }

  return new Response("ok");
});
