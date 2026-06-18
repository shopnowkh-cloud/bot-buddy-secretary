import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, timingSafeEqual } from "crypto";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/telegram";

function deriveWebhookSecret(apiKey: string) {
  return createHash("sha256").update(`telegram-webhook:${apiKey}`).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

let _supabase: SupabaseClient | null = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return _supabase;
}

async function tg(method: string, payload: Record<string, unknown>) {
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
  const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;
  if (!LOVABLE_API_KEY || !TELEGRAM_API_KEY) {
    throw new Error("Missing LOVABLE_API_KEY or TELEGRAM_API_KEY");
  }
  const res = await fetch(`${GATEWAY_URL}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "X-Connection-Api-Key": TELEGRAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Telegram ${method} failed [${res.status}]:`, data);
  }
  return data;
}

function formatName(u: { first_name?: string; last_name?: string; username?: string } | undefined) {
  if (!u) return "Unknown";
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || (u.username ? `@${u.username}` : "Unknown");
}

function extractText(msg: any): string {
  return msg?.text ?? msg?.caption ?? (msg?.photo ? "[photo]" : msg?.video ? "[video]" : msg?.voice ? "[voice]" : msg?.document ? "[document]" : msg?.sticker ? "[sticker]" : "[non-text message]");
}

async function handleBusinessConnection(bc: any) {
  const supabase = getSupabase();
  await supabase.from("business_connections").upsert({
    id: bc.id,
    user_id: bc.user.id,
    user_chat_id: bc.user_chat_id,
    username: bc.user.username ?? null,
    first_name: bc.user.first_name ?? null,
    can_reply: bc.can_reply ?? bc.rights?.can_reply ?? false,
    is_enabled: bc.is_enabled ?? !bc.is_disabled,
    updated_at: new Date().toISOString(),
  });

  await tg("sendMessage", {
    chat_id: bc.user_chat_id,
    text: bc.is_enabled
      ? "✅ <b>Secretary Bot បានភ្ជាប់ដោយជោគជ័យ!</b>\n\nខ្ញុំនឹង៖\n• ឆ្លើយតបស្វ័យប្រវត្តិសារថ្មីរបស់អតិថិជន\n• រក្សាទុកសារទាំងអស់\n• ជូនដំណឹងពេលមានសារត្រូវបានកែ ឬ លុប"
      : "⚠️ Secretary Bot ត្រូវបានផ្ដាច់ពី Business Account របស់អ្នក។",
    parse_mode: "HTML",
  });
}

async function handleBusinessMessage(msg: any) {
  const supabase = getSupabase();
  const bcId: string = msg.business_connection_id;

  const { data: conn } = await supabase
    .from("business_connections")
    .select("user_id, user_chat_id")
    .eq("id", bcId)
    .maybeSingle();

  const isOutgoing = conn?.user_id ? Number(msg.from?.id) === Number(conn.user_id) : false;
  const text = extractText(msg);

  await supabase.from("business_messages").upsert({
    business_connection_id: bcId,
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    from_user_id: msg.from?.id ?? null,
    from_name: formatName(msg.from),
    is_outgoing: isOutgoing,
    text,
    raw: msg,
    sent_at: new Date(msg.date * 1000).toISOString(),
  });
  // No auto-reply. Bot stays silent in personal chats; admin notifications
  // are sent only for edits and deletions (see handlers below).
}

async function handleEditedBusinessMessage(msg: any) {
  const supabase = getSupabase();
  const bcId: string = msg.business_connection_id;

  const { data: prev } = await supabase
    .from("business_messages")
    .select("text, from_name, is_outgoing")
    .eq("chat_id", msg.chat.id)
    .eq("message_id", msg.message_id)
    .maybeSingle();

  const newText = extractText(msg);

  await supabase.from("business_messages").upsert({
    business_connection_id: bcId,
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    from_user_id: msg.from?.id ?? null,
    from_name: formatName(msg.from),
    is_outgoing: prev?.is_outgoing ?? false,
    text: newText,
    raw: msg,
    sent_at: new Date(msg.date * 1000).toISOString(),
    edited_at: new Date().toISOString(),
  });

  const { data: conn } = await supabase
    .from("business_connections")
    .select("user_chat_id")
    .eq("id", bcId)
    .maybeSingle();
  if (!conn?.user_chat_id) return;

  const who = prev?.from_name ?? formatName(msg.from);
  const before = prev?.text ?? "(មិនមានកំណត់ត្រា)";
  await tg("sendMessage", {
    chat_id: conn.user_chat_id,
    text: `✏️ <b>សារត្រូវបានកែ</b>\nពី៖ <b>${escapeHtml(who)}</b>\n\n<b>មុន៖</b>\n<blockquote>${escapeHtml(before)}</blockquote>\n<b>ក្រោយ៖</b>\n<blockquote>${escapeHtml(newText)}</blockquote>`,
    parse_mode: "HTML",
  });
}

async function handleDeletedBusinessMessages(payload: any) {
  const supabase = getSupabase();
  const bcId: string = payload.business_connection_id;
  const chatId: number = payload.chat.id;
  const ids: number[] = payload.message_ids ?? [];
  if (!ids.length) return;

  // Fetch originals before marking deleted
  const { data: originals } = await supabase
    .from("business_messages")
    .select("message_id, text, from_name, sent_at")
    .eq("chat_id", chatId)
    .in("message_id", ids);

  await supabase
    .from("business_messages")
    .update({ deleted_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .in("message_id", ids);

  const { data: conn } = await supabase
    .from("business_connections")
    .select("user_chat_id")
    .eq("id", bcId)
    .maybeSingle();
  if (!conn?.user_chat_id) return;

  const byId = new Map((originals ?? []).map((o) => [Number(o.message_id), o]));
  const lines = ids.map((id) => {
    const o = byId.get(Number(id));
    if (!o) return `• [#${id}] (មិនមានកំណត់ត្រាដើម)`;
    return `• <b>${escapeHtml(o.from_name ?? "Unknown")}</b>:\n<blockquote>${escapeHtml(o.text ?? "")}</blockquote>`;
  });

  await tg("sendMessage", {
    chat_id: conn.user_chat_id,
    text: `🗑️ <b>សារត្រូវបានលុប (${ids.length})</b>\n\n${lines.join("\n")}`,
    parse_mode: "HTML",
  });
}

async function handlePrivateMessage(msg: any) {
  const chatId = msg.chat?.id;
  const text = msg.text ?? "";
  if (!chatId || !text.startsWith("/start")) return;

  await tg("sendMessage", {
    chat_id: chatId,
    text:
      "👋 <b>សូមស្វាគមន៍មកកាន់ Secretary Bot!</b>\n\n" +
      "<b>របៀបប្រើប្រាស់៖</b>\n" +
      "1️⃣ បើក <b>Telegram → Settings → Telegram Business → Chatbots</b>\n" +
      "2️⃣ បញ្ចូល <b>@Deleted_Massage_2026Bot</b>\n" +
      "3️⃣ បើក <b>\"Reply to messages\"</b>\n\n" +
      "✅ ពេលភ្ជាប់រួច ខ្ញុំនឹង៖\n" +
      "• ឆ្លើយតបស្វ័យប្រវត្តិពេលអ្នកទៅឆ្ងាយ\n" +
      "• រក្សាទុកសារអតិថិជនទាំងអស់\n" +
      "• ជូនដំណឹងពេលសារត្រូវបាន <b>កែ</b> ឬ <b>លុប</b>\n\n" +
      "💡 <b>បញ្ជា៖</b>\n" +
      "/start - បង្ហាញរបៀបប្រើប្រាស់នេះ\n\n" +
      "⚠️ ត្រូវការ <b>Telegram Premium + Business Account</b>",
    parse_mode: "HTML",
  });
}

function escapeHtml(s: string) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;
        if (!TELEGRAM_API_KEY) {
          return new Response("Misconfigured", { status: 500 });
        }
        const expected = deriveWebhookSecret(TELEGRAM_API_KEY);
        const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!safeEqual(got, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }

        let update: any;
        try {
          update = await request.json();
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

        try {
          if (update.business_connection) {
            await handleBusinessConnection(update.business_connection);
          } else if (update.business_message) {
            await handleBusinessMessage(update.business_message);
          } else if (update.edited_business_message) {
            await handleEditedBusinessMessage(update.edited_business_message);
          } else if (update.deleted_business_messages) {
            await handleDeletedBusinessMessages(update.deleted_business_messages);
          } else if (update.message) {
            await handlePrivateMessage(update.message);
          }
        } catch (err) {
          console.error("Webhook handler error:", err);
        }

        return Response.json({ ok: true });
      },
    },
  },
});
