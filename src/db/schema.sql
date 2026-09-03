CREATE TABLE IF NOT EXISTS pending_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT NOT NULL,
  draft_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- מנוע הבקרה (שלב 4): ממצאים נשמרים בין סריקות כדי לדעת כמה זמן משהו פתוח בלי תזוזה.
CREATE TABLE IF NOT EXISTS control_findings (
  finding_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  who TEXT NOT NULL,
  project TEXT,
  headline TEXT NOT NULL,
  detail TEXT NOT NULL,
  url TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  last_escalated_at TEXT,
  resolved_at TEXT
);

-- הודעות/תזכורות שממתינות למשתמש עד שייכנס לחלונית.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  finding_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_key, seen_at);

-- הודעות WhatsApp יוצאות. סוכן ה-WhatsApp מרוקן את התור; אם הוא לא רץ — ההודעה מחכה.
CREATE TABLE IF NOT EXISTS whatsapp_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
