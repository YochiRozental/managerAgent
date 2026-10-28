/**
 * טעינת שיחת סוכן ל-UI: הודעות הצ'אט (כמו תמיד) + עדכוני צוות מקושרים ("virtual updates").
 *
 * עדכון = תשובה מפורשת (כפתור "השב": reply_to_id) של עובד להודעה שהסוכן שלח בשם המשתמש. העדכונים **לא
 * מועתקים** ל-chat_messages: נשלפים מה-DB בכל טעינה, לפי המשתמש ושיחת הסוכן בלבד, וכל אחד מקושר למזהה
 * הודעת התשובה (`messageId`) — מפתח ה-dedupe בלקוח. עריכה/מחיקה של התשובה מתבטאות בשליפה הבאה
 * (deleted + placeholder). לא נוגע ב-latestSessionId / ב-listSessions / ב-chat_messages, ולא מסמן נקרא.
 * שיחת legacy (בלי session_id) אין לה פניות → [].
 */

import { getSessionMessages, type ChatRow } from "../db/repositories/chatHistory.js";
import { listRepliesForSession } from "../db/repositories/agentOutreach.js";
import { getTeamMemberByKey } from "../identity/directory.js";

export interface TeamUpdate {
  /** מפתח dedupe: מזהה הודעת התשובה */
  messageId: number;
  outreachId: string;
  threadId: number;
  fromKey: string;
  fromName: string;
  /** הנוסח שהסוכן שלח בשם המשתמש */
  outreachBody: string;
  /** תוכן התשובה; מחוקה → placeholder */
  body: string;
  deleted: boolean;
  edited: boolean;
  createdAt: string;
  editedAt: string | null;
  rev: number;
}

export function loadChatSession(
  userKey: string,
  rawSessionId: string | null,
  afterMessageId = 0,
): { messages: ChatRow[]; teamUpdates: TeamUpdate[] } {
  const legacy = !rawSessionId || rawSessionId === "legacy";
  const messages = getSessionMessages(userKey, legacy ? null : rawSessionId);
  const teamUpdates: TeamUpdate[] = legacy
    ? []
    : listRepliesForSession(userKey, rawSessionId!, afterMessageId).map((r) => ({
        messageId: r.messageId,
        outreachId: r.outreachId,
        threadId: r.threadId,
        fromKey: r.senderKey,
        fromName: getTeamMemberByKey(r.senderKey)?.name ?? r.senderKey,
        outreachBody: r.outreachBody,
        body: r.body,
        deleted: r.deleted,
        edited: r.editedAt !== null,
        createdAt: r.createdAt,
        editedAt: r.editedAt,
        rev: r.rev,
      }));
  return { messages, teamUpdates };
}
