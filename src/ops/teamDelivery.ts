/**
 * שליחה/עריכה/מחיקה של הודעת צוות + פרסום אירוע SSE למשתתפי השיחה — מסלול אחד משותף ל-API
 * (server/teamApi.ts) ולכל מי שישלח הודעת צוות בשם משתמש (למשל כלי הסוכן בעתיד).
 *
 * הזהות: `me` הוא תמיד מפתח משתמש שכבר אומת בשרת (עוגייה / ההקשר של הסוכן) — לא קלט חופשי. כל ההרשאות
 * (חברות בשיחה, שולח בלבד לעריכה/מחיקה) נאכפות ב-repository; כאן אין עקיפה לפי תפקיד.
 *
 * אידמפוטנטיות: אותו clientMessageId מאותו שולח באותה שיחה מחזיר את ההודעה הקיימת (duplicate=true) —
 * ואז **לא** מפורסם אירוע (לא נוצרה הודעה חדשה, אין מה להודיע עליו). לכן שליחה חוזרת, למשל התאוששות
 * מפנייה ב-sending עם `ao:<outreachId>`, לא יוצרת כפילות ולא אירוע מטעה.
 *
 * SSE: ממחזר את notificationBus (publishNotificationLive) בלי bus נוסף ובלי שורה ב-notifications, כך שמוני
 * הפעמון ו-seen_at לא מושפעים. האירוע נושא מזהים בלבד, בלי גוף הודעה, ומגיע רק לחברי השיחה.
 */

import {
  deleteMessage,
  editMessage,
  listThreadMemberKeys,
  openDm,
  sendMessage,
  type TeamMessage,
} from "../db/repositories/teamMessages.js";
import { findOutreachAnsweredBy } from "../db/repositories/agentOutreach.js";
import { publishNotificationLive } from "./notificationBus.js";
import { logger } from "../utils/logger.js";

export type TeamEventType = "new" | "edited" | "deleted";
/**
 * עדכון בצ'אט הסוכן על תשובה לפנייה (event: agent_update ב-/api/events). kind נפרד מ-team_message_* אבל
 * גם הוא נתפס ב-teamSseFrame — אחרת /api/events היה מנתב אותו כ"notification" (פעמון).
 */
export const AGENT_UPDATE_KIND_PREFIX = "agent_outreach_";
export type AgentUpdateChange = "new" | "edited" | "deleted";

/**
 * אם `message` (שנשלחה/נערכה/נמחקה ע"י `senderKey`) היא תשובה מפורשת (reply_to_id) לפנייה שנשלחה, מפרסם אירוע
 * מזהים-בלבד לבעל הפנייה בלבד. ה-DB הוא מקור האמת (agent_outreach + team_messages); האירוע רק מעורר שליפה.
 * כשל כאן (קריאה/פרסום) לעולם לא מפיל שליחה/עריכה/מחיקה. לא כותב ל-notifications ולא מסמן נקרא.
 */
function publishAgentUpdate(change: AgentUpdateChange, message: TeamMessage, senderKey: string): void {
  try {
    const outreach = findOutreachAnsweredBy(message.replyTo?.id ?? null, message.threadId, senderKey);
    if (!outreach) return;
    publishNotificationLive({
      userKey: outreach.userKey,
      id: message.id,
      kind: `${AGENT_UPDATE_KIND_PREFIX}reply`,
      body: "",
      findingKey: null,
      itemId: null,
      itemSource: null,
      context: {
        change,
        sessionId: outreach.sessionId,
        outreachId: outreach.id,
        threadId: message.threadId,
        messageId: message.id,
        rev: message.rev,
      },
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error(err, "פרסום עדכון תשובה לפנייה נכשל");
  }
}
/** קידומת kind של אירועי הודעות צוות ב-bus; teamSseFrame (server/teamApi.ts) מזהה לפיה ומונע מהם להפוך להתראת פעמון. */
export const TEAM_EVENT_KIND_PREFIX = "team_message_";

/** מפרסם אירוע לכל משתתפי השיחה (כולל השולח — לשוניות אחרות שלו). בלי גוף הודעה. כשל בפרסום לא מפיל. */
export function publishTeamEvent(
  type: TeamEventType,
  memberKeys: string[],
  threadId: number,
  messageId: number,
  rev: number,
  senderKey: string,
): void {
  for (const userKey of memberKeys) {
    try {
      publishNotificationLive({
        userKey,
        id: messageId,
        kind: `${TEAM_EVENT_KIND_PREFIX}${type}`,
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

/** שליחה בשיחה קיימת. אירוע "new" רק אם נוצרה הודעה חדשה (לא duplicate). */
export function sendTeamMessage(
  me: string,
  threadId: number,
  body: unknown,
  clientMessageId: unknown,
  replyToId?: number | null,
): { message: TeamMessage; duplicate: boolean } {
  const result = sendMessage(me, threadId, body, clientMessageId, replyToId);
  if (!result.duplicate) {
    publishTeamEvent("new", listThreadMemberKeys(me, threadId), threadId, result.message.id, result.message.rev, me);
    publishAgentUpdate("new", result.message, me);
  }
  return result;
}

/**
 * שליחה ישירה לעובד: פותח DM (או משתמש בקיים) ושולח בשם `me`. openDm אידמפוטנטי (הזוג ממוין), ושליחה חוזרת
 * עם אותו clientMessageId מחזירה את ההודעה הקיימת. openDm לא מפרסם אירוע (כמו היום ב-API).
 */
export function sendDirectTeamMessage(
  me: string,
  recipientKey: string,
  body: unknown,
  clientMessageId: unknown,
): { threadId: number; message: TeamMessage; duplicate: boolean } {
  const { threadId } = openDm(me, recipientKey);
  const { message, duplicate } = sendTeamMessage(me, threadId, body, clientMessageId);
  return { threadId, message, duplicate };
}

/** עריכה — רק השולח. מפרסם "edited" לחברי השיחה. */
export function editTeamMessage(me: string, threadId: number, messageId: number, body: unknown): TeamMessage {
  const message = editMessage(me, messageId, body, threadId);
  publishTeamEvent("edited", listThreadMemberKeys(me, threadId), threadId, message.id, message.rev, me);
  publishAgentUpdate("edited", message, me);
  return message;
}

/** מחיקה רכה — רק השולח. מפרסם "deleted" לחברי השיחה. */
export function deleteTeamMessage(me: string, threadId: number, messageId: number): TeamMessage {
  const message = deleteMessage(me, messageId, threadId);
  publishTeamEvent("deleted", listThreadMemberKeys(me, threadId), threadId, message.id, message.rev, me);
  publishAgentUpdate("deleted", message, me);
  return message;
}
