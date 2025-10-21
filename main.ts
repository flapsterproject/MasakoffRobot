// main.ts
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
async function generateResponse(prompt: string, isCreator: boolean): Promise<string> {
  try {
    const style = isCreator
      ? `Respond politely, naturally, and respectfully — as if speaking to your creator. Avoid sarcasm, be concise, and use a friendly tone in Turkmen.`
      : `Respond as a witty, realistic human — use sarcasm, keep it very short (1–2 sentences), add emojis, and write naturally in Turkmen, as if chatting with a friend online.`;

    const result = await model.generateContent(`${style}\nUser: ${prompt}`);
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
        const isCreator = username === "Masakoff"; // 👑 Creator check
        const botResponse = await generateResponse(text, isCreator);
        await sendMessage(chatId, botResponse, messageId);
      }
    }
  } catch (err) {
    console.error("Error handling update:", err);
  }

  return new Response("ok");
});
