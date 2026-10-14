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

-- ───────────────────────────────────────────────────────────────────────────
-- מודול נוכחות (2026-10-11, שלב ב — מאחורי ATTENDANCE_MODULE_ENABLED, כבוי כברירת מחדל).
-- עקרון: ה-DB המקומי הוא מקור האמת (Monday לא תומך בכתיבה ל-time_tracking דרך ה-API — ר' מסמך
-- התכנון). attendance_events הוא append-only אמיתי — שום UPDATE על שורה קיימת; תיקון הוא שורה
-- חדשה (event_type='correction') שמצביעה (corrects_event_id) על האירוע שהיא מתקנת. attendance_days
-- הוא cache נגזר בלבד (ניתן לבנות מחדש מהיומן), נשמר כדי לא לסכם events בכל קריאה.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS attendance_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT NOT NULL,
  work_date TEXT NOT NULL,              -- YYYY-MM-DD לפי env.TIMEZONE (לא UTC)
  event_type TEXT NOT NULL,             -- day_open | break_start | break_end | day_close | correction
  effective_event_type TEXT,            -- רק ל-correction: איזה סוג אירוע היא מתקנת בפועל
  corrects_event_id INTEGER,            -- רק ל-correction: ה-id של האירוע המקורי (לעולם לא נדרס)
  reported_for_at TEXT NOT NULL,        -- UTC — השעה שעליה העובד *מדווח* (יכול להיות רטרואקטיבי)
  received_at TEXT NOT NULL DEFAULT (datetime('now')),  -- UTC — מתי ההודעה התקבלה בשרת
  source TEXT NOT NULL,                 -- chat_window | whatsapp | correction
  sequence_no INTEGER NOT NULL,         -- סידור תצוגה בתוך (user_key, work_date)
  requested_by TEXT,                    -- רק ל-correction: מי ביקש (היום תמיד = user_key, מדיניות עצמי-בלבד)
  note TEXT,
  idempotency_key TEXT NOT NULL UNIQUE, -- מגן על retry/הודעה כפולה — ר' attendanceEngine.ts
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attendance_events_day ON attendance_events (user_key, work_date, sequence_no);

CREATE TABLE IF NOT EXISTS attendance_days (
  user_key TEXT NOT NULL,
  work_date TEXT NOT NULL,
  status TEXT NOT NULL,                  -- open | closed | pending_completion
  opened_reported_at TEXT,
  closed_reported_at TEXT,
  net_minutes INTEGER,                   -- מחושב *רק* כש-status='closed' — יום פתוח לעולם לא "שעות מאושרות"
  break_minutes INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  reminder_status TEXT NOT NULL DEFAULT 'none',  -- none | pending_send | sent — ר' attendanceReminderScheduler.ts
  reminder_sent_at TEXT,
  monday_sync_status TEXT NOT NULL DEFAULT 'not_synced',  -- not_synced | pending | synced | failed (לא בשימוש בשלב זה)
  monday_sync_ref TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_key, work_date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_days_status ON attendance_days (status, reminder_status);

CREATE TABLE IF NOT EXISTS attendance_reminder_prefs (
  user_key TEXT PRIMARY KEY,
  reminder_hour INTEGER,
  reminder_minute INTEGER,
  first_asked_at TEXT,                   -- מתי נשאל לראשונה — מונע לשאול שוב אוטומטית בלי צורך
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- יומן ביקורת לתיקוני נוכחות. בדיוק כמו attendance_events — append-only בפועל (אין UPDATE על
-- old_value/new_value/reason אחרי יצירה; רק status/decided_at/approved_by/applied_event_id
-- מתעדכנים בהכרעה, פעם אחת, מוגן ב-CAS).
CREATE TABLE IF NOT EXISTS attendance_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT NOT NULL,                -- של מי הנוכחות
  requested_by TEXT NOT NULL,            -- מי ביקש (מדיניות היום: עצמי בלבד — user_key === requested_by)
  work_date TEXT NOT NULL,
  target_event_id INTEGER,               -- איזה אירוע מתקנים (NULL אם זו תוספת, למשל day_close שנשכח)
  field TEXT NOT NULL,                   -- day_open | break_start | break_end | day_close
  old_value TEXT,
  new_value TEXT NOT NULL,               -- UTC ISO מבוקש
  reason TEXT,
  payroll_month TEXT NOT NULL,           -- YYYY-MM של work_date, בזמן הבקשה
  status TEXT NOT NULL DEFAULT 'pending_approval',  -- pending_approval | applied | rejected
  auto_approved INTEGER NOT NULL DEFAULT 0,          -- 1 = אושר אוטומטית (חודש פתוח + תיקון עצמי)
  approved_by TEXT,
  applied_event_id INTEGER,              -- ה-attendance_events.id שנוצר/שתוקן כשהתיקון הוחל
  idempotency_key TEXT UNIQUE,            -- מזהה הודעה/פעולה יציב (ר' attendanceEngine.ts) — מונע בקשת תיקון כפולה מ-retry
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attendance_corrections_status ON attendance_corrections (status, user_key);

-- ───────────────────────────────────────────────────────────────────────────
-- Idempotency כלל-צ'אט בחלונית (audit שלב ה, 2026-10-11) — מזהה שהלקוח מקצה (clientMessageId,
-- UUID, פר-פעולת-שליחה אמיתית) לפני השליחה; יציב ברטרי (אותה הודעה נכשלת→נשלחת שוב = אותו
-- מזהה), ולעולם לא תלוי ב-history/session (שתי לשוניות עם תוכן זהה מקבלות מזהים שונים כי כל אחת
-- מריצה crypto.randomUUID() משל עצמה). PRIMARY KEY הוא (user_key, client_message_id) בלבד —
-- *בלי* session_id — כדי שגם אם session_id עצמו משתנה בין ניסיון מקורי לחוזר (למשל ההודעה
-- הראשונה-בשיחה-חדשה שהשרת עדיין לא הקצה לה session קבוע כשהניסיון הראשון קרס), עדיין מזוהה
-- כאותה הודעה. session_id נשמר כעמודה רגילה (לצורך תשובה עקבית בקריאה שנייה, לא כחלק מהזהות).
CREATE TABLE IF NOT EXISTS chat_message_dedup (
  user_key TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,     -- hash של ההודעה+ה-context (about) — מזהה חוזר עם תוכן שונה = conflict
  status TEXT NOT NULL DEFAULT 'processing',  -- processing | done
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  PRIMARY KEY (user_key, client_message_id)
);

-- נוכחות שורה = סגור. היעדר שורה = פתוח (ברירת המחדל — לא סוגרים שום חודש אוטומטית, לפי דרישה
-- מפורשת). reopened_at לא NULL = נפתח מחדש (נשאר מתועד להיסטוריה, לא נמחק).
CREATE TABLE IF NOT EXISTS payroll_month_locks (
  month TEXT PRIMARY KEY,                -- YYYY-MM
  closed_by TEXT NOT NULL,
  closed_at TEXT NOT NULL DEFAULT (datetime('now')),
  reopened_by TEXT,
  reopened_at TEXT
);

-- ───────────────────────────────────────────────────────────────────────────
-- ניטור ביצועים ל-Web Chat (2026-10-14) — נמדד בכל בקשת /api/chat כדי לאתר צווארי בקבוק *לפני*
-- אופטימיזציה, לא כדי לשנות התנהגות. בכוונה אין כאן שום עמודת תוכן: לא טקסט הודעה, לא פרומפט, לא
-- פרטי לקוח, לא טוקן/מפתח — רק משכי זמן ומטא-דאטה תפעולי (tier/status/ספירות). retention מוגבל
-- (pruneChatPerfMetrics, נקרא מהסבב היומי של המתזמן — ר' scheduler.ts) — לא נשמר לצמיתות.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_perf_metrics (
  request_id TEXT PRIMARY KEY,          -- נוצר בשרת per HTTP request (לא clientMessageId — זה idempotency, לא מדידה)
  user_key TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL,                 -- ok | error
  error_code TEXT,                      -- קוד קצר בלבד (למשל client_message_id_conflict) — לעולם לא הודעת שגיאה מלאה
  cached INTEGER NOT NULL DEFAULT 0,    -- 1 = תוצאת dedup (לא רץ עיבוד AI/כלים חדש בבקשה הזו)
  tier TEXT,                            -- fast | smart — ה-tier האחרון שהורץ בפועל בבקשה הזו
  fallback_used INTEGER NOT NULL DEFAULT 0,
  queue_wait_ms INTEGER,                -- המתנה ל-dedup claim (לפני שהעיבוד בפועל התחיל) — לא זמן עיבוד בפועל
  server_total_ms INTEGER,              -- מרגע קבלת הבקשה ועד לפני כתיבת התשובה (שעון מונוטוני בשרת)
  ai_time_ms INTEGER,                   -- סכום זמן קריאות המודל (כל ה-tiers/fallback שהורצו בבקשה הזו)
  ai_call_count INTEGER,
  tool_time_ms INTEGER,                 -- סכום זמן הרצת כלים, בנפרד מזמן המודל
  tool_call_count INTEGER,
  client_total_ms INTEGER,              -- מדווח בנפרד ע"י הדפדפן (שעון מונוטוני משלו, לא מסונכרן עם השרת) — עשוי להגיע מעט אחרי השורה עצמה
  client_reported_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_perf_created ON chat_perf_metrics (created_at);
