// main.ts
// 🤖 Masakoff Sarcastic Bot with User Memory + Admin Delete + Group Message Optimization
// 💾 Stores all user messages individually in Deno KV
// 💬 Replies in groups only once every 5th message
// 👤 Users can delete their own data in private with /delete

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GoogleGenerativeAI } from "npm:@google/generative-ai@^0.19.0";

// -------------------- Telegram Setup --------------------
const TOKEN = Deno.env.get("BOT_TOKEN");
const API = `https://api.telegram.org/bot${TOKEN}`;

// -------------------- Gemini Setup --------------------
const GEMINI_API_KEY = "AIzaSyB83llB8VHdeQa9bLvqynY9T7kc2ScwBcg";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// -------------------- Deno KV Setup --------------------
const kv = await Deno.openKv();

// -------------------- Admins --------------------
const ADMINS = ["Masakoff"]; // Add more usernames if needed

// -------------------- Telegram Helpers --------------------
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
      }),
    });
  } catch (err) {
    console.error("Failed to send message:", err);
  }
}

// -------------------- Gemini Response Generator --------------------
async function generateResponse(prompt: string, isCreator: boolean, userHistory: string[]): Promise<string> {
  try {
    const style = isCreator
      ? `Respond as a witty, realistic human — use sarcasm, keep it very short (1–2 sentences), add emojis, and write naturally in Turkmen, as if chatting with a friend online.`
      : `Respond as a witty, realistic human — use sarcasm, keep it very short (1–2 sentences), add emojis, and write naturally in Turkmen, as if chatting with a friend online.`;

    const context = userHistory.length
      ? `Here is what this user said before:\n${userHistory
          .map((m, i) => `${i + 1}. ${m}`)
          .join("\n")}\nNow they say: "${prompt}".`
      : `User says: "${prompt}".`;

    const result = await model.generateContent(`${style}\n${context}`);
    return result.response.text();
  } catch (error) {
    console.error("Gemini error:", error);
    return "🤖 Meniň limitim gutardy 😅";
  }
}

// -------------------- Storage Helpers --------------------
async function getUserHistory(username: string): Promise<string[]> {
  const key = ["user", username];
  const data = await kv.get<string[]>(key);
  return data?.value || [];
}

async function saveUserMessage(username: string, message: string) {
  const key = ["user", username];
  const history = await getUserHistory(username);
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

// -------------------- Group Message Counter --------------------
async function incrementGroupCounter(chatId: string): Promise<number> {
  const key = ["group_count", chatId];
  const data = await kv.get<number>(key);
  const count = (data?.value || 0) + 1;

  if (count >= 5) {
    await kv.set(key, 0); // reset after 5th message
  } else {
    await kv.set(key, count);
  }

  return count;
}

// -------------------- HTTP Handler --------------------
serve(async (req) => {
  try {
    const update = await req.json();
    if (!update.message) return new Response("ok");

    const msg = update.message;
    const chatId = String(msg.chat.id);
    const text = msg.text;
    const messageId = msg.message_id;
    const username = msg.from?.username || "unknown_user";
    const isAdmin = ADMINS.includes(username);
    const isCreator = username === "Masakoff";
    const chatType = msg.chat.type;
    const isPrivate = chatType === "private";

    if (!text) return new Response("ok");

    // -------------------- Private Chat: User Self-Delete --------------------
    if (isPrivate && text.trim() === "/delete") {
      await deleteUserHistory(username);
      await sendMessage(chatId, "🗑 Siziň maglumatlaryňyz pozuldy.", messageId);
      return new Response("ok");
    }

    // -------------------- Admin Delete Command --------------------
    if (text.startsWith("/delete ")) {
      if (!isAdmin) {
        await sendMessage(chatId, "🚫 Seniň muny etmäge hakyň ýok!", messageId);
        return new Response("ok");
      }

      const parts = text.split(" ");
      const targetUser = parts[1]?.replace("@", "").trim();

      if (!targetUser) {
        await sendMessage(chatId, "ℹ️ Ulanyş: /delete <username>", messageId);
        return new Response("ok");
      }

      await deleteUserHistory(targetUser);
      await sendMessage(chatId, `@${targetUser} 🗑 maglumatlaryň pozuldy.`, messageId);
      return new Response("ok");
    }

    // -------------------- Group Message Optimization --------------------
    if (chatType === "group" || chatType === "supergroup") {
      const count = await incrementGroupCounter(chatId);
      if (count !== 5) return new Response("ok"); // reply only every 5th message
    }

    // -------------------- Regular Message Handling --------------------
    await saveUserMessage(username, text);

    const history = await getUserHistory(username);
    const botResponse = await generateResponse(text, isCreator, history);
    await sendMessage(chatId, botResponse, messageId);

  } catch (err) {
    console.error("Error handling update:", err);
  }

  return new Response("ok");
});
