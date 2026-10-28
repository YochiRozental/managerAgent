/**
 * הודעות צוות — הודעות אישיות (DM) בין עובדים. עולם נפרד מ-chat_messages (הצ'אט עם הסוכן) ומ-notifications.
 *
 * פרטיות: **כל** פונקציה מקבלת `me` — מפתח משתמש שכבר אומת בשרת (עוגייה) — ובודקת חברות ב-
 * team_thread_members. אין שום עקיפה לפי תפקיד/הרשאה (גם owner/admin הם "משתתף או לא"). הלקוח לעולם
 * לא קובע senderKey: הוא תמיד `me`. שיחה שאינה קיימת ושיחה שאינך חבר בה מחזירות אותה שגיאה בדיוק
 * (not_found, אותה הודעה), כדי לא לחשוף קיום שיחות.
 */

import { db, runInTransaction } from "../db.js";
import { getTeamMemberByKey } from "../../identity/directory.js";

export const TEAM_MESSAGE_MAX = 4000;
export const DELETED_PLACEHOLDER = "הודעה נמחקה";
const CLIENT_ID_MAX = 128;
const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;
const REPLY_PREVIEW_MAX = 120;

export type TeamErrorCode = "not_found" | "invalid" | "forbidden" | "deleted";

const GENERIC_MESSAGES: Record<TeamErrorCode, string> = {
  not_found: "לא נמצא",
  invalid: "הבקשה אינה תקינה",
  forbidden: "אין הרשאה לפעולה הזו",
  deleted: "ההודעה נמחקה",
};

export class TeamMessageError extends Error {
  constructor(
    public readonly code: TeamErrorCode,
    detail?: string,
  ) {
    // not_found תמיד אותה הודעה, בלי פרטים — גם אם detail סופק.
    super(code === "invalid" && detail ? detail : GENERIC_MESSAGES[code]);
    this.name = "TeamMessageError";
  }
}

export interface TeamMessage {
  id: number;
  threadId: number;
  senderKey: string;
  /** הודעה מחוקה → DELETED_PLACEHOLDER; התוכן המקורי לא יוצא מה-repository. */
  body: string;
  deleted: boolean;
  replyTo: { id: number; senderKey: string; preview: string; deleted: boolean } | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  /** revision פר-שיחה — עולה בכל הוספה/עריכה/מחיקה של ההודעה. ה-cursor של הסנכרון. */
  rev: number;
}

export interface TeamThreadSummary {
  id: number;
  kind: string;
  title: string | null;
  /** ב-DM: המשתתף השני. בקבוצה (בעתיד): null. */
  peerKey: string | null;
  lastMessage: TeamMessage | null;
  unread: number;
  lastReadMessageId: number;
  /** ה-revision הגבוה ביותר בשיחה כרגע. */
  rev: number;
}

interface MessageRow {
  id: number;
  thread_id: number;
  sender_key: string;
  body: string;
  reply_to_id: number | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  rev: number;
  r_sender: string | null;
  r_body: string | null;
  r_deleted: string | null;
}

interface AccessRow {
  id: number;
  thread_id: number;
  sender_key: string;
  deleted_at: string | null;
}

function preview(text: string): string {
  const chars = Array.from(text);
  return chars.length > REPLY_PREVIEW_MAX ? chars.slice(0, REPLY_PREVIEW_MAX).join("") + "…" : text;
}

function toMessage(r: MessageRow): TeamMessage {
  const deleted = r.deleted_at !== null;
  return {
    id: r.id,
    threadId: r.thread_id,
    senderKey: r.sender_key,
    body: deleted ? DELETED_PLACEHOLDER : r.body,
    deleted,
    replyTo:
      r.reply_to_id !== null
        ? {
            id: r.reply_to_id,
            senderKey: r.r_sender ?? "",
            preview: r.r_deleted !== null ? DELETED_PLACEHOLDER : preview(r.r_body ?? ""),
            deleted: r.r_deleted !== null,
          }
        : null,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    rev: r.rev,
  };
}

const MESSAGE_SELECT = `
  SELECT m.id, m.thread_id, m.sender_key, m.body, m.reply_to_id, m.created_at, m.edited_at, m.deleted_at, m.rev,
         r.sender_key AS r_sender, r.body AS r_body, r.deleted_at AS r_deleted
  FROM team_messages m
  LEFT JOIN team_messages r ON r.id = m.reply_to_id`;

const isMemberStmt = db.prepare(`SELECT 1 AS ok FROM team_thread_members WHERE thread_id = ? AND user_key = ?`);
const getThreadByDmKeyStmt = db.prepare(`SELECT id FROM team_threads WHERE dm_key = ?`);
const insertThreadStmt = db.prepare(`INSERT OR IGNORE INTO team_threads (kind, dm_key, created_by) VALUES ('dm', ?, ?)`);
const insertMemberStmt = db.prepare(`INSERT OR IGNORE INTO team_thread_members (thread_id, user_key) VALUES (?, ?)`);
const insertMessageStmt = db.prepare(
  `INSERT INTO team_messages (thread_id, sender_key, body, reply_to_id, client_message_id)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT (thread_id, sender_key, client_message_id) DO NOTHING`,
);
const getByClientIdStmt = db.prepare(
  `${MESSAGE_SELECT} WHERE m.thread_id = ? AND m.sender_key = ? AND m.client_message_id = ?`,
);
const getByIdStmt = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`);
// הודעה לפי id — רק אם המשתמש חבר בשיחה שלה. הודעה לא קיימת / בשיחה זרה → אין שורה (אותה תוצאה).
const getAccessibleStmt = db.prepare(
  `SELECT m.id, m.thread_id, m.sender_key, m.deleted_at
   FROM team_messages m
   JOIN team_thread_members t ON t.thread_id = m.thread_id AND t.user_key = ?
   WHERE m.id = ?`,
);
const replyTargetStmt = db.prepare(`SELECT id FROM team_messages WHERE id = ? AND thread_id = ?`);
const editStmt = db.prepare(
  `UPDATE team_messages SET body = ?, edited_at = datetime('now')
   WHERE id = ? AND sender_key = ? AND deleted_at IS NULL`,
);
const deleteStmt = db.prepare(
  `UPDATE team_messages SET deleted_at = datetime('now')
   WHERE id = ? AND sender_key = ? AND deleted_at IS NULL`,
);
const maxRevStmt = db.prepare(`SELECT COALESCE(MAX(rev), 0) AS r FROM team_messages WHERE thread_id = ?`);
const listSinceRevStmt = db.prepare(`${MESSAGE_SELECT} WHERE m.thread_id = ? AND m.rev > ? ORDER BY m.rev ASC LIMIT ?`);
const listMembersStmt = db.prepare(`SELECT user_key FROM team_thread_members WHERE thread_id = ? ORDER BY user_key`);
const maxMessageIdStmt = db.prepare(`SELECT MAX(id) AS m FROM team_messages WHERE thread_id = ?`);
const markReadStmt = db.prepare(
  `UPDATE team_thread_members SET last_read_message_id = MAX(last_read_message_id, ?)
   WHERE thread_id = ? AND user_key = ?`,
);
const getLastReadStmt = db.prepare(
  `SELECT last_read_message_id AS v FROM team_thread_members WHERE thread_id = ? AND user_key = ?`,
);
const listBeforeStmt = db.prepare(`${MESSAGE_SELECT} WHERE m.thread_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`);
const listAfterStmt = db.prepare(`${MESSAGE_SELECT} WHERE m.thread_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`);
const listThreadsStmt = db.prepare(
  `SELECT t.id, t.kind, t.title, mem.last_read_message_id AS last_read,
          (SELECT MAX(id) FROM team_messages WHERE thread_id = t.id) AS last_msg_id,
          (SELECT COALESCE(MAX(rev), 0) FROM team_messages WHERE thread_id = t.id) AS rev,
          (SELECT COUNT(*) FROM team_messages x
             WHERE x.thread_id = t.id AND x.id > mem.last_read_message_id
               AND x.sender_key <> mem.user_key AND x.deleted_at IS NULL) AS unread,
          (SELECT user_key FROM team_thread_members o WHERE o.thread_id = t.id AND o.user_key <> mem.user_key LIMIT 1) AS peer
   FROM team_thread_members mem
   JOIN team_threads t ON t.id = mem.thread_id
   WHERE mem.user_key = ?
   ORDER BY COALESCE(last_msg_id, 0) DESC, t.id DESC`,
);
const unreadTotalStmt = db.prepare(
  `SELECT COUNT(*) AS n
   FROM team_thread_members mem
   JOIN team_messages x ON x.thread_id = mem.thread_id
   WHERE mem.user_key = ? AND x.id > mem.last_read_message_id
     AND x.sender_key <> mem.user_key AND x.deleted_at IS NULL`,
);

function assertMember(me: string, threadId: number): void {
  if (!Number.isInteger(threadId) || !isMemberStmt.get(threadId, me)) throw new TeamMessageError("not_found");
}

function normalizeBody(body: unknown): string {
  if (typeof body !== "string") throw new TeamMessageError("invalid", "ההודעה ריקה");
  const trimmed = body.trim();
  if (!trimmed) throw new TeamMessageError("invalid", "ההודעה ריקה");
  if (Array.from(trimmed).length > TEAM_MESSAGE_MAX) {
    throw new TeamMessageError("invalid", `ההודעה ארוכה מדי (עד ${TEAM_MESSAGE_MAX} תווים)`);
  }
  return trimmed;
}

/** הודעה שאני רשאי לגעת בה: חבר בשיחה → אחרת not_found; ואז שולח בלבד; ואז לא מחוקה. */
function ownMutableMessage(me: string, messageId: number, expectThreadId?: number): void {
  const acc = getAccessibleStmt.get(me, messageId) as unknown as AccessRow | undefined;
  // expectThreadId — ה-API מעביר את השיחה מה-URL; הודעה משיחה אחרת = לא נמצא (בלי לחשוף).
  if (!acc || (expectThreadId !== undefined && acc.thread_id !== expectThreadId)) throw new TeamMessageError("not_found");
  if (acc.sender_key !== me) throw new TeamMessageError("forbidden");
  if (acc.deleted_at !== null) throw new TeamMessageError("deleted");
}

/** פותח DM בין `me` ל-`other`, או מחזיר את הקיים. הזוג ממוין — A→B ו-B→A הן אותה שיחה. */
export function openDm(me: string, other: string): { threadId: number; created: boolean } {
  if (!getTeamMemberByKey(me) || !getTeamMemberByKey(other) || me === other) {
    throw new TeamMessageError("invalid", "אי אפשר לפתוח שיחה עם המשתמש הזה");
  }
  const dmKey = [me, other].sort().join("|");
  return runInTransaction(() => {
    const info = insertThreadStmt.run(dmKey, me);
    const row = getThreadByDmKeyStmt.get(dmKey) as { id: number };
    insertMemberStmt.run(row.id, me);
    insertMemberStmt.run(row.id, other);
    return { threadId: row.id, created: Number(info.changes) === 1 };
  });
}

/** שליחה אידמפוטנטית: אותו clientMessageId מאותו שולח באותה שיחה → ההודעה הקיימת, duplicate=true. */
export function sendMessage(
  me: string,
  threadId: number,
  body: unknown,
  clientMessageId: unknown,
  replyToId?: number | null,
): { message: TeamMessage; duplicate: boolean } {
  assertMember(me, threadId);
  const text = normalizeBody(body);
  if (typeof clientMessageId !== "string" || !clientMessageId || clientMessageId.length > CLIENT_ID_MAX) {
    throw new TeamMessageError("invalid", "מזהה שליחה חסר או לא תקין");
  }
  let reply: number | null = null;
  if (replyToId !== undefined && replyToId !== null) {
    if (!Number.isInteger(replyToId) || !replyTargetStmt.get(replyToId, threadId)) {
      throw new TeamMessageError("invalid", "ההודעה שמגיבים עליה לא נמצאה בשיחה הזו");
    }
    reply = replyToId;
  }
  return runInTransaction(() => {
    const info = insertMessageStmt.run(threadId, me, text, reply, clientMessageId);
    const inserted = Number(info.changes) === 1;
    const row = inserted
      ? (getByIdStmt.get(Number(info.lastInsertRowid)) as unknown as MessageRow)
      : (getByClientIdStmt.get(threadId, me, clientMessageId) as unknown as MessageRow);
    return { message: toMessage(row), duplicate: !inserted };
  });
}

/** עריכה — רק השולח, רק הודעה שלא נמחקה. id/שולח/created_at לא משתנים. */
export function editMessage(me: string, messageId: number, body: unknown, expectThreadId?: number): TeamMessage {
  ownMutableMessage(me, messageId, expectThreadId);
  const text = normalizeBody(body);
  editStmt.run(text, messageId, me);
  return toMessage(getByIdStmt.get(messageId) as unknown as MessageRow);
}

/** מחיקה רכה — רק השולח. מחיקה חוזרת נדחית (deleted), לא נרשמת כפעולה חדשה. */
export function deleteMessage(me: string, messageId: number, expectThreadId?: number): TeamMessage {
  ownMutableMessage(me, messageId, expectThreadId);
  deleteStmt.run(messageId, me);
  return toMessage(getByIdStmt.get(messageId) as unknown as MessageRow);
}

/** השיחות שלי, האחרונה ראשונה. unread = הודעות של אחרים, לא מחוקות, אחרי last_read. */
export function listThreads(me: string): TeamThreadSummary[] {
  const rows = listThreadsStmt.all(me) as unknown as {
    id: number;
    kind: string;
    title: string | null;
    last_read: number;
    last_msg_id: number | null;
    unread: number;
    rev: number;
    peer: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    peerKey: r.kind === "dm" ? r.peer : null,
    lastMessage: r.last_msg_id !== null ? toMessage(getByIdStmt.get(r.last_msg_id) as unknown as MessageRow) : null,
    unread: r.unread,
    lastReadMessageId: r.last_read,
    rev: r.rev,
  }));
}

/**
 * הודעות שיחה, תמיד בסדר עולה. `beforeId` → עמוד אחורה (היסטוריה). `afterId` → הודעות חדשות בלבד (id).
 * `sinceRev` → **סנכרון אחרי ניתוק**: כל הודעה שנוספה/נערכה/נמחקה מאז ה-cursor, בסדר rev עולה, פעם אחת
 * לכל הודעה (במצבה העדכני), גם אם היא ישנה ולא בעמוד האחרון. בלי אף אחד → העמוד האחרון.
 * hasMore = יש עוד באותו כיוון. cursor = ה-rev שממנו ממשיכים: אם hasMore — ה-rev של האחרונה שהוחזרה;
 * אחרת ה-rev הנוכחי של השיחה (הלקוח מעודכן). שיחה שקראה/סונכרנה עם cursor לא מפספסת כלום.
 */
export function listMessages(
  me: string,
  threadId: number,
  opts: { beforeId?: number; afterId?: number; sinceRev?: number; limit?: number } = {},
): { messages: TeamMessage[]; hasMore: boolean; cursor: number } {
  assertMember(me, threadId);
  const { beforeId, afterId, sinceRev } = opts;
  if ([beforeId, afterId, sinceRev].filter((v) => v !== undefined).length > 1) throw new TeamMessageError("invalid");
  for (const v of [beforeId, afterId, sinceRev, opts.limit]) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new TeamMessageError("invalid");
  }
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
  const currentRev = (maxRevStmt.get(threadId) as { r: number }).r;
  if (sinceRev !== undefined) {
    const rows = listSinceRevStmt.all(threadId, sinceRev, limit + 1) as unknown as MessageRow[];
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    // cursor לעולם לא קטן ממה שהלקוח כבר מחזיק, ולא עובר את מה שהוחזר בפועל כשיש עוד.
    const cursor = hasMore ? page[page.length - 1]!.rev : Math.max(sinceRev, currentRev);
    return { messages: page.map(toMessage), hasMore, cursor };
  }
  if (afterId !== undefined) {
    const rows = listAfterStmt.all(threadId, afterId, limit + 1) as unknown as MessageRow[];
    return { messages: rows.slice(0, limit).map(toMessage), hasMore: rows.length > limit, cursor: currentRev };
  }
  const rows = listBeforeStmt.all(threadId, beforeId ?? Number.MAX_SAFE_INTEGER, limit + 1) as unknown as MessageRow[];
  return { messages: rows.slice(0, limit).reverse().map(toMessage), hasMore: rows.length > limit, cursor: currentRev };
}

/** מפתחות חברי השיחה — רק לחבר בה (אחרת not_found). משמש לפרסום אירועי SSE לשני המשתתפים בלבד. */
export function listThreadMemberKeys(me: string, threadId: number): string[] {
  assertMember(me, threadId);
  return (listMembersStmt.all(threadId) as unknown as { user_key: string }[]).map((r) => r.user_key);
}

/** מתקדם בלבד (MAX) ולא מעבר להודעה האחרונה בשיחה. מחזיר את המצב החדש. */
export function markRead(me: string, threadId: number, upToId: unknown): number {
  assertMember(me, threadId);
  if (typeof upToId !== "number" || !Number.isInteger(upToId) || upToId < 0) throw new TeamMessageError("invalid");
  const maxId = (maxMessageIdStmt.get(threadId) as { m: number | null }).m ?? 0;
  markReadStmt.run(Math.min(upToId, maxId), threadId, me);
  return (getLastReadStmt.get(threadId, me) as { v: number }).v;
}

/** סך הלא-נקראות בכל השיחות שלי (למונה על הלשונית). */
export function unreadTotal(me: string): number {
  return (unreadTotalStmt.get(me) as { n: number }).n;
}
