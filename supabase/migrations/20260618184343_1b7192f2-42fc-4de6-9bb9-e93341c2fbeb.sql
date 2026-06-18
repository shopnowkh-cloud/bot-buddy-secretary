
-- Business connections (one per Telegram Business owner who connected the bot)
CREATE TABLE public.business_connections (
  id text PRIMARY KEY,
  user_id bigint NOT NULL,
  user_chat_id bigint NOT NULL,
  username text,
  first_name text,
  can_reply boolean NOT NULL DEFAULT false,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.business_connections TO service_role;
ALTER TABLE public.business_connections ENABLE ROW LEVEL SECURITY;

-- All business messages we observe (so deletions/edits can show prior content)
CREATE TABLE public.business_messages (
  business_connection_id text NOT NULL,
  chat_id bigint NOT NULL,
  message_id bigint NOT NULL,
  from_user_id bigint,
  from_name text,
  is_outgoing boolean NOT NULL DEFAULT false,
  text text,
  raw jsonb NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX idx_business_messages_conn ON public.business_messages (business_connection_id);
CREATE INDEX idx_business_messages_sent_at ON public.business_messages (sent_at DESC);
GRANT ALL ON public.business_messages TO service_role;
ALTER TABLE public.business_messages ENABLE ROW LEVEL SECURITY;

-- Single-row settings table
CREATE TABLE public.bot_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  away_mode boolean NOT NULL DEFAULT true,
  auto_reply_text text NOT NULL DEFAULT 'សួស្តី! សារបស់អ្នកត្រូវបានទទួល។ ខ្ញុំនឹងឆ្លើយតបវិញឆាប់ៗ។ 🙏',
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.bot_settings TO service_role;
ALTER TABLE public.bot_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.bot_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
