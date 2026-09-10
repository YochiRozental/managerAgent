/**
 * סגירת הלולאה מול העובד (שלב 3 של הבקשה): העובד קיבל פנייה יזומה על ממצא בקרה, ענה בשפה
 * חופשית, והמערכת מבצעת את הפעולה הנכונה ב-Monday — לפי ההרשאות — מתעדת אותה, וממשיכה לעקוב.
 *
 * כל פעולה כאן:
 *   1. אימות הרשאה + בעלות (דרך updateTask / הבדיקות הקיימות)
 *   2. כתיבה ל-Monday (סטטוס / תאריך)
 *   3. תיעוד: Update על הפריט + finding_event
 *   4. המשך מעקב: snoozed → הבקרה שקטה עד התאריך; employee_responded → שעון ה-staleness מתאפס
 *      פעם אחת; resolved_by_reply → הממצא ייסגר; manager_pinged → הכדור אצל מוטי.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { markNudgesSeenForFinding } from "../db/repositories/notifications.js";
import { recordFindingEvent } from "../db/repositories/findingEvents.js";
import { addNotification } from "../db/repositories/notifications.js";
import { resolveUserByKey, type IdentifiedUser } from "../identity/index.js";
import type { OpsTaskSource } from "../integrations/monday/opsRead.js";
import {
  addTaskNote,
  PARKED_LABEL,
  setTaskDueDate,
  waitingLabel,
} from "../integrations/monday/opsWrite.js";
import { logger } from "../utils/logger.js";
import { updateTask } from "./actions.js";

export interface LoopContext {
  itemId: string;
  source: OpsTaskSource;
  findingKey: string;
  taskName?: string;
}

export interface LoopResult {
  ok: true;
  message: string;
  tracking: string;
}

const src = (c: LoopContext) => c.source;
const who = (u: IdentifiedUser) => u.name;

/** "סיימתי" → סימון בוצע + סגירת הממצא. */
export async function replyDone(user: IdentifiedUser, c: LoopContext): Promise<LoopResult> {
  await updateTask(user, { action: "done", source: src(c), itemId: c.itemId });
  await addTaskNote(c.itemId, `✅ ${who(user)} דיווח/ה שסיים/ה — דרך פנייה יזומה של הבקרה`);
  recordFindingEvent(c.findingKey, "resolved_by_reply", { byUser: user.key, action: "done" });
  markNudgesSeenForFinding(user.key, c.findingKey);
  return { ok: true, message: "סימנתי בוצע ✅", tracking: "הממצא ייסגר בסריקה הבאה. לא אטריד יותר על זה." };
}

/** "אני עדיין עובד על זה" / עדכון התקדמות → הערה + איפוס שעון ה-staleness פעם אחת. */
export async function replyProgress(user: IdentifiedUser, c: LoopContext, note: string): Promise<LoopResult> {
  await updateTask(user, { action: "note", source: src(c), itemId: c.itemId, note: `🔄 ${who(user)}: ${note}` });
  recordFindingEvent(c.findingKey, "employee_responded", { byUser: user.key, note });
  markNudgesSeenForFinding(user.key, c.findingKey);
  return {
    ok: true,
    message: "רשמתי את העדכון על המשימה.",
    tracking: "אתן לך יום עבודה נוסף ואז אבדוק שוב. אם תסיים קודם — עדכן אותי.",
  };
}

/** "צריך עוד יומיים" / דחייה → עדכון תאריך היעד + תיעוד + השהיית הבקרה עד התאריך החדש. */
export async function replyDefer(
  user: IdentifiedUser,
  c: LoopContext,
  newDateISO: string,
  reason?: string,
): Promise<LoopResult> {
  await updateTask(user, { action: "state", source: src(c), itemId: c.itemId, label: "בעבודה" }).catch(() => {});
  await setTaskDueDate(src(c), c.itemId, newDateISO);
  const pretty = DateTime.fromISO(newDateISO).setZone(env.TIMEZONE).toFormat("dd/MM");
  await addTaskNote(
    c.itemId,
    `📅 תאריך היעד נדחה ל-${pretty} לבקשת ${who(user)}${reason ? ` — ${reason}` : ""} (דרך פנייה יזומה של הבקרה)`,
  );
  recordFindingEvent(c.findingKey, "snoozed", { byUser: user.key, snoozeUntil: newDateISO, note: reason });
  markNudgesSeenForFinding(user.key, c.findingKey);
  return {
    ok: true,
    message: `עדכנתי את תאריך היעד ל-${pretty} ותיעדתי.`,
    tracking: `הבקרה תהיה שקטה על זה עד ${pretty}. משם אמשיך לעקוב.`,
  };
}

/** "מחכה ללקוח" / "מחכה ליועץ" → סטטוס המתנה + תיעוד הסיבה + המשך מעקב רך. */
export async function replyWaiting(
  user: IdentifiedUser,
  c: LoopContext,
  on: "client" | "consultant" | "other",
  reason?: string,
): Promise<LoopResult> {
  const label = waitingLabel(src(c), on);
  const onText = on === "client" ? "ללקוח" : on === "consultant" ? "ליועץ/ספק" : "לגורם חיצוני";
  await updateTask(user, { action: "state", source: src(c), itemId: c.itemId, label });
  await addTaskNote(
    c.itemId,
    `⏳ ${who(user)}: ממתינים ${onText}${reason ? ` — ${reason}` : ""} (דרך פנייה יזומה של הבקרה)`,
  );
  recordFindingEvent(c.findingKey, "employee_responded", { byUser: user.key, action: `waiting_${on}`, note: reason });
  markNudgesSeenForFinding(user.key, c.findingKey);
  return {
    ok: true,
    message: `עדכנתי סטטוס ל"${label}" ותיעדתי שממתינים ${onText}.`,
    tracking: "אמשיך לעקוב — אם זה נתקע יותר מדי זמן אחזור אליך.",
  };
}

/** "תקוע כי..." → סטטוס תקוע + הערת חסם + נשאר פתוח להסלמה. */
export async function replyBlocked(user: IdentifiedUser, c: LoopContext, blocker: string): Promise<LoopResult> {
  await updateTask(user, { action: "blocker", source: src(c), itemId: c.itemId, note: blocker });
  recordFindingEvent(c.findingKey, "employee_responded", { byUser: user.key, action: "blocked", note: blocker });
  markNudgesSeenForFinding(user.key, c.findingKey);
  return {
    ok: true,
    message: "סימנתי תקוע ותיעדתי את החסם.",
    tracking: "משימה תקועה עולה לתדריך של מוטי. אם לא תשוחרר — תוסלם.",
  };
}

/** "מחכה למנהל" → תיעוד על המשימה + התראה למוטי שהעובד ממתין להחלטתו (מסלול מיני, לא הסלמה רגילה). */
export async function replyAwaitManager(user: IdentifiedUser, c: LoopContext, question: string): Promise<LoopResult> {
  await addTaskNote(
    c.itemId,
    `🧑‍⚖️ ${who(user)} ממתין/ה להחלטת מנהל: ${question} (דרך פנייה יזומה של הבקרה)`,
  );
  recordFindingEvent(c.findingKey, "manager_pinged", { byUser: user.key, note: question });
  const moti = resolveUserByKey("moti");
  if (moti) {
    addNotification(
      moti.key,
      "awaiting_decision",
      `${who(user)} ממתין/ה להחלטה שלך על "${c.taskName ?? c.itemId}":\n${question}`,
      c.findingKey,
      { itemId: c.itemId, itemSource: c.source, context: { taskName: c.taskName, from: user.key } },
    );
  }
  markNudgesSeenForFinding(user.key, c.findingKey);
  return {
    ok: true,
    message: "תיעדתי על המשימה ועדכנתי את מוטי שאתה ממתין להחלטה שלו.",
    tracking: "הכדור אצל מוטי עכשיו. לא אטריד אותך על זה עד שהוא יחזור אליך.",
  };
}

/** "זה כבר לא רלוונטי" → סטטוס לא-רלוונטי/מושהה + תיעוד + סגירת הממצא. */
export async function replyNotRelevant(user: IdentifiedUser, c: LoopContext, reason?: string): Promise<LoopResult> {
  const label = PARKED_LABEL[src(c)];
  await updateTask(user, { action: "state", source: src(c), itemId: c.itemId, label });
  await addTaskNote(
    c.itemId,
    `🚫 ${who(user)}: המשימה כבר לא רלוונטית${reason ? ` — ${reason}` : ""} (דרך פנייה יזומה של הבקרה)`,
  );
  recordFindingEvent(c.findingKey, "resolved_by_reply", { byUser: user.key, action: "not_relevant", note: reason });
  markNudgesSeenForFinding(user.key, c.findingKey);
  logger.info({ findingKey: c.findingKey, user: user.key }, "ממצא נסגר — העובד דיווח שלא רלוונטי");
  return { ok: true, message: `עדכנתי ל"${label}" ותיעדתי.`, tracking: "הממצא ייסגר. לא אחזור על זה." };
}
