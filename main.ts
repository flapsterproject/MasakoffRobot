// main.ts
// 🤖 Masakoff Sarcastic Bot (Image + Text)
// ✨ Responds sarcastically in Turkmen and makes sarcastic images on "make"/"create"

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GoogleGenerativeAI } from "npm:@google/generative-ai@^0.19.0";

// -------------------- Telegram Setup --------------------
const TOKEN = Deno.env.get("BOT_TOKEN");
const API = `https://api.telegram.org/bot${TOKEN}`;
const SECRET_PATH = "/masakoffrobot";

// -------------------- Gemini Setup --------------------
const GEMINI_API_KEY = "AIzaSyC2tKj3t5oTsrr_a0B1mDxtJcdyeq5uL0U";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const textModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
const imageModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// -------------------- Telegram Helpers --------------------
async function sendMessage(chatId: string | number, text: string, replyToMessageId?: number) {
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
}

async function sendPhotoBinary(chatId: string | number, base64: string, caption?: string) {
  const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([binary], { type: "image/png" }), "sarcastic.png");
  if (caption) form.append("caption", caption);

  await fetch(`${API}/sendPhoto`, { method: "POST", body: form });
}

// -------------------- Gemini Text Response --------------------
async function generateResponse(prompt: string): Promise<string> {
  try {
    const fullPrompt = `Respond as a witty, realistic human — use sarcasm, keep it short (1–2 sentences), add emojis, and write naturally in Turkmen, as if chatting with a friend online: ${prompt}`;
    const result = await textModel.generateContent(fullPrompt);
    return result.response.text();
  } catch (error) {
    console.error("Gemini text error:", error);
    return "Men pikirlenýän wagtym ýalňyşlyk boldy 🤖💤";
  }
}

// -------------------- Gemini Image Generator --------------------
async function generateSarcasticImage(prompt: string): Promise<string | null> {
  try {
    const fullPrompt = `Create a funny and sarcastic digital artwork based on this: "${prompt}". The image should look witty, humorous, and have a playful tone.`;
    const result = await imageModel.generateContent([
      { role: "user", parts: [{ text: fullPrompt }] },
    ]);

    const part = result.response.candidates?.[0]?.content?.parts?.find(
      (p: any) => p.inlineData?.data
    );
    if (!part) return null;

    return part.inlineData.data; // base64 string
  } catch (error) {
    console.error("Gemini image error:", error);
    return null;
  }
}

// -------------------- HTTP Handler --------------------
serve(async (req) => {
  try {
    const update = await req.json();

    if (update.message) {
      const chatId = String(update.message.chat.id);
      const text = update.message.text?.trim() || "";
      const messageId = update.message.message_id;

      if (!text) return new Response("ok");

      // Handle "make" or "create" triggers
      if (/\b(make|create)\b/i.test(text)) {
        const base64 = await generateSarcasticImage(text);

        if (base64) {
          await sendPhotoBinary(chatId, base64, "😏 Şeýt diýdiň, men bolsa surat çekdim...");
          const captionResponse = await generateResponse(
            `Describe sarcastically what you just created: ${text}`
          );
          await sendMessage(chatId, captionResponse);
        } else {
          await sendMessage(chatId, "Hmm... surat döretmekde näsazlyk boldy 😅", messageId);
        }
      } else {
        // Normal sarcastic reply
        const botResponse = await generateResponse(text);
        await sendMessage(chatId, botResponse, messageId);
      }
    }
  } catch (err) {
    console.error("Error handling update:", err);
  }

  return new Response("ok");
});


