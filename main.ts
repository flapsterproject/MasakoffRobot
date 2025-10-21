// main.ts
// 🤖 Masakoff Sarcastic Bot with Memory
// 💾 Stores each user's last message in Deno KV and replies contextually

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GoogleGenerativeAI } from "npm:@google/generative-ai@^0.19.0";

// -------------------- Telegram Setup --------------------
const TOKEN = Deno.env.get("BOT_TOKEN");
const API = `https://api.telegram.org/bot${TOKEN}`;
const SECRET_PATH = "/masakoffrobot";

// -------------------- Gemini Setup --------------------
const GEMINI_API_KEY = "AIzaSyC2tKj3t5oTsrr_a0B1mDxtJcdyeq5uL0U";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// -------------------- Deno KV Setup --------------------
const kv = await Deno.openKv();

// -------------------- Telegram Helpers --------------------
async function sendMessage(
  chatId: string | number,
  text: string,
  replyToMessageId?: number,
) {
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
async function generateResponse(
  prompt: string,
  isCreator: boolean,
  lastMessage?: string,
): Promise<string> {
  try {
    const style = isCreator
      ? `Respond politely, naturally, and respectfully — as if speaking to your creator, add emojis. Avoid sarcasm, be concise, and use a friendly tone in Turkmen.`
      : `Respond as a witty, realistic human — use sarcasm, keep it very short (1–2 sentences), add emojis, and write naturally in Turkmen, as if chatting with a friend online.`;

    const context = lastMessage
      ? `User previously said: "${lastMessage}". Now they say: "${prompt}".`
      : `User says: "${prompt}".`;

    const result = await model.generateContent(`${style}\n${context}`);
    return result.response.text();
  } catch (error) {
    console.error("Gemini error:", error);
    return "Извини, я завис 🤖💤";
  }
}

// -------------------- HTTP Handler --------------------
serve(async (req) => {
  try {
    const update = await req.json();

    if (update.message) {
      const chatId = String(update.message.chat.id);
      const text = update.message.text;
      const messageId = update.message.message_id;
      const username = update.message.from?.username || "";

      if (text) {
        const userKey = ["user", chatId];

        // 🧠 Get the user's last message
        const last = await kv.get(userKey);
        const lastMessage = last?.value || null;

        // 👑 Creator check
        const isCreator = username === "Masakoff";

        // 🤖 Generate response using last message as context
        const botResponse = await generateResponse(text, isCreator, lastMessage);

        // 💬 Send reply
        await sendMessage(chatId, botResponse, messageId);

        // 💾 Save this as the user's new "last message"
        await kv.set(userKey, text);
      }
    }
  } catch (err) {
    console.error("Error handling update:", err);
  }

  return new Response("ok");
});

