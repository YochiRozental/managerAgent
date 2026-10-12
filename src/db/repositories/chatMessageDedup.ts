import { db } from "../db.js";

/**
 * Idempotency כלל-צ'אט בחלונית (audit שלב ה, 2026-10-11) — ר' schema.sql להנמקה המלאה. זה
 * השכבה שמחליפה את turnOrdinal כמזהה *ראשי*: clientMessageId מגיע מהלקוח (ui.html, UUID פר
 * שליחה אמיתית), יציב ברטרי, שונה תמיד בין שתי הודעות אמיתיות (גם זהות-תוכן, גם מקבילות).
 */

export type ChatDedupStatus = "processing" | "done";

export interface StoredChatDedup {
  userKey: string;
  clientMessageId: string;
  sessionId: string;
  contentHash: string;
  status: ChatDedupStatus;
  result: unknown | null;
  createdAt: string;
  finishedAt: string | null;
}

interface Row {
  user_key: string;
  client_message_id: string;
  session_id: string;
  content_hash: string;
  status: string;
  result_json: string | null;
  created_at: string;
  finished_at: string | null;
}

function fromRow(r: Row): StoredChatDedup {
  return {
    userKey: r.user_key,
    clientMessageId: r.client_message_id,
    sessionId: r.session_id,
    contentHash: r.content_hash,
    status: r.status as ChatDedupStatus,
    result: r.result_json ? JSON.parse(r.result_json) : null,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

const getStmt = db.prepare(`SELECT * FROM chat_message_dedup WHERE user_key = ? AND client_message_id = ?`);
const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO chat_message_dedup (user_key, client_message_id, session_id, content_hash) VALUES (?, ?, ?, ?)`,
);
const finishStmt = db.prepare(
  `UPDATE chat_message_dedup SET status = 'done', result_json = ?, finished_at = datetime('now')
   WHERE user_key = ? AND client_message_id = ? AND status = 'processing'`,
);
const releaseStmt = db.prepare(`DELETE FROM chat_message_dedup WHERE user_key = ? AND client_message_id = ? AND status = 'processing'`);
// שחזור אחרי קריסה (startup בלבד) — 'processing' תקוע כי תהליך קודם קרס בין claim לסיום. מוחקים
// (לא מאפסים ל-status אחר) כדי שהניסיון החוזר הבא יתפוס מחדש ויריץ מההתחלה — בדיוק כמו release
// רגיל על כשל, רק שאין כאן "err" לרשום (התהליך שידע עליו כבר לא קיים).
const recoverStmt = db.prepare(`DELETE FROM chat_message_dedup WHERE status = 'processing'`);

export type ClaimChatMessageResult =
  | { kind: "claimed" }
  | { kind: "conflict"; existing: StoredChatDedup }
  | { kind: "done"; result: unknown }
  | { kind: "processing" };

/**
 * תופסת (claimed) אם המזהה הזה חדש; אחרת בודקת אם זה retry לגיטימי (content_hash זהה) או conflict
 * (תוכן אחר תחת אותו מזהה — client bug/שימוש חוזר, לא "אותה הודעה"). 'processing' = ניסיון קודם
 * (אותה הודעה בדיוק) עדיין רץ — הקורא אחראי להמתין/לנסות שוב (ר' server/chatDedup.ts).
 */
export function claimChatMessage(userKey: string, clientMessageId: string, sessionId: string, contentHash: string): ClaimChatMessageResult {
  const info = insertStmt.run(userKey, clientMessageId, sessionId, contentHash);
  if (info.changes === 1) return { kind: "claimed" };

  const row = getStmt.get(userKey, clientMessageId) as unknown as Row | undefined;
  if (!row) {
    // מקרה-קצה תיאורטי: ה-INSERT נכשל (changes=0) אבל אין שורה — race אמיתי בין claim מקביל
    // ל-release. מתייחסים כ"עדיין בעיבוד" (safe default — לא ממציאים הצלחה).
    return { kind: "processing" };
  }
  const stored = fromRow(row);
  if (stored.contentHash !== contentHash) return { kind: "conflict", existing: stored };
  if (stored.status === "done") return { kind: "done", result: stored.result };
  return { kind: "processing" };
}

export function getChatMessageClaim(userKey: string, clientMessageId: string): StoredChatDedup | null {
  const row = getStmt.get(userKey, clientMessageId) as unknown as Row | undefined;
  return row ? fromRow(row) : null;
}

/** true ⇔ נרשם בפועל (היה עדיין 'processing' — לא שוחזר/שוחרר בינתיים). */
export function finishChatMessage(userKey: string, clientMessageId: string, result: unknown): boolean {
  return finishStmt.run(JSON.stringify(result), userKey, clientMessageId).changes === 1;
}

/** כשל בריצה — משחררת את התפיסה כדי שניסיון חוזר (אותו מזהה) יוכל לתפוס מחדש ולרוץ מההתחלה. */
export function releaseChatMessageClaim(userKey: string, clientMessageId: string): void {
  releaseStmt.run(userKey, clientMessageId);
}

/** startup בלבד — ר' הערת recoverStmt. מחזיר כמה שורות שוחזרו. */
export function recoverStuckChatMessageClaims(): number {
  return Number(recoverStmt.run().changes);
}
