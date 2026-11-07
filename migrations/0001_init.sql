CREATE TABLE IF NOT EXISTS business_connections (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  user_chat_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  can_reply INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS business_messages (
  business_connection_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  from_user_id INTEGER,
  from_name TEXT,
  is_outgoing INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  raw_json TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_business_messages_conn ON business_messages (business_connection_id);
CREATE INDEX IF NOT EXISTS idx_business_messages_sent_at ON business_messages (sent_at DESC);

CREATE TABLE IF NOT EXISTS bot_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  away_mode INTEGER NOT NULL DEFAULT 1,
  auto_reply_text TEXT NOT NULL DEFAULT 'សួស្តី! សាររបស់អ្នកត្រូវបានទទួល។ ខ្ញុំនឹងឆ្លើយតបវិញឆាប់ៗ។ 🙏',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO bot_settings (id) VALUES (1);
