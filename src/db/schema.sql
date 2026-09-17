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
  item_id TEXT,
  item_source TEXT,
  due_date TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  last_escalated_at TEXT,
  resolved_at TEXT
);

-- הודעות/תזכורות שממתינות למשתמש עד שייכנס לחלונית.
-- item_id/item_source/context_json — לפניות יזומות של מנוע הבקרה ("דוב, המשימה X מאחרת, מה קורה?"):
-- קושרים את ההודעה למשימת Monday ספציפית כדי שהתשובה של העובד תדע על מה מדובר.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT NOT NULL,
  kind TEXT NOT NULL,               -- reminder | escalation | briefing | weekly | nudge | awaiting_decision
  body TEXT NOT NULL,
  finding_key TEXT,
  item_id TEXT,
  item_source TEXT,                 -- general | project_stage
  context_json TEXT,                -- {taskName, project, ...} לתצוגה
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_key, seen_at);

-- אירועים על ממצא בקרה — מה קרה איתו מעבר לסריקה עצמה: העובד הגיב, נדחה לתאריך, נסגר בעקבות
-- תשובה, המנהל עודכן. escalation.ts קורא מכאן כדי לעצור/לאפס את שעון ההסלמה.
CREATE TABLE IF NOT EXISTS finding_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_key TEXT NOT NULL,
  event TEXT NOT NULL,              -- nudge_sent | employee_responded | snoozed | resolved_by_reply | manager_pinged
  payload_json TEXT,               -- {snoozeUntil?, note?, byUser?, action?}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_finding_events_key ON finding_events (finding_key, id);

-- היסטוריית שיחות — כל הודעה נשמרת בשרת (לא רק ב-localStorage של הדפדפן).
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT NOT NULL,
  session_id TEXT,                 -- מזהה שיחה; כל "שיחה חדשה" = session_id חדש
  role TEXT NOT NULL,              -- user | assistant
  content TEXT NOT NULL,
  actions TEXT,                    -- JSON של פעולות שבוצעו בסבב הזה
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages (user_key, session_id, id);

-- התחייבויות (מטרה 7): מה הובטח, למי, מתי צריך לקיים. נרשם דרך הצ'אט.
CREATE TABLE IF NOT EXISTS commitments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by TEXT NOT NULL,        -- user_key של מי שרשם
  to_whom TEXT NOT NULL,           -- הלקוח / הגורם
  what TEXT NOT NULL,
  due_date TEXT,                   -- YYYY-MM-DD
  project TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open | done | cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments (status, due_date);

-- הודעות WhatsApp יוצאות. סוכן ה-WhatsApp מרוקן את התור; אם הוא לא רץ — ההודעה מחכה.
CREATE TABLE IF NOT EXISTS whatsapp_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

-- פעימות לב פר-תהליך. כל תהליך (ops-window / whatsapp-agent) כותב את השם שלו כל דקה.
-- /health קורא מכאן כדי לדעת אם תהליך חי — עובד גם כשהתהליכים בשרתים/קונטיינרים נפרדים.
CREATE TABLE IF NOT EXISTS heartbeats (
  process TEXT PRIMARY KEY,
  beat_at TEXT NOT NULL,
  pid INTEGER,
  detail TEXT
);

-- מערכת האישורים למוטי (שלב 2 של הלולאה): כשה-Policy Engine מחזיר manager_approval_required,
-- הבקשה נשמרת כאן (לא רק כ-notification) — שורדת ריסטרט שרת, ואפשר להכריע בה בכל זמן.
-- גנרי: kind מאפשר בעתיד גם cancellation/reassignment, לא רק deferral.
CREATE TABLE IF NOT EXISTS manager_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | pending_instruction | approving | approved | rejected | superseded
  kind TEXT NOT NULL,                     -- deferral | cancellation | reassignment
  requested_by TEXT NOT NULL,             -- user_key של העובד שביקש
  manager_user_key TEXT NOT NULL,         -- מי מחליט (מוטי)
  finding_key TEXT,
  item_id TEXT,
  item_source TEXT,
  task_name TEXT,
  payload_json TEXT NOT NULL,             -- לדחייה: oldDueDate, requestedNewDueDate, reason, priorDeferrals, ruleId, wasOverdue
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decision_by TEXT,
  decision_note TEXT,                     -- הערת דחייה, או ההנחיה החופשית האחרונה (instruction)
  execution_status TEXT,                  -- null | executed | failed
  execution_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_manager_approvals_manager ON manager_approvals (manager_user_key, status, id);
CREATE INDEX IF NOT EXISTS idx_manager_approvals_finding ON manager_approvals (finding_key, kind, status);

-- היסטוריית שיחה על בקשת אישור (2026-09-14, סגירת פער ה-audit): מוטי שואל/מנחה, העובד עונה.
-- append-only — לא נדרס שדה יחיד. מאפשר בהמשך יותר מסבב אחד של שאלה/תשובה.
CREATE TABLE IF NOT EXISTS manager_approval_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL,
  sender_user_key TEXT NOT NULL,
  sender_role TEXT NOT NULL,   -- manager | employee
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_approval_messages_approval ON manager_approval_messages (approval_id, id);

-- Follow-up Engine (2026-09-14): "אני צריך לחזור לבדוק את זה בתאריך מסוים" — תשתית זיכרון מעקב
-- עתידי, גנרית לפי kind. Monday נשאר מקור האמת למשימות; הטבלה הזו רק זוכרת מתי לחזור לבדוק.
CREATE TABLE IF NOT EXISTS control_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_key TEXT,
  item_id TEXT,
  item_source TEXT,
  user_key TEXT NOT NULL,           -- מי צריך את הבדיקה (בד"כ העובד שהתחייב)
  kind TEXT NOT NULL,                -- commitment_check | external_wait_check | no_response_reminder | end_of_day_check | manager_followup
  due_at TEXT NOT NULL,              -- ISO datetime ב-UTC (תמיד — ראה followups.ts) — מתי runDueFollowups אמור לטפל בזה
  status TEXT NOT NULL DEFAULT 'pending', -- pending | processing | triggered | completed | cancelled
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processing_started_at TEXT,       -- Audit 2026-09-15: מתי claimFollowupForProcessing תפס — לשחזור אחרי קריסה
  last_error TEXT,                  -- שגיאה אחרונה אם חזר ל-pending אחרי כשל (retry metadata)
  triggered_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_control_followups_due ON control_followups (status, due_at);
CREATE INDEX IF NOT EXISTS idx_control_followups_item ON control_followups (item_id, item_source, kind, status);

-- ריצות של עבודות מתוזמנות (הסבב היומי, הדוח השבועי, הגיבוי). מאפשר catch-up אחרי ריסטרט
-- ("האם הסבב של היום כבר רץ?") ומזין את /health בזמן/הצלחת הריצה האחרונה.
-- Idempotency ליצירת פריטים מהחלונית (create_task/create_lead, שלב הבקשה של יוכי 2026-09-17):
-- מונע כפילות אם אותו tool call רץ פעמיים (timeout + retry, fallback FAST→SMART וכו').
-- idempotency_key דטרמיניסטי מהקלט המנורמל — ר' src/ops/actions.ts.
CREATE TABLE IF NOT EXISTS idempotent_creations (
  idempotency_key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,               -- daily_cycle | weekly_report | db_backup
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  ok INTEGER,                      -- 1 הצליח · 0 נכשל · NULL עדיין רץ
  trigger TEXT,                    -- schedule | catchup | manual
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs (job, started_at);
