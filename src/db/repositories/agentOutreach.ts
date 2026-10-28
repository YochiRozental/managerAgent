/**
 * פניות יזומות של הסוכן לעובד — ניהול מחזור החיים בלבד (draft → sending → sent / cancelled / expired).
 * הפרדה מכוונת: כאן אין שליחה בפועל — לא sendMessage, לא openDm, לא SSE. השכבה שתשלח תקרא ל-
 * claimForSending, תשלח עם outreachClientMessageId(id) הקבוע, ואז completeSend.
 *
 * פרטיות: כל קריאה/כתיבה מצמצמת ל-user_key של המבקש (ופעולות הטיוטה גם ל-session_id). פנייה של אחר
 * או משיחה אחרת = "לא נמצא" (null/false), בלי לחשוף קיום.
 *
 * אין איפוס אוטומטי של sending ל-draft: שליחה חוזרת בטוחה רק כי ה-clientMessageId קבוע לפנייה
 * (UNIQUE(thread, sender, client_message_id) ב-team_messages מחזיר את ההודעה הקיימת).
 */

import { randomUUID } from "node:crypto";
import { db, runInTransaction } from "../db.js";
import { DELETED_PLACEHOLDER, TEAM_MESSAGE_MAX } from "./teamMessages.js";

export type OutreachStatus = "draft" | "sending" | "sent" | "cancelled" | "expired";

export interface AgentOutreach {
  id: string;
  userKey: string;
  sessionId: string;
  recipientKey: string;
  body: string;
  status: OutreachStatus;
  createdTurn: string;
  expiresAt: string;
  teamMessageId: number | null;
  threadId: number | null;
  createdAt: string;
  sentAt: string | null;
}

/** תשובה מפורשת (reply_to_id) של הנמען להודעת הפנייה. הודעה מחוקה → placeholder, התוכן לא יוצא. */
export interface OutreachReply {
  outreachId: string;
  /** הנוסח שהסוכן שלח בשם המשתמש (להקשר בתצוגה) — של בעל הפנייה עצמו בלבד. */
  outreachBody: string;
  recipientKey: string;
  messageId: number;
  threadId: number;
  senderKey: string;
  body: string;
  deleted: boolean;
  createdAt: string;
  editedAt: string | null;
  rev: number;
}

interface OutreachRow {
  id: string;
  user_key: string;
  session_id: string;
  recipient_key: string;
  body: string;
  status: OutreachStatus;
  created_turn: string;
  expires_at: string;
  team_message_id: number | null;
  thread_id: number | null;
  created_at: string;
  sent_at: string | null;
}

interface ReplyRow {
  outreach_id: string;
  outreach_body: string;
  recipient_key: string;
  id: number;
  thread_id: number;
  sender_key: string;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  rev: number;
}

function toOutreach(r: OutreachRow): AgentOutreach {
  return {
    id: r.id,
    userKey: r.user_key,
    sessionId: r.session_id,
    recipientKey: r.recipient_key,
    body: r.body,
    status: r.status,
    createdTurn: r.created_turn,
    expiresAt: r.expires_at,
    teamMessageId: r.team_message_id,
    threadId: r.thread_id,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

function toReply(r: ReplyRow): OutreachReply {
  const deleted = r.deleted_at !== null;
  return {
    outreachId: r.outreach_id,
    outreachBody: r.outreach_body,
    recipientKey: r.recipient_key,
    messageId: r.id,
    threadId: r.thread_id,
    senderKey: r.sender_key,
    body: deleted ? DELETED_PLACEHOLDER : r.body,
    deleted,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    rev: r.rev,
  };
}

const iso = (d: Date) => d.toISOString();

const insertStmt = db.prepare(
  `INSERT INTO agent_outreach (id, user_key, session_id, recipient_key, body, created_turn, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const supersedeDraftsStmt = db.prepare(
  `UPDATE agent_outreach SET status = 'cancelled'
   WHERE user_key = ? AND session_id = ? AND status = 'draft'`,
);
const getOwnStmt = db.prepare(`SELECT * FROM agent_outreach WHERE id = ? AND user_key = ?`);
const getScopedStmt = db.prepare(`SELECT * FROM agent_outreach WHERE id = ? AND user_key = ? AND session_id = ?`);
const latestPendingStmt = db.prepare(
  `SELECT * FROM agent_outreach
   WHERE user_key = ? AND session_id = ? AND status = 'draft' AND expires_at > ?
   ORDER BY created_at DESC, rowid DESC LIMIT 1`,
);
const cancelDraftStmt = db.prepare(
  `UPDATE agent_outreach SET status = 'cancelled'
   WHERE id = ? AND user_key = ? AND session_id = ? AND status = 'draft'`,
);
const expireStmt = db.prepare(`UPDATE agent_outreach SET status = 'expired' WHERE status = 'draft' AND expires_at <= ?`);
const claimStmt = db.prepare(
  `UPDATE agent_outreach SET status = 'sending'
   WHERE id = ? AND user_key = ? AND session_id = ? AND status = 'draft' AND expires_at > ?`,
);
const completeStmt = db.prepare(
  `UPDATE agent_outreach
   SET status = 'sent', team_message_id = ?, thread_id = ?, sent_at = datetime('now')
   WHERE id = ? AND user_key = ? AND status = 'sending'`,
);
const listScopeStmt = db.prepare(
  `SELECT * FROM agent_outreach WHERE user_key = ? AND session_id = ? ORDER BY created_at ASC, rowid ASC`,
);
const listSendingStmt = db.prepare(
  `SELECT * FROM agent_outreach WHERE user_key = ? AND status = 'sending' ORDER BY created_at ASC, rowid ASC`,
);

// תשובה = הודעת הנמען, באותה שיחה, עם reply_to_id = הודעת הפנייה. EXISTS על חברות — הגנה נוספת.
const listRepliesStmt = db.prepare(
  `SELECT o.id AS outreach_id, o.body AS outreach_body, o.recipient_key, r.id, r.thread_id, r.sender_key, r.body, r.created_at, r.edited_at, r.deleted_at, r.rev
   FROM agent_outreach o
   JOIN team_messages r ON r.reply_to_id = o.team_message_id AND r.thread_id = o.thread_id
   WHERE o.user_key = ? AND o.session_id = ? AND o.status = 'sent' AND r.sender_key = o.recipient_key
     AND r.id > ?
     AND EXISTS (SELECT 1 FROM team_thread_members m WHERE m.thread_id = o.thread_id AND m.user_key = o.user_key)
   ORDER BY r.id ASC`,
);
const outreachForMessageStmt = db.prepare(
  `SELECT * FROM agent_outreach
   WHERE team_message_id = ? AND thread_id = ? AND recipient_key = ? AND status = 'sent'`,
);

/** ה-client_message_id הקבוע של הפנייה — נגזר מה-id בלבד, כדי ששליחה חוזרת (התאוששות) תהיה אידמפוטנטית. */
export function outreachClientMessageId(outreachId: string): string {
  return `ao:${outreachId}`;
}

/**
 * יוצר טיוטה. טיוטה קודמת של אותו משתמש באותה שיחת סוכן מבוטלת באותה טרנזקציה — רק הטיוטה האחרונה
 * ניתנת לאישור. פניות ב-sending/sent לא נוגעים בהן.
 */
export function createDraft(input: {
  userKey: string;
  sessionId: string;
  recipientKey: string;
  body: string;
  createdTurn: string;
  expiresAt: Date;
}): AgentOutreach {
  const body = input.body.trim();
  if (!body) throw new Error("גוף הפנייה ריק");
  if (Array.from(body).length > TEAM_MESSAGE_MAX) throw new Error(`הפנייה ארוכה מדי (עד ${TEAM_MESSAGE_MAX} תווים)`);
  if (!input.userKey || !input.sessionId || !input.recipientKey || !input.createdTurn) throw new Error("פרטי פנייה חסרים");
  if (input.userKey === input.recipientKey) throw new Error("אי אפשר לפנות לעצמך");
  const id = `ao_${randomUUID().slice(0, 8)}`;
  return runInTransaction(() => {
    supersedeDraftsStmt.run(input.userKey, input.sessionId);
    insertStmt.run(id, input.userKey, input.sessionId, input.recipientKey, body, input.createdTurn, iso(input.expiresAt));
    return toOutreach(getOwnStmt.get(id, input.userKey) as unknown as OutreachRow);
  });
}

/** הטיוטה הממתינה האחרונה של המשתמש בשיחה, רק אם לא פג תוקפה. לא כותב. */
export function getPendingDraft(userKey: string, sessionId: string, now: Date = new Date()): AgentOutreach | null {
  const row = latestPendingStmt.get(userKey, sessionId, iso(now)) as unknown as OutreachRow | undefined;
  return row ? toOutreach(row) : null;
}

/** פנייה לפי id — רק של המשתמש (כל סטטוס). של אחר / לא קיימת → null. */
export function getOutreach(id: string, userKey: string): AgentOutreach | null {
  const row = getOwnStmt.get(id, userKey) as unknown as OutreachRow | undefined;
  return row ? toOutreach(row) : null;
}

/** פנייה לפי id בהקשר משתמש + שיחת סוכן. */
export function getOutreachInSession(id: string, userKey: string, sessionId: string): AgentOutreach | null {
  const row = getScopedStmt.get(id, userKey, sessionId) as unknown as OutreachRow | undefined;
  return row ? toOutreach(row) : null;
}

/** ביטול טיוטה ספציפית (draft בלבד). true רק אם בוטלה בפועל. */
export function cancelDraft(id: string, userKey: string, sessionId: string): boolean {
  return Number(cancelDraftStmt.run(id, userKey, sessionId).changes) === 1;
}

/** מסמן כ-expired כל טיוטה שפג תוקפה. מחזיר כמה סומנו. אידמפוטנטי. */
export function expireDrafts(now: Date = new Date()): number {
  return Number(expireStmt.run(iso(now)).changes);
}

/**
 * CAS: draft → sending. true לאחד בלבד מכמה ניסיונות מקבילים; false אם כבר לא draft, פג תוקף,
 * או שהפנייה לא של המשתמש/השיחה. אחרי true — חובה להשלים (completeSend) או לטפל ב-sending.
 */
export function claimForSending(id: string, userKey: string, sessionId: string, now: Date = new Date()): boolean {
  return Number(claimStmt.run(id, userKey, sessionId, iso(now)).changes) === 1;
}

export type CompleteSendResult = "ok" | "not_sending" | "message_already_linked";

/**
 * sending → sent עם team_message_id ו-thread_id. אידמפוטנטי: אם הפנייה כבר sent עם אותה הודעה — "ok".
 * הודעה ששויכה כבר לפנייה אחרת (UNIQUE) → "message_already_linked", בלי שינוי.
 */
export function completeSend(id: string, userKey: string, teamMessageId: number, threadId: number): CompleteSendResult {
  const current = getOwnStmt.get(id, userKey) as unknown as OutreachRow | undefined;
  if (!current) return "not_sending";
  if (current.status === "sent") {
    return current.team_message_id === teamMessageId && current.thread_id === threadId ? "ok" : "not_sending";
  }
  try {
    return Number(completeStmt.run(teamMessageId, threadId, id, userKey).changes) === 1 ? "ok" : "not_sending";
  } catch (err) {
    if (/UNIQUE/i.test((err as Error).message)) return "message_already_linked";
    throw err;
  }
}

/** פניות המשתמש בשיחת סוכן, מהישנה לחדשה. */
export function listOutreach(userKey: string, sessionId: string): AgentOutreach[] {
  return (listScopeStmt.all(userKey, sessionId) as unknown as OutreachRow[]).map(toOutreach);
}

/** פניות של המשתמש שנתקעו ב-sending (למשל אחרי קריסה) — לשימוש התאוששות אידמפוטנטית. לא משנה כלום. */
export function listSending(userKey: string): AgentOutreach[] {
  return (listSendingStmt.all(userKey) as unknown as OutreachRow[]).map(toOutreach);
}

/**
 * תשובות מפורשות לפניות של המשתמש בשיחת סוכן — קריאה בלבד. `afterMessageId` לשליפה חלקית (catch-up).
 * הודעה רגילה (בלי reply_to_id לפנייה) לעולם לא מופיעה כאן. לא נוגע בסימון נקרא/מוני unread.
 */
export function listRepliesForSession(userKey: string, sessionId: string, afterMessageId = 0): OutreachReply[] {
  return (listRepliesStmt.all(userKey, sessionId, afterMessageId) as unknown as ReplyRow[]).map(toReply);
}

/**
 * זיהוי לאחור: האם הודעת צוות נתונה (נמען, שיחה, reply_to_id) היא תשובה לפנייה שנשלחה? מחזיר את
 * הפנייה או null. קריאה בלבד; מיועד לשלב ה-API/SSE.
 */
export function findOutreachAnsweredBy(replyToMessageId: number | null, threadId: number, senderKey: string): AgentOutreach | null {
  if (replyToMessageId === null) return null;
  const row = outreachForMessageStmt.get(replyToMessageId, threadId, senderKey) as unknown as OutreachRow | undefined;
  return row ? toOutreach(row) : null;
}
