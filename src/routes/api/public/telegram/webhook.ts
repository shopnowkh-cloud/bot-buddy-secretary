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
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function tg(method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${bindings.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) console.error(`Telegram ${method} failed`, response.status, data);
  return data;
}

function esc(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function nameOf(user: any) {
  return user ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || (user.username ? `@${user.username}` : "Unknown") : "Unknown";
}
function textOf(msg: any) {
  return msg?.text ?? msg?.caption ?? (msg?.photo ? "[photo]" : msg?.video ? "[video]" : msg?.voice ? "[voice]" : msg?.document ? "[document]" : msg?.sticker ? "[sticker]" : "[non-text message]");
}

async function connection(id: string) {
  const saved = await bindings.DB.prepare("SELECT user_id,user_chat_id FROM business_connections WHERE id=?")
    .bind(id).first<{ user_id: number; user_chat_id: number }>();
  if (saved) return saved;
  const result: any = await tg("getBusinessConnection", { business_connection_id: id });
  const bc = result?.result;
  if (!bc?.user_chat_id) return null;
  await bindings.DB.prepare(`INSERT INTO business_connections
    (id,user_id,user_chat_id,username,first_name,can_reply,is_enabled,updated_at)
    VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,user_chat_id=excluded.user_chat_id,
    username=excluded.username,first_name=excluded.first_name,can_reply=excluded.can_reply,
    is_enabled=excluded.is_enabled,updated_at=CURRENT_TIMESTAMP`)
    .bind(bc.id ?? id, bc.user.id, bc.user_chat_id, bc.user.username ?? null,
      bc.user.first_name ?? null, bc.can_reply ? 1 : 0, bc.is_enabled === false ? 0 : 1).run();
  return { user_id: bc.user.id, user_chat_id: bc.user_chat_id };
}

async function saveMessage(msg: any) {
  const bcId = String(msg.business_connection_id ?? "");
  const conn = await connection(bcId);
  const outgoing = conn ? Number(msg.from?.id) === Number(conn.user_id) : false;
  await bindings.DB.prepare(`INSERT INTO business_messages
    (business_connection_id,chat_id,message_id,from_user_id,from_name,is_outgoing,text,raw_json,sent_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chat_id,message_id) DO UPDATE SET text=excluded.text,raw_json=excluded.raw_json,
    from_name=excluded.from_name,from_user_id=excluded.from_user_id,is_outgoing=excluded.is_outgoing`)
    .bind(bcId, msg.chat.id, msg.message_id, msg.from?.id ?? null, nameOf(msg.from),
      outgoing ? 1 : 0, textOf(msg), JSON.stringify(msg),
      new Date((msg.date ?? Date.now()/1000)*1000).toISOString()).run();

  // Away-mode auto reply, configured in the D1 bot_settings row.
  if (!outgoing && conn) {
    const settings = await bindings.DB.prepare("SELECT away_mode,auto_reply_text FROM bot_settings WHERE id=1")
      .first<{ away_mode: number; auto_reply_text: string }>();
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
  const old = await bindings.DB.prepare("SELECT text,from_name,edited_at FROM business_messages WHERE chat_id=? AND message_id=?")
    .bind(msg.chat.id, msg.message_id).first<any>();
  const nextText = textOf(msg);
  const editedAt = new Date((msg.edit_date ?? Date.now()/1000)*1000).toISOString();
  await bindings.DB.prepare(`INSERT INTO business_messages
    (business_connection_id,chat_id,message_id,from_user_id,from_name,text,raw_json,sent_at,edited_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chat_id,message_id) DO UPDATE SET text=excluded.text,raw_json=excluded.raw_json,edited_at=excluded.edited_at`)
    .bind(msg.business_connection_id, msg.chat.id, msg.message_id, msg.from?.id ?? null,
      nameOf(msg.from), nextText, JSON.stringify(msg),
      new Date((msg.date ?? Date.now()/1000)*1000).toISOString(), editedAt).run();
  if (!old || old.text === nextText || old.edited_at === editedAt) return;
  const conn = await connection(String(msg.business_connection_id));
  if (!conn) return;
  await tg("sendMessage", {
    chat_id: conn.user_chat_id, parse_mode: "HTML",
    text: `✏️ <b>សារត្រូវបានកែ</b>\nពី៖ <b>${esc(old.from_name)}</b>\n\n<b>មុន៖</b>\n<blockquote>${esc(old.text)}</blockquote>\n<b>ក្រោយ៖</b>\n<blockquote>${esc(nextText)}</blockquote>`,
  });
}

async function notifyDeleted(payload: any) {
  const conn = await connection(String(payload.business_connection_id));
  if (!conn) return;
  for (const id of payload.message_ids ?? []) {
    const old = await bindings.DB.prepare("SELECT * FROM business_messages WHERE chat_id=? AND message_id=?")
      .bind(payload.chat.id, id).first<any>();
    if (old?.deleted_at) continue;
    await bindings.DB.prepare("UPDATE business_messages SET deleted_at=CURRENT_TIMESTAMP WHERE chat_id=? AND message_id=? AND deleted_at IS NULL")
      .bind(payload.chat.id, id).run();
    if (!old) {
      await tg("sendMessage", { chat_id: conn.user_chat_id, text: `🗑️ សារត្រូវបានលុប (#${id}) — មិនមានកំណត់ត្រាដើមទេ។` });
      continue;
    }
    const raw = JSON.parse(old.raw_json || "{}");
    const caption = `🗑️ <b>សារត្រូវបានលុប</b>\nពី៖ <b>${esc(old.from_name)}</b>\n\n${esc(old.text)}`;
    const media = raw.photo?.at(-1) ? ["sendPhoto", "photo", raw.photo.at(-1).file_id]
      : raw.video ? ["sendVideo", "video", raw.video.file_id]
      : raw.animation ? ["sendAnimation", "animation", raw.animation.file_id]
      : raw.voice ? ["sendVoice", "voice", raw.voice.file_id]
      : raw.audio ? ["sendAudio", "audio", raw.audio.file_id]
      : raw.document ? ["sendDocument", "document", raw.document.file_id]
      : raw.sticker ? ["sendSticker", "sticker", raw.sticker.file_id] : null;
    if (media) {
      const [method, field, fileId] = media;
      await tg(method, { chat_id: conn.user_chat_id, [field]: fileId });
    }
    await tg("sendMessage", { chat_id: conn.user_chat_id, parse_mode: "HTML", text: caption });
  }
}

async function handleUpdate(update: any) {
  if (update.business_connection) {
    const bc = update.business_connection;
    await bindings.DB.prepare(`INSERT INTO business_connections
      (id,user_id,user_chat_id,username,first_name,can_reply,is_enabled,updated_at)
      VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,user_chat_id=excluded.user_chat_id,
      username=excluded.username,first_name=excluded.first_name,can_reply=excluded.can_reply,
      is_enabled=excluded.is_enabled,updated_at=CURRENT_TIMESTAMP`)
      .bind(bc.id, bc.user.id, bc.user_chat_id, bc.user.username ?? null, bc.user.first_name ?? null,
        (bc.can_reply ?? bc.rights?.can_reply) ? 1 : 0, (bc.is_enabled ?? !bc.is_disabled) ? 1 : 0).run();
    await tg("sendMessage", { chat_id: bc.user_chat_id, text: bc.is_enabled
      ? "✅ Secretary Bot បានភ្ជាប់ដោយជោគជ័យ!\n\nខ្ញុំនឹងឆ្លើយតបស្វ័យប្រវត្តិ រក្សាទុកសារ និងជូនដំណឹងពេលសារត្រូវបានកែ ឬលុប។"
      : "⚠️ Secretary Bot ត្រូវបានផ្ដាច់ពី Business Account។" });
  } else if (update.business_message) {
    await saveMessage(update.business_message);
  } else if (update.edited_business_message) {
    await editMessage(update.edited_business_message);
  } else if (update.deleted_business_messages) {
    await notifyDeleted(update.deleted_business_messages);
  } else if (update.message?.text?.startsWith("/start")) {
    await tg("sendMessage", {
      chat_id: update.message.chat.id,
      parse_mode: "HTML",
      text: "👋 <b>សូមស្វាគមន៍មកកាន់ Secretary Bot</b>\n\nចូល Telegram Business Settings → Chatbots → បន្ថែម @limsovannradybot ហើយអនុញ្ញាតសិទ្ធិដែលត្រូវការ។\n\nBot នឹងឆ្លើយតបស្វ័យប្រវត្តិ រក្សាទុកសារក្នុង Cloudflare D1 និងជូនដំណឹងពេលសារត្រូវបានកែ ឬលុប។",
    });
  }
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!bindings.BOT_TOKEN || !bindings.DB) return new Response("Missing BOT_TOKEN or DB binding", { status: 500 });
        const expected = await secretToken();
        const received = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (received !== expected) return new Response("Unauthorized", { status: 401 });
        let update: any;
        try { update = await request.json(); } catch { return new Response("Bad Request", { status: 400 }); }
        try {
          await handleUpdate(update);
          return Response.json({ ok: true });
        } catch (error) {
          console.error("Telegram webhook error:", error);
          return Response.json({ ok: false }, { status: 500 });
        }
      },
    },
  },
});
