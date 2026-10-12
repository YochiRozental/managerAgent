import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = "data/agent.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// WAL — קורא וכותב לא חוסמים זה את זה (הסורק הכבד רץ בזמן שעובד עדכן משימה מהחלונית),
// והקובץ פחות חשוף להשחתה בקריסה. busy_timeout — במקום להיכשל מיד על נעילה, לחכות עד 5ש'.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA synchronous = NORMAL");

const schema = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf-8");
db.exec(schema);

// מיגרציות קלות למסדי נתונים קיימים (ALTER ... IF NOT EXISTS לא נתמך ב-sqlite)
for (const stmt of [
  "ALTER TABLE chat_messages ADD COLUMN session_id TEXT",
  "ALTER TABLE notifications ADD COLUMN item_id TEXT",
  "ALTER TABLE notifications ADD COLUMN item_source TEXT",
  "ALTER TABLE notifications ADD COLUMN context_json TEXT",
  "ALTER TABLE control_findings ADD COLUMN item_id TEXT",
  "ALTER TABLE control_findings ADD COLUMN item_source TEXT",
  "ALTER TABLE control_findings ADD COLUMN due_date TEXT",
  "ALTER TABLE control_followups ADD COLUMN processing_started_at TEXT",
  "ALTER TABLE control_followups ADD COLUMN last_error TEXT",
  "ALTER TABLE attendance_corrections ADD COLUMN idempotency_key TEXT",
]) {
  try {
    db.exec(stmt);
  } catch {
    /* העמודה כבר קיימת */
  }
}
// UNIQUE נפרד (לא ב-ALTER עצמו — SQLite לא תומך "ADD COLUMN ... UNIQUE" כש-יש כבר שורות):
// NULL מרובים מתעלמים מ-UNIQUE ב-SQLite כברירת מחדל, אז שורות ישנות בלי idempotency_key לא מתנגשות.
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_corrections_idemp ON attendance_corrections (idempotency_key)`);
} catch {
  /* כבר קיים */
}

/**
 * טרנזקציה סינכרונית אמיתית — BEGIN IMMEDIATE (נועל לכתיבה מיידית, לא "נועל רק כשנכתב"; מתאים
 * כש-יודעים מראש שהבלוק יכתוב) / COMMIT / ROLLBACK בכשל. node:sqlite אין לו helper כמו
 * better-sqlite3's db.transaction(fn) — זו העטיפה המקומית. הקריאות בתוך fn כבר סינכרוניות וחסרות
 * await (עיקרון קיים בכל הקוד — ר' claimApproval/claimFollowupForProcessing), אז זה לא פותר מירוץ
 * בין threads (node:sqlite רץ בתהליך יחיד) — זה פותר אטומיות-כשל: אם fn זורק באמצע (אחרי שכתב כבר
 * שינוי אחד ולפני שכתב את השני), ה-ROLLBACK מבטל את מה שכן נכתב, ולא משאיר מצב חצי-עקבי.
 */
export function runInTransaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* אם ה-ROLLBACK עצמו נכשל (למשל אין טרנזקציה פתוחה בפועל) — לא מטביעים את השגיאה המקורית */
    }
    throw err;
  }
}
