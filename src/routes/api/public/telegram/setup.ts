import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

async function configureWebhook() {
  const token = (env as any).BOT_TOKEN as string | undefined;
  if (!token) return Response.json({ ok: false, error: "Missing BOT_TOKEN in Cloudflare Pages production secrets" }, { status: 500 });

  const bytes = new TextEncoder().encode(`telegram-webhook:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const secret = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://bot-buddy-secretary.pages.dev/api/public/telegram/webhook",
      secret_token: secret,
      allowed_updates: [
        "message",
        "business_connection",
        "business_message",
        "edited_business_message",
        "deleted_business_messages"
      ],
      drop_pending_updates: false
    })
  });
  const result = await response.json().catch(() => ({ ok: false, description: "Invalid Telegram response" }));
  return Response.json(result, { status: response.ok ? 200 : 502 });
}

export const Route = createFileRoute("/api/public/telegram/setup")({
  server: {
    handlers: {
      // Opening this fixed setup URL in a browser safely points the bot to this project's
      // own webhook. It accepts no user-supplied URL, token, or other configuration.
      GET: async () => configureWebhook(),
      POST: async ({ request }) => {
        const token = (env as any).BOT_TOKEN as string | undefined;
        if (!token) return new Response("Missing BOT_TOKEN", { status: 500 });
        const authorization = request.headers.get("Authorization") ?? "";
        if (authorization !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 });
        return configureWebhook();
      }
    }
  }
});
