interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
interface D1Database {
  prepare(query: string): D1Statement;
}
interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
}
interface PagesContext {
  request: Request;
  env: Env;
}
type TelegramMessage = Record<string, any>;

async function webhookSecret(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(`telegram-webhook:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, "").replace(/\\+/g, "-").replace(/\\//g, "_");
}

async function telegram(env: Env, method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
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

function html(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function personName(user: any): string {
  if (!user) return "Unknown";
  return [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || (user.username ? `@${user.username}` : "Unknown");
}
function messageText(msg: TelegramMessage): string {
  return msg.text ?? msg.caption ?? (msg.photo ? "[photo]" : msg.video ? "[video]" : msg.voice ? "[voice]" : msg.document ? "[document]" : msg.sticker ? "[sticker]" : "[non-text message]");
}

async function getConnection(env: Env, id: string) {
  const saved = await env.DB.prepare(
    "SELECT user_id, user_chat_id FROM business_connections WHERE id = ?"
  ).bind(id).first<{ user_id: number; user_chat_id: number }>();
  if (saved) return saved;
  const result: any = await telegram(env, "getBusinessConnection", { business_connection_id: id });
  const bc = result?.result;
  if (!bc?.user_chat_id) return null;
  await env.DB.prepare(`INSERT INTO business_connections
    (id,user_id,user_chat_id,username,first_name,can_reply,is_enabled,updated_at)
    VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,user_chat_id=excluded.user_chat_id,
    username=excluded.username,first_name=excluded.first_name,can_reply=excluded.can_reply,
    is_enabled=excluded.is_enabled,updated_at=CURRENT_TIMESTAMP`)
    .bind(bc.id ?? id, bc.user.id, bc.user_chat_id, bc.user.username ?? null,
      bc.user.first_name ?? null, bc.can_reply ? 1 : 0, bc.is_enabled === false ? 0 : 1).run();
  return { user_id: bc.user.id, user_chat_id: bc.user_chat_id };
}

async function saveBusinessMessage(env: Env, msg: TelegramMessage) {
  const connectionId = String(msg.business_connection_id ?? "");
  const conn = await getConnection(env, connectionId);
  const isOutgoing = conn ? Number(msg.from?.id) === Number(conn.user_id) : false;
  await env.DB.prepare(`INSERT INTO business_messages
    (business_connection_id,chat_id,message_id,from_user_id,from_name,is_outgoing,text,raw_json,sent_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chat_id,message_id) DO UPDATE SET
      business_connection_id=excluded.business_connection_id,from_user_id=excluded.from_user_id,
      from_name=excluded.from_name,is_outgoing=excluded.is_outgoing,text=excluded.text,
      raw_json=excluded.raw_json,sent_at=excluded.sent_at`)
    .bind(connectionId, msg.chat.id, msg.message_id, msg.from?.id ?? null, personName(msg.from),
      isOutgoing ? 1 : 0, messageText(msg), JSON.stringify(msg), new Date((msg.date ?? Date.now()/1000)*1000).toISOString()).run();
}

async function editedBusinessMessage(env: Env, msg: TelegramMessage) {
  const previous = await env.DB.prepare(
    "SELECT text,from_name,sent_at,edited_at FROM business_messages WHERE chat_id=? AND message_id=?"
  ).bind(msg.chat.id, msg.message_id).first<any>();
  const nextText = messageText(msg);
  const editedAt = new Date((msg.edit_date ?? Date.now()/1000)*1000).toISOString();
  const shouldNotify = previous && previous.edited_at !== editedAt && previous.text !== nextText;
  await env.DB.prepare(`INSERT INTO business_messages
    (business_connection_id,chat_id,message_id,from_user_id,from_name,text,raw_json,sent_at,edited_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chat_id,message_id) DO UPDATE SET text=excluded.text,raw_json=excluded.raw_json,edited_at=excluded.edited_at`)
    .bind(msg.business_connection_id, msg.chat.id, msg.message_id, msg.from?.id ?? null,
      personName(msg.from), nextText, JSON.stringify(msg),
      new Date((msg.date ?? Date.now()/1000)*1000).toISOString(), editedAt).run();
  if (!shouldNotify) return;
  const conn = await getConnection(env, String(msg.business_connection_id));
  if (!conn) return;
  await telegram(env, "sendMessage", {
    chat_id: conn.user_chat_id, parse_mode: "HTML",
    text: `✏️ <b>សារត្រូវបានកែ</b>\nពី៖ <b>${html(previous.from_name)}</b>\n\n<b>មុន៖</b>\n<blockquote>${html(previous.text)}</blockquote>\n<b>ក្រោយ៖</b>\n<blockquote>${html(nextText)}</blockquote>`,
  });
}

async function deletedBusinessMessages(env: Env, payload: any) {
  const ids: number[] = payload.message_ids ?? [];
  const conn = await getConnection(env, String(payload.business_connection_id));
  if (!conn || !ids.length) return;
  for (const id of ids) {
    const original = await env.DB.prepare(
      "SELECT * FROM business_messages WHERE chat_id=? AND message_id=?"
    ).bind(payload.chat.id, id).first<any>();
    if (original?.deleted_at) continue;
    await env.DB.prepare(
      "UPDATE business_messages SET deleted_at=CURRENT_TIMESTAMP WHERE chat_id=? AND message_id=? AND deleted_at IS NULL"
    ).bind(payload.chat.id, id).run();
    if (!original) {
      await telegram(env, "sendMessage", { chat_id: conn.user_chat_id, text: `🗑️ សារត្រូវបានលុប (#${id}) — មិនមានកំណត់ត្រាដើមទេ។` });
      continue;
    }
    const raw = JSON.parse(original.raw_json || "{}");
    const sender = html(original.from_name || "Unknown");
    const caption = `🗑️ <b>សារត្រូវបានលុប</b>\nពី៖ <b>${sender}</b>\n\n${html(original.text)}`;
    const media = raw.photo?.at(-1) ? ["sendPhoto", "photo", raw.photo.at(-1).file_id]
      : raw.video ? ["sendVideo", "video", raw.video.file_id]
      : raw.animation ? ["sendAnimation", "animation", raw.animation.file_id]
      : raw.voice ? ["sendVoice", "voice", raw.voice.file_id]
      : raw.audio ? ["sendAudio", "audio", raw.audio.file_id]
      : raw.document ? ["sendDocument", "document", raw.document.file_id]
      : raw.sticker ? ["sendSticker", "sticker", raw.sticker.file_id]
      : null;
    if (media) {
      const [method, field, fileId] = media;
      await telegram(env, method, { chat_id: conn.user_chat_id, [field]: fileId });
      await telegram(env, "sendMessage", { chat_id: conn.user_chat_id, parse_mode: "HTML", text: caption });
    } else {
      await telegram(env, "sendMessage", { chat_id: conn.user_chat_id, parse_mode: "HTML", text: caption });
    }
  }
}

async function privateStart(env: Env, msg: TelegramMessage) {
  if (!msg.chat?.id || !String(msg.text ?? "").startsWith("/start")) return;
  await telegram(env, "sendMessage", {
    chat_id: msg.chat.id,
    parse_mode: "HTML",
    text: "👋 <b>សូមស្វាគមន៍មកកាន់ Secretary Bot</b>\n\nដើម្បីភ្ជាប់៖\n1. ចូល Telegram Business Settings\n2. ជ្រើស Chatbots\n3. បន្ថែម @limsovannradybot និងអនុញ្ញាតសិទ្ធិដែលត្រូវការ។\n\nBot នឹងរក្សាទុកសារដែលទទួលបាន និងជូនដំណឹងពេលសារត្រូវបានកែ ឬលុប។",
  });
}

export async function onRequestPost({ request, env }: PagesContext): Promise<Response> {
  if (!env.BOT_TOKEN || !env.DB) return new Response("Missing BOT_TOKEN or D1 binding DB", { status: 500 });
  const expected = await webhookSecret(env.BOT_TOKEN);
  const received = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (received !== expected) return new Response("Unauthorized", { status: 401 });
  let update: any;
  try { update = await request.json(); } catch { return new Response("Bad Request", { status: 400 }); }
  try {
    if (update.business_connection) {
      const bc = update.business_connection;
      await env.DB.prepare(`INSERT INTO business_connections
        (id,user_id,user_chat_id,username,first_name,can_reply,is_enabled,updated_at)
        VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,user_chat_id=excluded.user_chat_id,
        username=excluded.username,first_name=excluded.first_name,can_reply=excluded.can_reply,
        is_enabled=excluded.is_enabled,updated_at=CURRENT_TIMESTAMP`)
        .bind(bc.id,bc.user.id,bc.user_chat_id,bc.user.username??null,bc.user.first_name??null,
          (bc.can_reply ?? bc.rights?.can_reply) ? 1 : 0, (bc.is_enabled ?? !bc.is_disabled) ? 1 : 0).run();
      await telegram(env,"sendMessage",{chat_id:bc.user_chat_id,text:bc.is_enabled
        ? "✅ Secretary Bot បានភ្ជាប់ដោយជោគជ័យ!\n\nខ្ញុំនឹងរក្សាទុកសារ និងជូនដំណឹងពេលសារត្រូវបានកែ ឬលុប។"
        : "⚠️ Secretary Bot ត្រូវបានផ្ដាច់។"});
    } else if (update.business_message) {
      await saveBusinessMessage(env, update.business_message);
    } else if (update.edited_business_message) {
      await editedBusinessMessage(env, update.edited_business_message);
    } else if (update.deleted_business_messages) {
      await deletedBusinessMessages(env, update.deleted_business_messages);
    } else if (update.message) {
      await privateStart(env, update.message);
    }
  } catch (error) {
    console.error("Telegram webhook processing failed:", error);
    return Response.json({ ok: false }, { status: 500 });
  }
  return Response.json({ ok: true });
}
