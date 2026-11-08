import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

export const Route = createFileRoute("/api/public/telegram/status")({
  server: {
    handlers: {
      GET: async () => {
        const token = (env as any).BOT_TOKEN as string | undefined;
        if (!token) return Response.json({ ok: false, error: "BOT_TOKEN missing" }, { status: 500 });
        const response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
        const data: any = await response.json().catch(() => ({ ok: false }));
        if (!data.ok) return Response.json({ ok: false, error: data.description ?? "Telegram API error" }, { status: 502 });
        const info = data.result ?? {};
        return Response.json({
          ok: true,
          webhook_url: info.url ?? "",
          pending_update_count: info.pending_update_count ?? 0,
          last_error_date: info.last_error_date ?? null,
          last_error_message: info.last_error_message ?? null,
          allowed_updates: info.allowed_updates ?? [],
          has_custom_certificate: info.has_custom_certificate ?? false,
          max_connections: info.max_connections ?? null
        });
      }
    }
  }
});
