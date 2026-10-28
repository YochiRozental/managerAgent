/**
 * API של "הודעות צוות" (DM בין עובדים). שכבה דקה מעל src/db/repositories/teamMessages.ts — כל ההרשאות
 * והלוגיקה שם; כאן רק פענוח בקשה, מיפוי שגיאות ופרסום אירועי SSE.
 *
 * המבנה: handleTeamRequest מקבל בקשה מפוענחת ומחזיר {status, body} — בלי req/res — כדי שאפשר לבדוק
 * אותו ישירות (index.ts רק מנתב ושולח). הזהות מגיעה אך ורק מ-`user` (עוגייה מאומתת); senderKey לעולם
 * לא נקרא מגוף הבקשה. אין הרשאת-על: owner/admin הם משתתפים או לא, כמו כל אחד.
 *
 * SSE: ממחזר את notificationBus הקיים (publishNotificationLive) ואת /api/events — בלי bus נוסף ובלי שורה
 * ב-notifications (אז מוני הפעמון ו-seen_at לא מושפעים). האירוע נושא מזהים בלבד, בלי גוף הודעה; הלקוח
 * מושך את התוכן דרך ה-API. teamSseFrame ממיר אירוע bus לפריים SSE ל-/api/events.
 */

import { TEAM_DIRECTORY, type IdentifiedUser } from "../identity/index.js";
import {
  TeamMessageError,
  deleteMessage,
  editMessage,
  listMessages,
  listThreadMemberKeys,
  listThreads,
  markRead,
  openDm,
  sendMessage,
  unreadTotal,
} from "../db/repositories/teamMessages.js";
import { publishNotificationLive, type BusNotification } from "../ops/notificationBus.js";
import { logger } from "../utils/logger.js";

export interface TeamRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  readBody: () => Promise<Record<string, unknown>>;
  user: IdentifiedUser | null;
}

export interface TeamResponse {
  status: number;
  body: unknown;
}

export function isTeamPath(path: string): boolean {
  return path.startsWith("/api/team/");
}

const NOT_FOUND: TeamResponse = { status: 404, body: { error: "לא נמצא" } };

const ERROR_STATUS = { not_found: 404, invalid: 400, forbidden: 403, deleted: 409 } as const;

// ── SSE ───────────────────────────────────────────────────────────────────────────────────────

type TeamEventType = "new" | "edited" | "deleted";
const KIND_PREFIX = "team_message_";

/** מפרסם אירוע לכל משתתפי השיחה (כולל השולח — לשוניות אחרות שלו). בלי גוף הודעה. */
function publishTeamEvent(type: TeamEventType, memberKeys: string[], threadId: number, messageId: number, rev: number, senderKey: string): void {
  for (const userKey of memberKeys) {
    try {
      publishNotificationLive({
        userKey,
        id: messageId,
        kind: `${KIND_PREFIX}${type}`,
        body: "",
        findingKey: null,
        itemId: null,
        itemSource: null,
        context: { threadId, messageId, rev, senderKey },
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.error(err, "פרסום אירוע הודעת צוות נכשל");
    }
  }
}

/**
 * ל-/api/events. undefined → זה לא אירוע צוות (הקוד הקיים ממשיך כרגיל, בלי שינוי). null → אירוע צוות
 * של משתמש אחר (לא כותבים כלום). מחרוזת → פריים SSE להזרמה. הפריים כולל מזהים בלבד.
 */
export function teamSseFrame(n: BusNotification, forUserKey: string): string | null | undefined {
  if (!n.kind.startsWith(KIND_PREFIX)) return undefined;
  if (n.userKey !== forUserKey) return null;
  const ctx = n.context ?? {};
  const data = {
    type: n.kind.slice(KIND_PREFIX.length),
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    rev: ctx.rev,
    senderKey: ctx.senderKey,
  };
  return `event: team\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── ניתוב ─────────────────────────────────────────────────────────────────────────────────────

function intParam(q: URLSearchParams, name: string): number | undefined {
  const raw = q.get(name);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new TeamMessageError("invalid");
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new TeamMessageError("invalid");
  return n;
}

function idFrom(s: string): number {
  const n = Number(s);
  // מזהה שאינו מספר תקין = לא נמצא, כמו שיחה שלא קיימת (אותה תשובה).
  if (!Number.isSafeInteger(n)) throw new TeamMessageError("not_found");
  return n;
}

export async function handleTeamRequest(req: TeamRequest): Promise<TeamResponse> {
  const { user, method, path } = req;
  if (!user) return { status: 401, body: { error: "לא מחובר" } };
  try {
    return await route(req, user, method, path);
  } catch (err) {
    if (err instanceof TeamMessageError) {
      return { status: ERROR_STATUS[err.code], body: { error: err.message } };
    }
    logger.error(err, `בקשת ${path} נכשלה`);
    return { status: 500, body: { error: "שגיאת שרת" } };
  }
}

async function route(req: TeamRequest, user: IdentifiedUser, method: string, path: string): Promise<TeamResponse> {
  const me = user.key;

  if (method === "GET" && path === "/api/team/directory") {
    return {
      status: 200,
      body: {
        users: TEAM_DIRECTORY.filter((m) => m.key !== me).map((m) => ({ key: m.key, name: m.name, role: m.role })),
      },
    };
  }

  if (method === "GET" && path === "/api/team/unread") {
    return { status: 200, body: { unread: unreadTotal(me) } };
  }

  if (path === "/api/team/threads") {
    if (method === "GET") return { status: 200, body: { threads: listThreads(me) } };
    if (method === "POST") {
      const body = await req.readBody();
      if (typeof body.with !== "string") throw new TeamMessageError("invalid");
      const { threadId, created } = openDm(me, body.with);
      return { status: created ? 201 : 200, body: { threadId, created } };
    }
    return NOT_FOUND;
  }

  const messagesMatch = path.match(/^\/api\/team\/threads\/(\d+)\/messages$/);
  if (messagesMatch) {
    const threadId = idFrom(messagesMatch[1]!);
    if (method === "GET") {
      const result = listMessages(me, threadId, {
        beforeId: intParam(req.query, "before"),
        sinceRev: intParam(req.query, "since"),
        limit: intParam(req.query, "limit"),
      });
      return { status: 200, body: result };
    }
    if (method === "POST") {
      const body = await req.readBody();
      let replyTo: number | null | undefined;
      if (body.replyTo === undefined || body.replyTo === null) replyTo = null;
      else if (typeof body.replyTo === "number") replyTo = body.replyTo;
      else throw new TeamMessageError("invalid");
      // senderKey בגוף הבקשה (אם נשלח) מתעלמים ממנו — השולח הוא תמיד המשתמש המאומת.
      const { message, duplicate } = sendMessage(me, threadId, body.body, body.clientMessageId, replyTo);
      if (!duplicate) {
        publishTeamEvent("new", listThreadMemberKeys(me, threadId), threadId, message.id, message.rev, me);
      }
      return { status: duplicate ? 200 : 201, body: { message, duplicate } };
    }
    return NOT_FOUND;
  }

  const messageMatch = path.match(/^\/api\/team\/threads\/(\d+)\/messages\/(\d+)$/);
  if (messageMatch && (method === "PATCH" || method === "DELETE")) {
    const threadId = idFrom(messageMatch[1]!);
    const messageId = idFrom(messageMatch[2]!);
    if (method === "PATCH") {
      const body = await req.readBody();
      const message = editMessage(me, messageId, body.body, threadId);
      publishTeamEvent("edited", listThreadMemberKeys(me, threadId), threadId, message.id, message.rev, me);
      return { status: 200, body: { message } };
    }
    const message = deleteMessage(me, messageId, threadId);
    publishTeamEvent("deleted", listThreadMemberKeys(me, threadId), threadId, message.id, message.rev, me);
    return { status: 200, body: { message } };
  }

  const readMatch = path.match(/^\/api\/team\/threads\/(\d+)\/read$/);
  if (readMatch && method === "POST") {
    const threadId = idFrom(readMatch[1]!);
    const body = await req.readBody();
    const lastReadMessageId = markRead(me, threadId, body.upTo);
    const thread = listThreads(me).find((t) => t.id === threadId);
    return { status: 200, body: { lastReadMessageId, unread: thread?.unread ?? 0, unreadTotal: unreadTotal(me) } };
  }

  return NOT_FOUND;
}
