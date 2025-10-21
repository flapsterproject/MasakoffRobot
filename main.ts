// main.ts
// 🤖 Masakoff Sarcastic Bot with User Memory + Group Message Tracker
// 💾 Stores all user messages individually in Deno KV
// 🔧 Only admins can delete users' stored data using /delete <username>
// 🧮 In group chats, replies every 5th "1" message (counter resets after 5)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GoogleGenerativeAI } from "npm:@google/generative-ai@^0.19.0";

// -------------------- Telegram Setup --------------------
const TOKEN = Deno.env.get("BOT_TOKEN");
const API = `https://api.telegram.org/bot${TOKEN}`;
const SECRET_PATH = "/masakoffrobot";

// -------------------- Gemini Setup --------------------
const GEMINI_API_KEY = "AIzaSyC8aqnLqr6E4i7hxIARY-sTwANVw9WYeO8";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// -------------------- Deno KV Setup --------------------
const kv = await Deno.openKv();

// -------------------- Admins --------------------
const ADMINS = ["Masakoff"]; // Add more usernames if needed

// -------------------- Telegram Helpers --------------------
async function sendMessage(chatId: string | number, text: string, replyToMessageId?: number) {
  const res = await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: true,
    }),
  });
  const data = await res.json();
  return data.result?.message_id;
}

// -------------------- Gemini Response Generator --------------------
async function generateResponse(prompt: string, isCreator: boolean, userHistory: string[]): Promise<string> {
  try {
    const style = isCreator
      ? `Respond politely, naturally, and respectfully — as if speaking to your creator, add emojis. Avoid sarcasm, be concise, and use a friendly tone in Turkmen.`
      : `Respond as a witty, realistic human — use sarcasm, keep it very short (1–2 sentences), add emojis, and write naturally in Turkmen, as if chatting with a friend online.`;

    const context = userHistory.length
      ? `Here is what this user said before:\n${userHistory.map((m, i) => `${i + 1}. ${m}`).join("\n")}\nNow they say: "${prompt}".`
      : `User says: "${prompt}".`;

    const result = await model.generateContent(`${style}\n${context}`);
    return result.response.text();
  } catch (error) {
    console.error("Gemini error:", error);
    return "Извини, я завис 🤖💤";
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
  await kv.delete(key);
}

// -------------------- Group Counter Helpers --------------------
async function incrementGroupCounter(chatId: string | number) {
  const key = ["group_counter", chatId];
  const current = (await kv.get<number>(key))?.value || 0;
  const updated = current + 1;
  await kv.set(key, updated);
  return updated;
}

async function resetGroupCounter(chatId: string | number) {
  const key = ["group_counter", chatId];
  await kv.set(key, 0);
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
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

    if (!text) return new Response("ok");

    // -------------------- Admin Delete Command --------------------
    if (text.startsWith("/delete")) {
      if (!isAdmin) {
        await sendMessage(chatId, "🚫 You don’t have permission to do that.", messageId);
        return new Response("ok");
      }

      const parts = text.split(" ");
      if (parts.length < 2) {
        await sendMessage(chatId, "Usage: /delete <username>", messageId);
        return new Response("ok");
      }

      const targetUser = parts[1].replace("@", "");
      await deleteUserHistory(targetUser);
      await sendMessage(chatId, `🗑 Storage for @${targetUser} deleted successfully.`, messageId);
      return new Response("ok");
    }

    // -------------------- Group Message Counting --------------------
    if (isGroup && text.trim() === "1") {
      const count = await incrementGroupCounter(chatId);
      console.log(`Group ${chatId} message count: ${count}`);
      if (count === 5) {
        await sendMessage(chatId, "🎉 This was the 5th message! Counter reset 🔁", messageId);
        await resetGroupCounter(chatId);
        return new Response("ok");
      }
      return new Response("ok");
    }

    // -------------------- Regular Message Handling --------------------
    // 💾 Save user's message
    await saveUserMessage(username, text);

    // 🧠 Get user's history for context
    const history = await getUserHistory(username);

    // 🤖 Generate contextual response
    const botResponse = await generateResponse(text, isCreator, history);

    // 💬 Send reply
    await sendMessage(chatId, botResponse, messageId);

  } catch (err) {
    console.error("Error handling update:", err);
  }

  return new Response("ok");
});

