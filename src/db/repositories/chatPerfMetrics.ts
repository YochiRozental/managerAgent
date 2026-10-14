import { db } from "../db.js";
import { logger } from "../../utils/logger.js";

/**
 * מדדי ביצועים ל-Web Chat (ניטור בלבד) — ר' schema.sql לדוקומנטציה המלאה של העמודות ולמה שבכוונה
 * *אין* כאן (תוכן הודעה/פרומפט/טוקן/פרטי לקוח). נכתב מ-server/index.ts (רישום לכל /api/chat +
 * עדכון הזמן המדווח מהדפדפן) ומ-ops/scheduler.ts (ניקוי יומי).
 */

// כמו backup.ts's KEEP — hardcoded, לא env: זה כלי ניטור פנימי, לא הגדרה תפעולית שמישהו צריך
// לכוונן בסביבת production (ר' CLAUDE.md §9 — לא מוסיפים עומס env בלי צורך).
const RETENTION_DAYS = 30;

export type ChatPerfStatus = "ok" | "error";

export interface ChatPerfEntry {
  requestId: string;
  userKey: string;
  sessionId: string | null;
  status: ChatPerfStatus;
  errorCode?: string | null;
  cached: boolean;
  tier?: string | null;
  fallbackUsed: boolean;
  /** זמן המתנה ל-dedup claim לפני שהעיבוד בפועל התחיל — null אם לא עבר דרך תור כלל */
  queueWaitMs?: number | null;
  serverTotalMs: number;
  aiTimeMs?: number | null;
  aiCallCount?: number | null;
  toolTimeMs?: number | null;
  toolCallCount?: number | null;
}

const insertStmt = db.prepare(`
  INSERT INTO chat_perf_metrics (
    request_id, user_key, session_id, status, error_code, cached, tier, fallback_used,
    queue_wait_ms, server_total_ms, ai_time_ms, ai_call_count, tool_time_ms, tool_call_count
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/** רישום שורה אחת לכל בקשת /api/chat (הצלחה או כשל). לא זורק — כשל רישום לא אמור להכשיל את התשובה למשתמש. */
export function recordChatPerfMetric(e: ChatPerfEntry): void {
  insertStmt.run(
    e.requestId,
    e.userKey,
    e.sessionId ?? null,
    e.status,
    e.errorCode ?? null,
    e.cached ? 1 : 0,
    e.tier ?? null,
    e.fallbackUsed ? 1 : 0,
    e.queueWaitMs != null ? Math.round(e.queueWaitMs) : null,
    Math.round(e.serverTotalMs),
    e.aiTimeMs != null ? Math.round(e.aiTimeMs) : null,
    e.aiCallCount ?? null,
    e.toolTimeMs != null ? Math.round(e.toolTimeMs) : null,
    e.toolCallCount ?? null,
  );
}

const updateClientStmt = db.prepare(`
  UPDATE chat_perf_metrics SET client_total_ms = ?, client_reported_at = datetime('now')
  WHERE request_id = ? AND user_key = ?
`);

/**
 * מעדכן את זמן הדפדפן (שעון מונוטוני משלו — performance.now() בלקוח) על שורה קיימת. מגיע בנפרד
 * מהרישום המקורי (fire-and-forget מהדפדפן אחרי שהתשובה הוצגה) ולכן זו עדכון, לא insert.
 * user_key ב-WHERE — משתמש לא יכול לעדכן/לדרוס שורה שאינה שלו. מחזיר false בשקט אם request_id
 * לא נמצא (כבר נוקה/לא שייך למשתמש) — זו מדידה best-effort, לא קריטית.
 */
export function recordClientTiming(requestId: string, userKey: string, clientTotalMs: number): boolean {
  const info = updateClientStmt.run(Math.round(clientTotalMs), requestId, userKey);
  return Number(info.changes) > 0;
}

const pruneStmt = db.prepare(`DELETE FROM chat_perf_metrics WHERE created_at < datetime('now', ?)`);

/** מוחק שורות ישנות מ-days (ברירת מחדל RETENTION_DAYS). מחזיר כמה שורות נמחקו. */
export function pruneChatPerfMetrics(days: number = RETENTION_DAYS): number {
  const info = pruneStmt.run(`-${days} days`);
  return Number(info.changes);
}

// ───────────────────────── סטטיסטיקות (P50/P95) ─────────────────────────

interface StatRow {
  server_total_ms: number | null;
  ai_time_ms: number | null;
  tool_time_ms: number | null;
  client_total_ms: number | null;
  ai_call_count: number | null;
  status: string;
  cached: number;
}

const recentStmt = db.prepare(`
  SELECT server_total_ms, ai_time_ms, tool_time_ms, client_total_ms, ai_call_count, status, cached
  FROM chat_perf_metrics WHERE created_at >= datetime('now', ?)
`);

/** percentile "nearest-rank" על מערך ממוין עולה. נפח נמוך (ניטור פנימי) — לא דורש פונקציית SQL ייעודית. */
function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}

export interface MetricSummary {
  count: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
}

function summarize(values: (number | null)[]): MetricSummary {
  const nums = values.filter((v): v is number => v != null).sort((a, b) => a - b);
  if (nums.length === 0) return { count: 0, avg: null, p50: null, p95: null };
  const avg = Math.round(nums.reduce((s, v) => s + v, 0) / nums.length);
  return { count: nums.length, avg, p50: percentile(nums, 50), p95: percentile(nums, 95) };
}

export interface ChatPerfSummary {
  sinceHours: number;
  totalRequests: number;
  errorCount: number;
  cachedCount: number;
  avgAiCallCount: number | null;
  /** זמן טיפול בשרת (קבלת בקשה → לפני כתיבת תשובה) */
  server: MetricSummary;
  /** זמן קריאות המודל, בנפרד מכלים */
  aiTime: MetricSummary;
  /** זמן הרצת כלים, בנפרד מהמודל */
  toolTime: MetricSummary;
  /** זמן כולל מדווח-דפדפן (שליחה→הצגת תשובה) — כולל את כל רשת/שרת/AI/כלים */
  clientTotal: MetricSummary;
}

/**
 * סיכום "ריק" — לשימוש כש-getChatPerfSummary עצמה נכשלת (למשל DB locked) ורוצים להחזיר 200
 * עם תשובה תקינה-מבנית למי שקורא (ה-UI/ה-API), במקום לשבור את תצוגת הבקרה. אין כאן ניחוש של
 * מספרים — count=0/null מדויקים ("לא הצלחנו למדוד", לא "מדדנו ואין בקשות").
 */
const EMPTY_METRIC: MetricSummary = { count: 0, avg: null, p50: null, p95: null };
export function emptyChatPerfSummary(sinceHours: number): ChatPerfSummary {
  return {
    sinceHours,
    totalRequests: 0,
    errorCount: 0,
    cachedCount: 0,
    avgAiCallCount: null,
    server: EMPTY_METRIC,
    aiTime: EMPTY_METRIC,
    toolTime: EMPTY_METRIC,
    clientTotal: EMPTY_METRIC,
  };
}

/**
 * סיכום לחלון הזמן האחרון (ברירת מחדל 24 שעות). חישוב percentile פשוט ב-JS — נפח הבקשות הצפוי
 * (צ'אט פנים-משרדי) קטן מכדי שזה יהיה בעיית ביצועים. cached=1 מוחרג מ-server/aiTime/toolTime
 * (אפס עיבוד בפועל, היה מטשטש את ההתפלגות של בקשות אמיתיות) אבל נכלל ב-clientTotal (עדיין
 * חלק מחוויית המשתמש בפועל).
 */
export function getChatPerfSummary(sinceHours: number = 24): ChatPerfSummary {
  const rows = recentStmt.all(`-${sinceHours} hours`) as unknown as StatRow[];
  const nonCached = rows.filter((r) => r.cached === 0);
  return {
    sinceHours,
    totalRequests: rows.length,
    errorCount: rows.filter((r) => r.status === "error").length,
    cachedCount: rows.filter((r) => r.cached === 1).length,
    avgAiCallCount: nonCached.length
      ? Math.round((nonCached.reduce((s, r) => s + (r.ai_call_count ?? 0), 0) / nonCached.length) * 10) / 10
      : null,
    server: summarize(nonCached.map((r) => r.server_total_ms)),
    aiTime: summarize(nonCached.map((r) => r.ai_time_ms)),
    toolTime: summarize(nonCached.map((r) => r.tool_time_ms)),
    clientTotal: summarize(rows.map((r) => r.client_total_ms)),
  };
}

// ───────────────────────── גרסאות "safe" — לעולם לא זורקות ─────────────────────────
//
// הניטור הזה הוא best-effort בהגדרה: כשל ברישום/קריאה שלו לא אמור לעולם להכשיל/לשנות תשובה
// אמיתית ל-/api/chat (או לכל endpoint ניטור אחר). לפני התיקון הזה (2026-10-14), כשל ב-
// recordChatPerfMetric בתוך ה-try של /api/chat ב-server/index.ts היה נתפס ע"י ה-catch הכללי שם
// והופך תשובה *מוצלחת* ל-500 — בדיוק ההפך ממה שניטור אמור לעשות. כל שלוש הפונקציות למטה הן
// ה-API שה-server קורא לו בפועל; הגרסאות הלא-safe נשארות מיוצאות (לבדיקות ישירות) אבל אין להן
// עוד קורא בייצור. הלוג כולל err (שגיאת DB פנימית, למשל "database is locked") ו-requestId —
// לא תוכן הודעה/קלט משתמש, ר' docstring מעל ChatPerfEntry.

/** רישום בטוח — swallow על כל כשל, רק לוג אזהרה. זה מה ש-/api/chat קורא בפועל. */
export function recordChatPerfMetricSafe(e: ChatPerfEntry): void {
  try {
    recordChatPerfMetric(e);
  } catch (err) {
    logger.warn({ err, requestId: e.requestId }, "ניטור ביצועים: רישום מדד נכשל — לא משפיע על התשובה למשתמש");
  }
}

/** עדכון זמן-דפדפן בטוח — swallow על כל כשל. /api/perf/client הוא עצמו fire-and-forget מהדפדפן. */
export function recordClientTimingSafe(requestId: string, userKey: string, clientTotalMs: number): void {
  try {
    recordClientTiming(requestId, userKey, clientTotalMs);
  } catch (err) {
    logger.warn({ err, requestId }, "ניטור ביצועים: עדכון זמן-דפדפן נכשל");
  }
}

/** סיכום בטוח — כשל (למשל DB locked) מחזיר emptyChatPerfSummary במקום לזרוק. */
export function getChatPerfSummarySafe(sinceHours: number = 24): ChatPerfSummary {
  try {
    return getChatPerfSummary(sinceHours);
  } catch (err) {
    logger.warn({ err }, "ניטור ביצועים: שליפת סיכום נכשלה — מחזיר סיכום ריק");
    return emptyChatPerfSummary(sinceHours);
  }
}
