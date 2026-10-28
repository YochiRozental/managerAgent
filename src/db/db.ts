import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// נתיב ה-DB: ברירת מחדל `data/agent.db` (ייצור — ללא שינוי). AGENT_DB_PATH מאפשר להפנות למסד אחר,
// ומשמש בעיקר את סביבת הבדיקות (tests/setup/isolate.ts) שמפנה ל-DB זמני מחוץ לריפו.
// fail-closed: תחת Vitest (process.env.VITEST) בלי AGENT_DB_PATH מפורש — זורקים, לעולם לא נופלים
// בשקט ל-data/agent.db. מחוץ ל-Vitest ההתנהגות זהה לחלוטין לקודם.
const DB_PATH = process.env.AGENT_DB_PATH || "data/agent.db";
if (process.env.VITEST && !process.env.AGENT_DB_PATH) {
  throw new Error("בדיקות Vitest חייבות AGENT_DB_PATH מבודד — לא נפתח את data/agent.db");
}
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
/**
 * שדרוג idempotent של team_messages לגרסה עם `rev` (cursor הסנכרון של הודעות צוות). CREATE TABLE IF NOT
 * EXISTS לא משדרג טבלה קיימת, ולכן: (1) מוסיפים את העמודה אם חסרה, (2) ממלאים rev לשורות קיימות לפי סדר
 * id בתוך כל שיחה, (3) רק אז יוצרים אינדקס ייחודי וטריגרים — כדי שלעולם לא יתייחסו לעמודה שלא קיימת.
 * הכל בטרנזקציה אחת; לא מוחק ולא משנה נתונים קיימים מלבד מילוי rev=0. בטוח להרצה חוזרת.
 */
export function upgradeTeamMessagesSchema(conn: DatabaseSync): void {
  const cols = conn.prepare(`PRAGMA table_info(team_messages)`).all() as { name: string }[];
  if (cols.length === 0) return; // הטבלה לא קיימת (לא אמור לקרות אחרי schema.sql)
  conn.exec("BEGIN IMMEDIATE");
  try {
    if (!cols.some((c) => c.name === "rev")) {
      conn.exec(`ALTER TABLE team_messages ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`);
    }
    // מילוי רק בשיחות שעוד אין בהן שום rev (MAX=0): הדירוג לפי id, כלומר 1..N ללא כפילויות.
    conn.exec(
      `UPDATE team_messages SET rev = (SELECT COUNT(*) FROM team_messages b WHERE b.thread_id = team_messages.thread_id AND b.id <= team_messages.id)
       WHERE rev = 0 AND thread_id IN (SELECT thread_id FROM team_messages GROUP BY thread_id HAVING MAX(rev) = 0)`,
    );
    conn.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_team_messages_thread_rev ON team_messages (thread_id, rev)`);
    // הטריגרים נאכפים ב-DB (גם לכתיבה גולמית); עדכון rev עצמו לא מפעיל את טריגר העדכון (מוגבל ל-body/deleted_at).
    conn.exec(`CREATE TRIGGER IF NOT EXISTS trg_team_messages_rev_ins AFTER INSERT ON team_messages
BEGIN
  UPDATE team_messages
  SET rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM team_messages WHERE thread_id = NEW.thread_id)
  WHERE id = NEW.id;
END`);
    conn.exec(`CREATE TRIGGER IF NOT EXISTS trg_team_messages_rev_upd AFTER UPDATE OF body, deleted_at ON team_messages
BEGIN
  UPDATE team_messages
  SET rev = (SELECT MAX(rev) + 1 FROM team_messages WHERE thread_id = NEW.thread_id)
  WHERE id = NEW.id;
END`);
    conn.exec("COMMIT");
  } catch (err) {
    try {
      conn.exec("ROLLBACK");
    } catch {
      /* אין טרנזקציה פתוחה */
    }
    throw err;
  }
}
upgradeTeamMessagesSchema(db);

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
