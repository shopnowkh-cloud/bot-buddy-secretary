import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface D1 {
  prepare(sql: string): Statement;
}
interface Bindings {
  DB: D1;
  BOT_TOKEN: string;
}
const bindings = env as unknown as Bindings;

async function secretToken(): Promise<string> {
  const data = new TextEncoder().encode(`telegram-webhook:${bindings.BOT_TOKEN}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, "").replace(/\\+/g, "-").replace(/\\//g, "_");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function tg(method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${bindings.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    console.error(`Telegram ${method} failed`, response.status, data);
  }
  return data;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function nameOf(user: any): string {
  if (!user) return "Unknown";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return name || (user.username ? `@${user.username}` : "Unknown");
}

function textOf(msg: any): string {
  return msg?.text ?? msg?.caption ??
    (msg?.photo ? "[photo]" : msg?.video ? "[video]" :
    msg?.animation ? "[animation]" : msg?.voice ? "[voice]" :
    msg?.audio ? "[audio]" : msg?.video_note ? "[video note]" :
    msg?.document ? "[document]" : msg?.sticker ? "[sticker]" :
    msg?.location ? "[location]" : msg?.contact ? "[contact]" :
    "[non-text message]");
}

function dateKh(unix: number | undefined): string {
  if (!unix) return "មិនស្គាល់ពេលវេលា";
  return new Date(unix * 1000).toLocaleString("km-KH", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Phnom_Penh",
  });
}

async function saveConnection(bc: any) {
  await bindings.DB.prepare(`INSERT INTO business_connections
    (id,user_id,user_chat_id,username,first_name,can_reply,is_enabled,updated_at)
    VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,
    user_chat_id=excluded.user_chat_id,username=excluded.username,
    first_name=excluded.first_name,can_reply=excluded.can_reply,
    is_enabled=excluded.is_enabled,updated_at=CURRENT_TIMESTAMP`)
    .bind(
      bc.id,
      bc.user.id,
      bc.user_chat_id,
      bc.user.username ?? null,
      bc.user.first_name ?? null,
      (bc.rights?.can_reply ?? bc.can_reply ?? false) ? 1 : 0,
      (bc.is_enabled ?? !bc.is_disabled) ? 1 : 0,
    ).run();
}

async function connection(id: string) {
  const saved = await bindings.DB.prepare(
    "SELECT user_id,user_chat_id,can_reply,is_enabled FROM business_connections WHERE id=?"
  ).bind(id).first<{ user_id: number; user_chat_id: number; can_reply: number; is_enabled: number }>();
  if (saved) return saved;

  const result: any = await tg("getBusinessConnection", { business_connection_id: id });
  const bc = result?.result;
  if (!bc?.user_chat_id) return null;
  await saveConnection(bc);
  return {
    user_id: bc.user.id,
    user_chat_id: bc.user_chat_id,
    can_reply: (bc.rights?.can_reply ?? bc.can_reply ?? false) ? 1 : 0,
    is_enabled: (bc.is_enabled ?? true) ? 1 : 0,
  };
}

async function saveMessage(msg: any) {
  const bcId = String(msg.business_connection_id ?? "");
  const conn = await connection(bcId);
  const outgoing = conn ? Number(msg.from?.id) === Number(conn.user_id) : false;

  await bindings.DB.prepare(`INSERT INTO business_messages
    (business_connection_id,chat_id,message_id,from_user_id,from_name,is_outgoing,text,raw_json,sent_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chat_id,message_id) DO UPDATE SET
    text=excluded.text,raw_json=excluded.raw_json,from_name=excluded.from_name,
    from_user_id=excluded.from_user_id,is_outgoing=excluded.is_outgoing`)
    .bind(
      bcId, msg.chat.id, msg.message_id, msg.from?.id ?? null,
      nameOf(msg.from), outgoing ? 1 : 0, textOf(msg), JSON.stringify(msg),
      new Date((msg.date ?? Date.now() / 1000) * 1000).toISOString(),
    ).run();

  // Auto-reply only to incoming customer messages and only when Telegram grants can_reply.
  if (!outgoing && conn?.can_reply && conn?.is_enabled) {
    const settings = await bindings.DB.prepare(
      "SELECT away_mode,auto_reply_text FROM bot_settings WHERE id=1"
    ).first<{ away_mode: number; auto_reply_text: string }>();
    if (settings?.away_mode && settings.auto_reply_text) {
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        business_connection_id: bcId,
        text: settings.auto_reply_text,
      });
    }
  }
}

async function editMessage(msg: any) {
  const old = await bindings.DB.prepare(
    "SELECT text,from_name,sent_at,edited_at FROM business_messages WHERE chat_id=? AND message_id=?"
  ).bind(msg.chat.id, msg.message_id).first<any>();

  const nextText = textOf(msg);
  const editTimestamp = new Date((msg.edit_date ?? Date.now() / 1000) * 1000).toISOString();
  const hasActualText = typeof msg?.text === "string" || typeof msg?.caption === "string";
  const shouldNotify = !!old &&
    old.edited_at !== editTimestamp &&
    old.text !== nextText &&
    (!/^\\[(photo|video|animation|voice|audio|video note|document|sticker|location|contact|non-text message)\\]$/.test(String(old.text ?? "")) || hasActualText);

  await bindings.DB.prepare(`INSERT INTO business_messages
    (business_connection_id,chat_id,message_id,from_user_id,from_name,text,raw_json,sent_at,edited_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chat_id,message_id) DO UPDATE SET
    text=excluded.text,raw_json=excluded.raw_json,edited_at=excluded.edited_at`)
    .bind(
      msg.business_connection_id, msg.chat.id, msg.message_id,
      msg.from?.id ?? null, nameOf(msg.from), nextText, JSON.stringify(msg),
      new Date((msg.date ?? Date.now() / 1000) * 1000).toISOString(), editTimestamp,
    ).run();

  if (!shouldNotify) return;
  const conn = await connection(String(msg.business_connection_id));
  if (!conn?.user_chat_id) return;

  await tg("sendMessage", {
    chat_id: conn.user_chat_id,
    parse_mode: "HTML",
    text: `✏️ <b>សារត្រូវបានកែ</b>\nពី៖ <b>${esc(old.from_name ?? nameOf(msg.from))}</b>\n🕒 ${dateKh(Math.floor(new Date(old.sent_at).getTime() / 1000))}\n\n<b>មុន៖</b>\n<blockquote>${esc(old.text)}</blockquote>\n<b>ក្រោយ៖</b>\n<blockquote>${esc(nextText)}</blockquote>`,
  });
}

async function sendDeletedOriginal(adminChatId: number, raw: any, old: any) {
  const header = `🗑️ <b>សារត្រូវបានលុប</b>\nពី៖ <b>${esc(old.from_name ?? "Unknown")}</b>\n🕒 ${dateKh(Math.floor(new Date(old.sent_at).getTime() / 1000))}`;
  const caption = raw?.caption ? `${header}\n\n${esc(raw.caption)}` : header;
  const base: Record<string, unknown> = { chat_id: adminChatId };

  const media: Array<[string, string, any]> = [
    ["photo", "sendPhoto", raw?.photo?.at(-1)?.file_id],
    ["video", "sendVideo", raw?.video?.file_id],
    ["animation", "sendAnimation", raw?.animation?.file_id],
    ["voice", "sendVoice", raw?.voice?.file_id],
    ["audio", "sendAudio", raw?.audio?.file_id],
    ["video_note", "sendVideoNote", raw?.video_note?.file_id],
    ["document", "sendDocument", raw?.document?.file_id],
    ["sticker", "sendSticker", raw?.sticker?.file_id],
  ];
  const found = media.find(([, , fileId]) => !!fileId);
  if (found) {
    const [kind, method, fileId] = found;
    const supportsCaption = kind !== "sticker" && kind !== "video_note";
    const field = kind === "photo" ? "photo" : kind;
    await tg(method, { ...base, [field]: fileId, ...(supportsCaption ? { caption, parse_mode: "HTML" } : {}) });
    if (!supportsCaption) await tg("sendMessage", { chat_id: adminChatId, parse_mode: "HTML", text: header });
    return;
  }
  if (raw?.location) {
    await tg("sendLocation", {
      chat_id: adminChatId,
      latitude: raw.location.latitude,
      longitude: raw.location.longitude,
    });
    await tg("sendMessage", { chat_id: adminChatId, parse_mode: "HTML", text: header });
    return;
  }
  if (raw?.contact) {
    await tg("sendContact", {
      chat_id: adminChatId,
      phone_number: raw.contact.phone_number,
      first_name: raw.contact.first_name ?? "Contact",
      last_name: raw.contact.last_name ?? "",
    });
    await tg("sendMessage", { chat_id: adminChatId, parse_mode: "HTML", text: header });
    return;
  }
  const body = raw?.text ? `\n\n<blockquote>${esc(raw.text)}</blockquote>` : `\n\n${esc(old.text ?? "[non-text message]")}`;
  await tg("sendMessage", { chat_id: adminChatId, parse_mode: "HTML", text: header + body });
}

async function notifyDeleted(payload: any) {
  const conn = await connection(String(payload.business_connection_id));
  if (!conn?.user_chat_id) return;

  for (const id of payload.message_ids ?? []) {
    const old = await bindings.DB.prepare(
      "SELECT * FROM business_messages WHERE chat_id=? AND message_id=?"
    ).bind(payload.chat.id, id).first<any>();
    if (old?.deleted_at) continue;

    await bindings.DB.prepare(
      "UPDATE business_messages SET deleted_at=CURRENT_TIMESTAMP WHERE chat_id=? AND message_id=? AND deleted_at IS NULL"
    ).bind(payload.chat.id, id).run();

    if (!old) {
      await tg("sendMessage", {
        chat_id: conn.user_chat_id,
        text: `🗑️ សារត្រូវបានលុប (#${id}) — មិនមានកំណត់ត្រាដើមទេ។`,
      });
      continue;
    }

    try {
      const raw = JSON.parse(old.raw_json || "{}");
      await sendDeletedOriginal(conn.user_chat_id, raw, old);
    } catch (error) {
      console.error("Could not restore deleted message:", error);
      await tg("sendMessage", {
        chat_id: conn.user_chat_id,
        text: `🗑️ សារត្រូវបានលុប៖ ${esc(old.text ?? "មិនមានអត្ថបទ")}`,
      });
    }
  }
}

async function handleUpdate(update: any) {
  if (update.business_connection) {
    const bc = update.business_connection;
    await saveConnection(bc);
    await tg("sendMessage", {
      chat_id: bc.user_chat_id,
      text: bc.is_enabled
        ? "✅ Secretary Bot បានភ្ជាប់ដោយជោគជ័យ!\n\nខ្ញុំនឹងរក្សាទុកសារ ជូនដំណឹងពេលមានការកែ/លុប និងឆ្លើយតបស្វ័យប្រវត្តិតាមការកំណត់។"
        : "⚠️ Secretary Bot ត្រូវបានផ្ដាច់ពី Business Account របស់អ្នក។",
    });
  } else if (update.business_message) {
    await saveMessage(update.business_message);
  } else if (update.edited_business_message) {
    await editMessage(update.edited_business_message);
  } else if (update.deleted_business_messages) {
    await notifyDeleted(update.deleted_business_messages);
  } else if (update.message?.text?.startsWith("/start")) {
    const chatId = update.message.chat.id;
    const name = nameOf(update.message.from);
    await tg("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `👋 <b>សូមស្វាគមន៍ ${esc(name)}</b>\n\n` +
        "<b>របៀបភ្ជាប់ Secretary Mode៖</b>\n" +
        "1️⃣ បើក Telegram → Settings → Business → Chatbots\n\n" +
        "2️⃣ ជ្រើស Add Bot ហើយបញ្ចូល @limsovannradybot\n\n" +
        "3️⃣ អនុញ្ញាតសិទ្ធិ Reply to messages និងសិទ្ធិដែលអ្នកចង់ប្រើ\n\n" +
        "4️⃣ រួចរាល់! Bot នឹងរក្សាទុកសារ និងជូនដំណឹងពេលមានការកែ ឬលុប។",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🤖 បើក Secretary Bot", url: "https://t.me/limsovannradybot" }],
          [{ text: "📋 Copy Bot Username", copy_text: { text: "@limsovannradybot" } }],
        ],
      },
    });
  }
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!bindings.BOT_TOKEN) return new Response("Missing BOT_TOKEN binding", { status: 500 });
        const expected = await secretToken();
        const received = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!safeEqual(received, expected)) return new Response("Unauthorized", { status: 401 });

        let update: any;
        try {
          update = await request.json();
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

        try {
          const isBusinessUpdate = !!(
            update.business_connection || update.business_message ||
            update.edited_business_message || update.deleted_business_messages
          );
          if (isBusinessUpdate && !bindings.DB) return new Response("Missing DB binding", { status: 500 });
          await handleUpdate(update);
          return Response.json({ ok: true });
        } catch (error) {
          console.error("Telegram webhook error:", error);
          return Response.json({ ok: false, error: "Webhook handler failed" }, { status: 500 });
        }
      },
    },
  },
});
