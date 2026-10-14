import { db, runInTransaction } from "../db.js";
import { logger } from "../../utils/logger.js";

/**
 * פירוט שלבים לכל בקשת צ'אט (ר' schema.sql's chat_perf_steps לדוקומנטציה המלאה) — הרחבה ל-
 * chatPerfMetrics.ts: לכל request_id אפשר לדעת לא רק סכום zman כלים/AI, אלא איזה כלי ספציפי
 * (kind='tool') ואיזה שלב הכנה לפני ה-AI (kind='prep', כמו fetchUserOpsTasks) תרמו לזמן.
 * קובץ נפרד מ-chatPerfMetrics.ts בכוונה — לא נוגע בטבלה/בקוד שכבר נבדק ונפרס.
 */

const RETENTION_DAYS = 30; // זהה ל-chatPerfMetrics.ts — אותה מדיניות שמירה

export type ChatPerfStepKind = "tool" | "prep";

export interface ChatPerfStepEntry {
  kind: ChatPerfStepKind;
  /** שם כלי (match ל-tool.name שהמודל קרא) או שם שלב הכנה (למשל "fetch_user_ops_tasks") — metadata בלבד */
  name: string;
  durationMs: number;
  ok: boolean;
}

const insertStmt = db.prepare(`
  INSERT INTO chat_perf_steps (request_id, kind, name, duration_ms, ok)
  VALUES (?, ?, ?, ?, ?)
`);

/**
 * כתיבה מרוכזת — כל שלבי הבקשה (prep+tool) בטרנזקציה אחת (runInTransaction), בסוף הבקשה בלבד.
 * לא N כתיבות סינכרוניות נפרדות תוך כדי הבקשה — ר' audit "כתיבה מרוכזת בסיום" (2026-10-14).
 */
export function recordChatPerfSteps(requestId: string, steps: ChatPerfStepEntry[]): void {
  if (steps.length === 0) return;
  runInTransaction(() => {
    for (const s of steps) {
      insertStmt.run(requestId, s.kind, s.name, Math.round(s.durationMs), s.ok ? 1 : 0);
    }
  });
}

/** גרסה בטוחה — swallow על כל כשל (ר' chatPerfMetrics.ts's *Safe functions, אותו עיקרון בדיוק). */
export function recordChatPerfStepsSafe(requestId: string, steps: ChatPerfStepEntry[]): void {
  try {
    recordChatPerfSteps(requestId, steps);
  } catch (err) {
    logger.warn({ err, requestId }, "ניטור ביצועים: רישום שלבי-בקשה נכשל — לא משפיע על התשובה למשתמש");
  }
}

const pruneStmt = db.prepare(`DELETE FROM chat_perf_steps WHERE created_at < datetime('now', ?)`);

/** מוחק שורות ישנות מ-days (ברירת מחדל RETENTION_DAYS). מחזיר כמה שורות נמחקו. */
export function pruneChatPerfSteps(days: number = RETENTION_DAYS): number {
  const info = pruneStmt.run(`-${days} days`);
  return Number(info.changes);
}

interface StepRow {
  kind: string;
  name: string;
  duration_ms: number;
  ok: number;
  created_at: string;
}

export interface ChatPerfStepRow {
  kind: ChatPerfStepKind;
  name: string;
  durationMs: number;
  ok: boolean;
  createdAt: string;
}

const byRequestStmt = db.prepare(`
  SELECT kind, name, duration_ms, ok, created_at FROM chat_perf_steps WHERE request_id = ? ORDER BY id ASC
`);

/** כל השלבים (prep+tool) של בקשה ספציפית, לפי סדר ריצה — מאפשר לנתח בקשה איטית אחת לפי request_id. */
export function getChatPerfStepsForRequest(requestId: string): ChatPerfStepRow[] {
  const rows = byRequestStmt.all(requestId) as unknown as StepRow[];
  return rows.map((r) => ({
    kind: r.kind as ChatPerfStepKind,
    name: r.name,
    durationMs: r.duration_ms,
    ok: r.ok === 1,
    createdAt: r.created_at,
  }));
}

/** גרסה בטוחה — מחזירה [] במקום לזרוק (ר' chatPerfMetrics.ts's emptyChatPerfSummary, אותו עיקרון). */
export function getChatPerfStepsForRequestSafe(requestId: string): ChatPerfStepRow[] {
  try {
    return getChatPerfStepsForRequest(requestId);
  } catch (err) {
    logger.warn({ err, requestId }, "ניטור ביצועים: שליפת שלבי-בקשה נכשלה — מחזיר רשימה ריקה");
    return [];
  }
}
