// main.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const kv = await Deno.openKv();    

const TOKEN = Deno.env.get("BOT_TOKEN");
const SECRET_PATH = "/masakoffvpnssponsor"; // change this
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;
const CHANNELS = ["MasakoffVpns","AMERICAN_VPN", "Kesa_VPN", "POLO_SHXP"]; // your channels
const ADMIN_USERNAME = "Masakoff"; // admin username without @

let intervalId = null;

async function getChannelTitle(channel: string): Promise<string> {
  try {
    const res = await fetch(`${TELEGRAM_API}/getChat?chat_id=@${channel}`);
    const data = await res.json();
    if (data.ok) {
      return data.result.title;
    }
  } catch (e) {
    console.error(e);
  }
  return channel; // fallback to username if fetch fails
}

async function postToChannels() {
  const photoIdResult = await kv.get(["current_photo_id"]);
  const photoId = photoIdResult.value;
  if (!photoId) {
    console.log("No photo ID set.");
    return;
  }

  const caption = `𝗠𝗔𝗦𝗔𝗞𝗢𝗙𝗙 𝗩𝗣𝗡𝗦 𝗦𝗣𝗢𝗡𝗦𝗢𝗥\n\n✨ Botumyza täze Dark Tunnel VPN koduny ýerleşdirdik!\n🔐 Indi siz has ygtybarly we çalt VPN hyzmatyndan peýdalanyp bilersiňiz.\n\n📲 Ulanmak üçin diňe botymyza girip, täze koduňyzy alyp bilersiňiz!`;
  const inlineKeyboard = {
    inline_keyboard: [[{ text: "👉 VPN ALMAK 👉", url: "https://t.me/MasakoffVpnsSponsorBot" }]]
  };

  for (const channel of CHANNELS) {
    try {
      const res = await fetch(`${TELEGRAM_API}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: `@${channel}`,
          photo: photoId,
          caption: caption,
          parse_mode: "HTML",
          reply_markup: inlineKeyboard
        })
      });
      const data = await res.json();
      if (data.ok) {
        const messageId = data.result.message_id;
        // Store active message ID
        let active = await kv.get(["active_messages", channel]);
        let activeList = active.value || [];
        activeList.push(messageId);
        await kv.set(["active_messages", channel], activeList);

        setTimeout(async () => {
          try {
            await fetch(`${TELEGRAM_API}/deleteMessage?chat_id=@${channel}&message_id=${messageId}`);
            // Remove from active list after deletion
            let activeAfter = await kv.get(["active_messages", channel]);
            if (activeAfter.value) {
              activeAfter.value = activeAfter.value.filter((id: number) => id !== messageId);
              await kv.set(["active_messages", channel], activeAfter.value);
            }
          } catch (e) {
            console.error(`Failed to delete message in @${channel}:`, e);
          }
        }, 3600000); // 1 hour
      } else {
        console.error(`Failed to post to @${channel}:`, data.description);
      }
    } catch (e) {
      console.error(`Error posting to @${channel}:`, e);
    }
  }
}

serve(async (req: Request) => {
  const { pathname } = new URL(req.url);
  if (pathname !== SECRET_PATH) {
    return new Response("Bot is running.", { status: 200 });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const update = await req.json();
  const message = update.message;
  const callbackQuery = update.callback_query;
  const chatId = message?.chat?.id || callbackQuery?.message?.chat?.id;
  const userId = message?.from?.id || callbackQuery?.from?.id;
  const text = message?.text;
  const data = callbackQuery?.data;
  const messageId = callbackQuery?.message?.message_id;
  const username = message?.from?.username;
  const document = message?.document;
  const photo = message?.photo;

  if (!chatId || !userId) return new Response("No chat ID or user ID", { status: 200 });

  // Function to send message
  async function sendMessage(cid: number, msg: string, markup?: any) {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cid,
        text: msg,
        reply_markup: markup
      })
    });
  }

  // Function to send document
  async function sendDocument(cid: number, fileId: string) {
    await fetch(`${TELEGRAM_API}/sendDocument`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cid,
        document: fileId
      })
    });
  }

  // Function to check subscription
  async function isSubscribed(uid: number) {
    for (const channel of CHANNELS) {
      try {
        const res = await fetch(`${TELEGRAM_API}/getChatMember?chat_id=@${channel}&user_id=${uid}`);
        const data = await res.json();
        if (!data.ok) return false;
        const status = data.result.status;
        if (status === "left" || status === "kicked") return false;
      } catch (e) {
        console.error(e);
        return false;
      }
    }
    return true;
  }

  // Handle admin /changefile command
  if (text === "/changefile") {
    if (username !== ADMIN_USERNAME) {
      await sendMessage(chatId, "⚠️ Bu buýruga rugsadyňyz ýok! 🚫");
      return new Response("OK", { status: 200 });
    }
    await kv.set(["admin_state", chatId], "waiting_for_file");
    await sendMessage(chatId, "Maňa faýly iberiň. 📁");
    return new Response("OK", { status: 200 });
  }

  // Handle admin /setphoto command
  if (text === "/setphoto") {
    if (username !== ADMIN_USERNAME) {
      await sendMessage(chatId, "⚠️ Bu buýruga rugsadyňyz ýok! 🚫");
      return new Response("OK", { status: 200 });
    }
    await kv.set(["admin_state", chatId], "waiting_for_photo");
    await sendMessage(chatId, "Maňa suraty iberiň. 📸");
    return new Response("OK", { status: 200 });
  }

  // Handle file upload from admin
  if (document) {
    const state = await kv.get(["admin_state", chatId]);
    if (state.value === "waiting_for_file" && username === ADMIN_USERNAME) {
      const fileId = document.file_id;
      await kv.set(["current_file_id"], fileId);
      await kv.delete(["admin_state", chatId]);
      await sendMessage(chatId, "Faýl üstünlikli täzelendi! ✅📄");
      return new Response("OK", { status: 200 });
    }
  }

  // Handle photo upload from admin
  if (photo && photo.length > 0) {
    const state = await kv.get(["admin_state", chatId]);
    if (state.value === "waiting_for_photo" && username === ADMIN_USERNAME) {
      const fileId = photo[photo.length - 1].file_id;
      await kv.set(["current_photo_id"], fileId);
      await kv.delete(["admin_state", chatId]);
      await sendMessage(chatId, "Surat üstünlikli täzelendi! ✅📸");
      return new Response("OK", { status: 200 });
    }
  }

  // Handle admin /startpost command
  if (text === "/startpost") {
    if (username !== ADMIN_USERNAME) {
      await sendMessage(chatId, "⚠️ Bu buýruga rugsadyňyz ýok! 🚫");
      return new Response("OK", { status: 200 });
    }
    const photoIdResult = await kv.get(["current_photo_id"]);
    if (!photoIdResult.value) {
      await sendMessage(chatId, "⚠️ Ilki suraty belleň! 📸");
      return new Response("OK", { status: 200 });
    }
    await postToChannels();
    if (!intervalId) {
      intervalId = setInterval(() => postToChannels(), 14400000); // 4 hours
    }
    await sendMessage(chatId, "Ähli kanallara ýazgy ýaýradyldy! 📢");
    return new Response("OK", { status: 200 });
  }

  // Handle admin /stoppost command
  if (text === "/stoppost") {
    if (username !== ADMIN_USERNAME) {
      await sendMessage(chatId, "⚠️ Bu buýruga rugsadyňyz ýok! 🚫");
      return new Response("OK", { status: 200 });
    }
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    for (const channel of CHANNELS) {
      const active = await kv.get(["active_messages", channel]);
      if (active.value) {
        for (const msgId of active.value) {
          try {
            await fetch(`${TELEGRAM_API}/deleteMessage?chat_id=@${channel}&message_id=${msgId}`);
          } catch (e) {
            console.error(`Failed to delete message ${msgId} in @${channel}:`, e);
          }
        }
        await kv.delete(["active_messages", channel]);
      }
    }
    await sendMessage(chatId, "Ýaýradylmak dowam etdirilmedi we ähli ýazgylar pozuldy! 🛑");
    return new Response("OK", { status: 200 });
  }

  // Handle /start command
  if (text?.startsWith("/start")) {
    const subscribed = await isSubscribed(userId);

    if (subscribed) {
      await sendMessage(chatId, "🎉 Ähli kanallara agza bolanyňyz üçin sag boluň! Vpnden lezzet alyň. 🤖👍");
      const file = await kv.get(["current_file_id"]);
      if (file.value) {
        await sendDocument(chatId, file.value as string);
      }
    } else {
      const channelButtons = [];
      for (const channel of CHANNELS) {
        const title = await getChannelTitle(channel);
        channelButtons.push([{ text: `${title} 🚀`, url: `https://t.me/${channel}` }]);
      }
      await sendMessage(chatId, "⚠️ Ilki ähli kanallara agza bolmaly! Agza bolanyňyzdan soň iň aşakdaky düwmä basyň. 📢", {
        inline_keyboard: [
          ...channelButtons,
          [{ text: "AGZA BOLDUM✅", callback_data: "check_sub" }]
        ]
      });
    }
  }

  // Handle inline button click
  if (data === "check_sub" && messageId) {
    const subscribed = await isSubscribed(userId);
    const textToSend = subscribed
      ? "🎉 Siz ähli kanallara agza bolduňyz! Vpnden lezzet alyň. 🤖👍"
      : "⚠️ Siz ähli kanallara agza däl. Ilki olara goşulyň! 📢";

    let replyMarkup;
    if (!subscribed) {
      const channelButtons = [];
      for (const channel of CHANNELS) {
        const title = await getChannelTitle(channel);
        channelButtons.push([{ text: `${title} 🚀`, url: `https://t.me/${channel}` }]);
      }
      replyMarkup = {
        inline_keyboard: [
          ...channelButtons,
          [{ text: "AGZA BOLDUM✅", callback_data: "check_sub" }]
        ]
      };
    }

    await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: textToSend,
        reply_markup: replyMarkup
      })
    });

    if (subscribed) {
      const file = await kv.get(["current_file_id"]);
      if (file.value) {
        await sendDocument(chatId, file.value as string);
      }
    }

    // Answer callback query to remove loading
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQuery.id
      })
    });
  }

  return new Response("OK", { status: 200 });
});