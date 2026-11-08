import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

export const Route = createFileRoute("/api/public/telegram/diagnostics")({
  server: {
    handlers: {
      GET: async () => {
        const bindings = env as unknown as {
          BOT_TOKEN?: string;
          DB?: { prepare(sql: string): { first<T = Record<string, unknown>>(): Promise<T | null> } };
        };
        if (!bindings.BOT_TOKEN) {
          return Response.json({ ok: false, error: "BOT_TOKEN is not configured" }, { status: 500 });
        }
        try {
          const response = await fetch(
            `https://api.telegram.org/bot${bindings.BOT_TOKEN}/getWebhookInfo`
          );
          const telegram = await response.json() as any;
          let database = null;
          if (bindings.DB) {
            const row = await bindings.DB.prepare(
              "SELECT (SELECT COUNT(*) FROM business_connections) AS connections, (SELECT COUNT(*) FROM business_messages) AS messages"
            ).first<{ connections: number; messages: number }>();
            database = row;
          }
          return Response.json({
            ok: telegram.ok === true,
            webhook: telegram.result ?? null,
            telegram_error: telegram.ok ? null : telegram.description ?? "Telegram API error",
            database
          });
        } catch (error) {
          return Response.json({
            ok: false,
            error: error instanceof Error ? error.message : "Diagnostics failed"
          }, { status: 500 });
        }
      }
    }
  }
});
