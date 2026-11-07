import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Telegram Secretary Bot" },
      { name: "description", content: "Auto-reply, log, and notify on edits/deletes for your Telegram Business chats." },
      { property: "og:title", content: "Telegram Secretary Bot" },
      { property: "og:description", content: "Auto-reply, log, and notify on edits/deletes for your Telegram Business chats." },
    ],
  }),
  component: Index,
});

function Index() {
  const botUsername = "limsovannradybot";
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 px-6 py-16">
      <div className="mx-auto max-w-2xl">
        <div className="inline-flex items-center gap-2 rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-700">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          Telegram Business Bot Setup
        </div>
        <h1 className="mt-6 text-4xl font-bold tracking-tight text-slate-900">
          Telegram Secretary Bot
        </h1>
        <p className="mt-3 text-lg text-slate-600">
          ឆ្លើយតបស្វ័យប្រវត្តិ • រក្សាទុកសារ • ជូនដំណឹងពេលលុប/កែ
        </p>

        <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">របៀបភ្ជាប់ (Telegram Premium តម្រូវ)</h2>
          <ol className="mt-4 space-y-3 text-sm text-slate-700">
            <li>
              <span className="font-semibold text-slate-900">1.</span> បើក Telegram → <em>Settings</em> →{" "}
              <em>Business</em> → <em>Chatbots</em>
            </li>
            <li>
              <span className="font-semibold text-slate-900">2.</span> ជ្រើសរើស Bot៖{" "}
              <a
                href={`https://t.me/${botUsername}`}
                className="rounded bg-slate-100 px-2 py-0.5 font-mono text-blue-600 hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                @{botUsername}
              </a>
            </li>
            <li>
              <span className="font-semibold text-slate-900">3.</span> បើក <em>Reply to messages</em>{" "}
              ដើម្បីឱ្យ bot ឆ្លើយតបជំនួសអ្នក
            </li>
            <li>
              <span className="font-semibold text-slate-900">4.</span> រួចរាល់! Bot នឹងផ្ញើសារបញ្ជាក់មកអ្នក
            </li>
          </ol>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Feature title="Auto-reply" desc="ឆ្លើយតបស្វ័យប្រវត្តិទៅអតិថិជន" />
          <Feature title="Message log" desc="រក្សាទុកសារទាំងអស់" />
          <Feature title="Delete alerts" desc="ដឹងភ្លាមពេលមានសារត្រូវបានលុប" />
        </div>

        <p className="mt-10 text-xs text-slate-500">
          Webhook endpoint: <code className="rounded bg-slate-100 px-1">/api/public/telegram/webhook</code>
        </p>
      </div>
    </main>
  );
}

function Feature({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-sm font-semibold text-slate-900">{title}</div>
      <div className="mt-1 text-xs text-slate-600">{desc}</div>
    </div>
  );
}
