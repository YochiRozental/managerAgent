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
import { createApproval, type CreateApprovalInput, type StoredApproval } from "../db/repositories/managerApprovals.js";
import { resolveUserByKey, type IdentifiedUser } from "../identity/index.js";
import type { OpsTaskSource } from "../integrations/monday/opsRead.js";
import { addTaskNote, setTaskDueDate, waitingLabel } from "../integrations/monday/opsWrite.js";
import { planDeferralReply } from "./deferralPlan.js";
import { completeFollowupsForItem, scheduleCommitmentCheck, scheduleEndOfDayCheck } from "./followups.js";
import { publishNotificationLive } from "./notificationBus.js";
import { evaluateCancellationRequest, type ApprovalContext } from "./policy.js";
import { logger } from "../utils/logger.js";
import { updateTask } from "./actions.js";

export interface LoopContext {
  itemId: string;
  source: OpsTaskSource;
  findingKey: string;
  taskName?: string;
  /**
   * תאריך היעד הנוכחי של המשימה, אם ידוע מרגע יצירת הפנייה (הבקרה כבר יודעת אותו בזמן הסריקה —
   * ראה controlScan.ts / escalation.ts). ל-Policy Engine בלבד (replyDefer) — לא לניחוש: אם לא
   * הועבר, מטפלים בזה כ"לא ידוע" (null), לא כמנחשים תאריך.
   */
  currentDueDateISO?: string | null;
  /**
   * אם ההודעה הזו היא תשובה לשאלה/הנחיה של מוטי מתוך Approval (pending_instruction) — מזהה
   * אותו Approval. מוזרם מ-notification מסוג "approval_instruction" דרך אותו about קיים,
   * ולא דרך מנגנון מקביל. ראה chat.ts (runOpsChat) ו-approvalActions.replyToApprovalInstruction.
   */
  approvalId?: number;
  /**
   * Rule 4 (EOD Engine, 2026-09-16): true רק כשההודעה הזו היא תשובה ל-nudge של end_of_day_check
   * שבו המשימה עדיין הייתה פתוחה — "אסיים היום" שהוחמצה. מגיע אמין מ-context ה-nudge (followups.ts
   * → notification.context → about), **לא** נגזר מהטקסט החופשי של העובד ולא מ-currentDueDateISO/
   * wasOverdue. replyDefer מעביר את זה ל-Policy Engine בלי לפרש בעצמו. ר' policy.ts.
   */
  missedCommitment?: boolean;
}

export interface LoopResult {
  ok: true;
  message: string;
  tracking: string;
}

/**
 * side-effects משותפים, ניתנים להזרקה, לתשובות ה"פשוטות" (replyWaiting/replyBlocked/replyProgress/
 * replyAwaitManager) — לא replyDefer/replyDone/replyFinishingToday, שכבר קיבלו טיפוסי deps
 * ייעודיים משלהם. Audit 2026-09-15: כל אחת מהן עכשיו גם משלימה follow-up פעיל על הפריט —
 * "ברגע שהעובד נתן תשובה תקפה לפניית follow-up, ה-follow-up נחשב מטופל".
 */
export interface SimpleLoopReplyDeps {
  updateTask?: typeof updateTask;
  addTaskNote?: typeof addTaskNote;
  recordFindingEvent?: typeof recordFindingEvent;
  addNotification?: typeof addNotification;
  markNudgesSeenForFinding?: typeof markNudgesSeenForFinding;
  completeFollowupsForItem?: typeof completeFollowupsForItem;
}

const src = (c: LoopContext) => c.source;
const who = (u: IdentifiedUser) => u.name;

/** best-effort — כשל בסגירת follow-up לעולם לא הופך את התשובה עצמה (שכבר נכתבה) לכישלון. */
function completeFollowupBestEffort(fn: typeof completeFollowupsForItem, c: LoopContext): void {
  try {
    fn(c.itemId, c.source);
  } catch (err) {
    logger.error({ findingKey: c.findingKey, err }, "completeFollowupsForItem נכשל — התשובה עצמה תקפה");
  }
}

/** side-effects הניתנים להזרקה — כמו ReplyDeferDeps, לאותה סיבה (בדיקות בלי Monday אמיתי). */
export interface ReplyDoneDeps {
  updateTask?: typeof updateTask;
  addTaskNote?: typeof addTaskNote;
  recordFindingEvent?: typeof recordFindingEvent;
  markNudgesSeenForFinding?: typeof markNudgesSeenForFinding;
  completeFollowupsForItem?: typeof completeFollowupsForItem;
}

/** "סיימתי" → סימון בוצע + סגירת הממצא + השלמת כל follow-up פעיל על המשימה (לא נשאר commitment_check פתוח). */
export async function replyDone(user: IdentifiedUser, c: LoopContext, deps: ReplyDoneDeps = {}): Promise<LoopResult> {
  const doUpdateTask = deps.updateTask ?? updateTask;
  const doAddTaskNote = deps.addTaskNote ?? addTaskNote;
  const doRecordFindingEvent = deps.recordFindingEvent ?? recordFindingEvent;
  const doMarkNudgesSeenForFinding = deps.markNudgesSeenForFinding ?? markNudgesSeenForFinding;
  const doCompleteFollowupsForItem = deps.completeFollowupsForItem ?? completeFollowupsForItem;

  await doUpdateTask(user, { action: "done", source: src(c), itemId: c.itemId });
  await doAddTaskNote(c.itemId, `✅ ${who(user)} דיווח/ה שסיים/ה — דרך פנייה יזומה של הבקרה`);
  doRecordFindingEvent(c.findingKey, "resolved_by_reply", { byUser: user.key, action: "done" });
  doMarkNudgesSeenForFinding(user.key, c.findingKey);
  try {
    doCompleteFollowupsForItem(c.itemId, c.source);
  } catch (err) {
    logger.error({ findingKey: c.findingKey, err }, "completeFollowupsForItem נכשל אחרי 'סיימתי' — הסימון עצמו תקף");
  }
  return { ok: true, message: "סימנתי בוצע ✅", tracking: "הממצא ייסגר בסריקה הבאה. לא אטריד יותר על זה." };
}

/** side-effects הניתנים להזרקה עבור replyFinishingToday. */
export interface ReplyFinishingTodayDeps {
  updateTask?: typeof updateTask;
  addTaskNote?: typeof addTaskNote;
  recordFindingEvent?: typeof recordFindingEvent;
  markNudgesSeenForFinding?: typeof markNudgesSeenForFinding;
  scheduleEndOfDayCheck?: typeof scheduleEndOfDayCheck;
}

/**
 * "אני עובד על זה, אסיים היום" — ביום ההתחייבות עצמו. **לא** משנה תאריך יעד, **לא** דחייה
 * (אין Policy Engine כאן בכלל — זו לא בקשת דחייה). מתעד + פותח end_of_day_check ליום הנוכחי,
 * ומשלים כל follow-up פעיל קודם על הפריט (השאלה כבר נענתה). הלוגיקה המלאה של סוף היום — השלב
 * הבא, לא כאן: כרגע רק "אל תטריד אותו שוב עד אז".
 */
export async function replyFinishingToday(
  user: IdentifiedUser,
  c: LoopContext,
  deps: ReplyFinishingTodayDeps = {},
): Promise<LoopResult> {
  const doUpdateTask = deps.updateTask ?? updateTask;
  const doAddTaskNote = deps.addTaskNote ?? addTaskNote;
  const doRecordFindingEvent = deps.recordFindingEvent ?? recordFindingEvent;
  const doMarkNudgesSeenForFinding = deps.markNudgesSeenForFinding ?? markNudgesSeenForFinding;
  const doScheduleEndOfDayCheck = deps.scheduleEndOfDayCheck ?? scheduleEndOfDayCheck;

  await doUpdateTask(user, { action: "state", source: src(c), itemId: c.itemId, label: "בעבודה" }).catch(() => {});
  await doAddTaskNote(c.itemId, `🕓 ${who(user)}: עובד/ת על זה, מתחייב/ת לסיים היום (דרך פנייה יזומה של הבקרה)`);
  doRecordFindingEvent(c.findingKey, "employee_responded", {
    byUser: user.key,
    note: "מתחייב/ת לסיים היום",
    action: "finishing_today",
  });
  doMarkNudgesSeenForFinding(user.key, c.findingKey);

  try {
    doScheduleEndOfDayCheck(
      {
        itemId: c.itemId,
        itemSource: c.source,
        findingKey: c.findingKey,
        userKey: user.key,
        taskName: c.taskName,
        // "אסיים היום" לא משנה את תאריך היעד — מעביר את התאריך האמיתי (הקיים) הלאה, כדי שאם
        // ב-17:00 יבקשו דחייה, Policy Engine יראה נכון האם ההתחייבות פוספסה (audit 2026-09-16).
        currentDueDateISO: c.currentDueDateISO ?? null,
      },
      DateTime.now().setZone(env.TIMEZONE),
    );
  } catch (err) {
    logger.error({ findingKey: c.findingKey, err }, "scheduleEndOfDayCheck נכשל — התיעוד עצמו תקף");
  }

  return {
    ok: true,
    message: "רשמתי שאתה מתחייב לסיים היום.",
    tracking: "לא אטריד אותך עד סוף היום — אם עדיין לא יסתיים, אחזור אז.",
  };
}

/** "אני עדיין עובד על זה" / עדכון התקדמות → הערה + איפוס שעון ה-staleness פעם אחת. */
export async function replyProgress(
  user: IdentifiedUser,
  c: LoopContext,
  note: string,
  deps: SimpleLoopReplyDeps = {},
): Promise<LoopResult> {
  const doUpdateTask = deps.updateTask ?? updateTask;
  const doRecordFindingEvent = deps.recordFindingEvent ?? recordFindingEvent;
  const doMarkNudgesSeenForFinding = deps.markNudgesSeenForFinding ?? markNudgesSeenForFinding;
  const doCompleteFollowupsForItem = deps.completeFollowupsForItem ?? completeFollowupsForItem;

  await doUpdateTask(user, { action: "note", source: src(c), itemId: c.itemId, note: `🔄 ${who(user)}: ${note}` });
  doRecordFindingEvent(c.findingKey, "employee_responded", { byUser: user.key, note });
  doMarkNudgesSeenForFinding(user.key, c.findingKey);
  completeFollowupBestEffort(doCompleteFollowupsForItem, c);
  return {
    ok: true,
    message: "רשמתי את העדכון על המשימה.",
    tracking: "אתן לך יום עבודה נוסף ואז אבדוק שוב. אם תסיים קודם — עדכן אותי.",
  };
}

/**
 * Side-effects הניתנים להזרקה עבור replyDefer — כדי שבדיקות יוכלו למקק/לספור קריאות בלי לגעת
 * ב-Monday האמיתי. ברירת המחדל (כשלא מוזרק כלום) היא תמיד הפונקציה האמיתית — התנהגות הפרודקשן
 * לא משתנה. ראה scripts/test-reply-defer.ts.
 */
export interface ReplyDeferDeps {
  setTaskDueDate?: typeof setTaskDueDate;
  updateTask?: typeof updateTask;
  addTaskNote?: typeof addTaskNote;
  recordFindingEvent?: typeof recordFindingEvent;
  addNotification?: typeof addNotification;
  markNudgesSeenForFinding?: typeof markNudgesSeenForFinding;
  createApproval?: typeof createApproval;
  scheduleCommitmentCheck?: typeof scheduleCommitmentCheck;
  completeFollowupsForItem?: typeof completeFollowupsForItem;
}

export type ReplyDeferResult =
  | { ok: true; status: "executed"; message: string; tracking: string }
  | { ok: true; status: "needs_clarification"; message: string; tracking: string; question: string }
  | { ok: true; status: "manager_approval_required"; message: string; tracking: string };

/**
 * "צריך עוד יומיים" / דחייה → **חייב לעבור קודם דרך ה-Policy Engine** (planDeferralReply).
 * שום כתיבה ל-Monday לא קורית לפני שהמדיניות אישרה (status === "executed").
 *
 *   • executed                  → כותב ל-Monday (תאריך, סטטוס best-effort, Update), מתעד snoozed,
 *                                   ורק *אחרי* שהכתיבה הקריטית (תאריך) הצליחה — מסמן nudge כ-seen.
 *   • needs_clarification       → שום כתיבה בכלל. מחזיר לעובד את שאלת ה-Policy Engine. ה-nudge
 *                                   *נשאר לא-seen* בכוונה כדי שהתשובה הבאה תמשיך להיות מקושרת
 *                                   לאותו finding (ui.html מצרף about כל עוד יש nudge לא-seen).
 *   • manager_approval_required → שום כתיבה ל-Monday/סטטוס/snooze. מתעד manager_approval_required
 *                                   + מודיע למוטי (awaiting_decision) עם payload מלא. ה-nudge גם
 *                                   כאן לא מסומן seen — הכדור עדיין לא נסגר מבחינת העובד.
 *
 * אם setTaskDueDate נכשל (executed בלבד): שום recordFindingEvent, שום markNudgesSeenForFinding,
 * שום "עדכנתי" לעובד — הפונקציה זורקת (עם הודעה ברורה), כמו כל שגיאת Monday אחרת במערכת הזו.
 */
export async function replyDefer(
  user: IdentifiedUser,
  c: LoopContext,
  newDateISO: string,
  reason?: string,
  reasonJudgedPlausible: boolean | null = null,
  deps: ReplyDeferDeps = {},
  /**
   * scope change (audit 2026-09-18/19): מידע לתיעוד/audit בלבד — לא משפיע על שום החלטה ב-
   * Policy Engine (ר' policy.ts). מגיע מ-chat.ts כפרמטר לקריאת ה-tool עצמה (לא מ-LoopContext,
   * בניגוד ל-missedCommitment — זה נקבע ע"י המודל לפי ההודעה הנוכחית, לא ע"י מנוע הבקרה מראש).
   * ממוקם *אחרי* deps בכוונה — כדי לא לשבור את שאר קריאות ה-replyDefer הקיימות (מבחנים/chat.ts)
   * שכבר מעבירות deps כפרמטר חמישי.
   */
  scopeChange = false,
): Promise<ReplyDeferResult> {
  const doSetTaskDueDate = deps.setTaskDueDate ?? setTaskDueDate;
  const doUpdateTask = deps.updateTask ?? updateTask;
  const doAddTaskNote = deps.addTaskNote ?? addTaskNote;
  const doRecordFindingEvent = deps.recordFindingEvent ?? recordFindingEvent;
  const doAddNotification = deps.addNotification ?? addNotification;
  const doMarkNudgesSeenForFinding = deps.markNudgesSeenForFinding ?? markNudgesSeenForFinding;
  const doCreateApproval = deps.createApproval ?? createApproval;
  const doScheduleCommitmentCheck = deps.scheduleCommitmentCheck ?? scheduleCommitmentCheck;
  const doCompleteFollowupsForItem = deps.completeFollowupsForItem ?? completeFollowupsForItem;

  const now = DateTime.now().setZone(env.TIMEZONE);
  const pretty = DateTime.fromISO(newDateISO, { zone: env.TIMEZONE }).toFormat("dd/MM");

  const plan = planDeferralReply(user, c, {
    now,
    currentDueDateISO: c.currentDueDateISO ?? null,
    requestedDueDateISO: newDateISO,
    reasonText: reason,
    reasonJudgedPlausible,
    missedCommitment: c.missedCommitment,
    scopeChange,
  });

  if (plan.status === "needs_clarification") {
    return {
      ok: true,
      status: "needs_clarification",
      message: plan.question,
      tracking: "עוד לא שיניתי כלום — תענה לי על זה ואמשיך משם.",
      question: plan.question,
    };
  }

  if (plan.status === "manager_approval_required") {
    const moti = resolveUserByKey("moti");
    if (!moti) {
      logger.error({ findingKey: c.findingKey }, "אין משתמש moti מוגדר — לא ניתן ליצור בקשת אישור");
      return {
        ok: true,
        status: "manager_approval_required",
        message: `הבקשה לדחות עד ${pretty} דורשת אישור של מוטי, אבל לא הצלחתי לאתר אותו במערכת — פנה אליו ישירות.`,
        tracking: "לא בוצע שום שינוי.",
      };
    }

    const priorDeferrals = (plan.approvalPayload.details as Record<string, unknown>).priorDeferrals as
      | { beforeOverdue: number; afterOverdue: number }
      | undefined;
    // Rule 4 (EOD Engine): מגיע מ-Policy Engine (plan), לא נגזר כאן מ-c/reason — כך שהאישור עצמו
    // נושא context מפורש שמבדיל "התחייבות שהוחמצה" מ-"משימה overdue רגילה" (audit request 2026-09-16).
    const missedCommitment = !!(plan.approvalPayload.details as Record<string, unknown>).missedCommitment;
    // scope change (audit 2026-09-18/19): אותו pattern בדיוק — מגיע דרך plan.approvalPayload.details
    // (מה ש-Policy Engine בפועל תיעד), לא ישירות מהפרמטר, כדי שמקור-האמת יהיה אחיד עם missedCommitment.
    const scopeChangeFlag = !!(plan.approvalPayload.details as Record<string, unknown>).scopeChange;

    // ה-payload הנשמר ב-Approval — persistent, לא רק notification (שורד ריסטרט שרת).
    const approvalPayload = {
      oldDueDate: c.currentDueDateISO ?? null,
      requestedNewDueDate: newDateISO,
      reason: reason ?? null,
      priorDeferrals,
      ruleId: plan.ruleId,
      wasOverdue: plan.wasOverdue,
      missedCommitment,
      scopeChange: scopeChangeFlag,
    };

    const createInput: CreateApprovalInput = {
      kind: "deferral",
      requestedBy: user.key,
      managerUserKey: moti.key,
      findingKey: c.findingKey,
      itemId: c.itemId,
      itemSource: c.source,
      taskName: c.taskName,
      payload: approvalPayload,
    };
    const { approval, created }: { approval: StoredApproval; created: boolean } = doCreateApproval(createInput);

    // "אם כבר קיימת בקשה זהה — אל תיצור כפילויות": לא כותבים finding_event/notification שוב.
    if (created) {
      doRecordFindingEvent(c.findingKey, "manager_approval_required", {
        byUser: user.key,
        action: plan.ruleId,
        note: reason,
        approvalId: approval.id,
      });

      const oldPretty = c.currentDueDateISO ? DateTime.fromISO(c.currentDueDateISO, { zone: env.TIMEZONE }).toFormat("dd/MM") : "?";
      const priorCount = priorDeferrals ? priorDeferrals.beforeOverdue + priorDeferrals.afterOverdue : 0;
      const body =
        `${who(user)} מבקש/ת לדחות את המשימה "${c.taskName ?? c.itemId}" מ-${oldPretty} ל-${pretty}.` +
        (reason ? `\nסיבה: ${reason}` : "") +
        `\nדחיות קודמות: ${priorCount}.` +
        (missedCommitment ? `\n⚠️ התחייבות "אסיים היום" שהוחמצה — המשימה עדיין הייתה פתוחה בסוף יום העבודה.` : "");

      const notifContext = {
        approvalId: approval.id,
        kind: "deferral" as const,
        requestedByName: who(user),
        taskName: c.taskName ?? c.itemId,
        oldDueDate: c.currentDueDateISO ?? null,
        requestedNewDueDate: newDateISO,
        reason: reason ?? null,
        priorDeferrals,
        ruleId: plan.ruleId,
        missedCommitment,
        scopeChange: scopeChangeFlag,
      };
      const notifId = doAddNotification(moti.key, "approval_request", body, c.findingKey, {
        itemId: c.itemId,
        itemSource: c.source,
        context: notifContext,
      });
      publishNotificationLive({
        userKey: moti.key,
        id: notifId,
        kind: "approval_request",
        body,
        findingKey: c.findingKey,
        itemId: c.itemId,
        itemSource: c.source,
        context: notifContext,
        createdAt: now.toISO()!,
      });
    }

    logger.info(
      { findingKey: c.findingKey, user: user.key, ruleId: plan.ruleId, approvalId: approval.id, created },
      "בקשת דחייה ממתינה לאישור מוטי (Policy Engine + Approval persistent) — לא בוצע שינוי ב-Monday",
    );
    // העובד כן נתן תשובה תקפה לפנייה (גם אם התוצאה עוברת למוטי) — ה-follow-up שיצר אותה מטופל.
    // המעקב הבא (commitment_check חדש) ייווצר כשמוטי יאשר — לא כאן.
    completeFollowupBestEffort(doCompleteFollowupsForItem, c);
    return {
      ok: true,
      status: "manager_approval_required",
      message: `הבקשה לדחות עד ${pretty} דורשת אישור של מוטי. העברתי אליו ולא שיניתי עדיין את התאריך.`,
      tracking: "לא אטריד אותך על זה עד שמוטי יחליט.",
    };
  }

  // plan.status === "executed" — ה-Policy Engine מאשר. רק עכשיו כותבים ל-Monday.
  try {
    await doSetTaskDueDate(src(c), c.itemId, newDateISO);
  } catch (err) {
    logger.error({ findingKey: c.findingKey, itemId: c.itemId, err }, "עדכון תאריך יעד ב-Monday נכשל — לא נרשם snooze, לא סומן seen");
    throw new Error(`עדכון תאריך היעד ב-Monday נכשל: ${err instanceof Error ? err.message : String(err)}`);
  }

  // best-effort — כמו היום: כישלון כאן לא מבטל את הדחייה שכבר נכתבה בהצלחה.
  await doUpdateTask(user, { action: "state", source: src(c), itemId: c.itemId, label: "בעבודה" }).catch(() => {});

  await doAddTaskNote(
    c.itemId,
    `📅 תאריך היעד נדחה ל-${pretty} לבקשת ${who(user)}${reason ? ` — ${reason}` : ""} (דרך פנייה יזומה של הבקרה, אושר ע"י Policy Engine: ${plan.ruleId})`,
  );
  doRecordFindingEvent(c.findingKey, "snoozed", {
    byUser: user.key,
    snoozeUntil: newDateISO,
    note: reason,
    itemId: c.itemId,
    itemSource: c.source,
    oldDueDate: c.currentDueDateISO ?? null,
    wasOverdue: plan.wasOverdue,
    // metadata בלבד (audit 2026-09-18/19) — לא משפיע על שום דבר, ר' docstring על הפרמטר למעלה.
    scopeChange,
  });
  doMarkNudgesSeenForFinding(user.key, c.findingKey);

  // Follow-up: לחזור ולבדוק בדיוק בתאריך ההתחייבות עצמו (בתוך יום העבודה), לא לחכות שיעבור.
  // best-effort — DB מקומי בלבד, לא Monday; כשל כאן לעולם לא מבטל דחייה שכבר נכתבה בהצלחה.
  try {
    doScheduleCommitmentCheck({
      itemId: c.itemId,
      itemSource: c.source,
      findingKey: c.findingKey,
      userKey: user.key,
      commitmentDateISO: newDateISO,
      taskName: c.taskName,
    });
  } catch (err) {
    logger.error({ findingKey: c.findingKey, err }, "scheduleCommitmentCheck נכשל אחרי דחייה מוצלחת — הדחייה עצמה תקפה");
  }

  return {
    ok: true,
    status: "executed",
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
  deps: SimpleLoopReplyDeps = {},
): Promise<LoopResult> {
  const doUpdateTask = deps.updateTask ?? updateTask;
  const doAddTaskNote = deps.addTaskNote ?? addTaskNote;
  const doRecordFindingEvent = deps.recordFindingEvent ?? recordFindingEvent;
  const doMarkNudgesSeenForFinding = deps.markNudgesSeenForFinding ?? markNudgesSeenForFinding;
  const doCompleteFollowupsForItem = deps.completeFollowupsForItem ?? completeFollowupsForItem;

  const label = waitingLabel(src(c), on);
  const onText = on === "client" ? "ללקוח" : on === "consultant" ? "ליועץ/ספק" : "לגורם חיצוני";
  await doUpdateTask(user, { action: "state", source: src(c), itemId: c.itemId, label });
  await doAddTaskNote(
    c.itemId,
    `⏳ ${who(user)}: ממתינים ${onText}${reason ? ` — ${reason}` : ""} (דרך פנייה יזומה של הבקרה)`,
  );
  doRecordFindingEvent(c.findingKey, "employee_responded", { byUser: user.key, action: `waiting_${on}`, note: reason });
  doMarkNudgesSeenForFinding(user.key, c.findingKey);
  completeFollowupBestEffort(doCompleteFollowupsForItem, c);
  return {
    ok: true,
    message: `עדכנתי סטטוס ל"${label}" ותיעדתי שממתינים ${onText}.`,
    tracking: "אמשיך לעקוב — אם זה נתקע יותר מדי זמן אחזור אליך.",
  };
}

/** "תקוע כי..." → סטטוס תקוע + הערת חסם + נשאר פתוח להסלמה. */
export async function replyBlocked(
  user: IdentifiedUser,
  c: LoopContext,
  blocker: string,
  deps: SimpleLoopReplyDeps = {},
): Promise<LoopResult> {
  const doUpdateTask = deps.updateTask ?? updateTask;
  const doRecordFindingEvent = deps.recordFindingEvent ?? recordFindingEvent;
  const doMarkNudgesSeenForFinding = deps.markNudgesSeenForFinding ?? markNudgesSeenForFinding;
  const doCompleteFollowupsForItem = deps.completeFollowupsForItem ?? completeFollowupsForItem;

  await doUpdateTask(user, { action: "blocker", source: src(c), itemId: c.itemId, note: blocker });
  doRecordFindingEvent(c.findingKey, "employee_responded", { byUser: user.key, action: "blocked", note: blocker });
  doMarkNudgesSeenForFinding(user.key, c.findingKey);
  completeFollowupBestEffort(doCompleteFollowupsForItem, c);
  return {
    ok: true,
    message: "סימנתי תקוע ותיעדתי את החסם.",
    tracking: "משימה תקועה עולה לתדריך של מוטי. אם לא תשוחרר — תוסלם.",
  };
}

/** "מחכה למנהל" → תיעוד על המשימה + התראה למוטי שהעובד ממתין להחלטתו (מסלול מיני, לא הסלמה רגילה). */
export async function replyAwaitManager(
  user: IdentifiedUser,
  c: LoopContext,
  question: string,
  deps: SimpleLoopReplyDeps = {},
): Promise<LoopResult> {
  const doAddTaskNote = deps.addTaskNote ?? addTaskNote;
  const doRecordFindingEvent = deps.recordFindingEvent ?? recordFindingEvent;
  const doAddNotification = deps.addNotification ?? addNotification;
  const doMarkNudgesSeenForFinding = deps.markNudgesSeenForFinding ?? markNudgesSeenForFinding;
  const doCompleteFollowupsForItem = deps.completeFollowupsForItem ?? completeFollowupsForItem;

  await doAddTaskNote(
    c.itemId,
    `🧑‍⚖️ ${who(user)} ממתין/ה להחלטת מנהל: ${question} (דרך פנייה יזומה של הבקרה)`,
  );
  doRecordFindingEvent(c.findingKey, "manager_pinged", { byUser: user.key, note: question });
  const moti = resolveUserByKey("moti");
  if (moti) {
    doAddNotification(
      moti.key,
      "awaiting_decision",
      `${who(user)} ממתין/ה להחלטה שלך על "${c.taskName ?? c.itemId}":\n${question}`,
      c.findingKey,
      { itemId: c.itemId, itemSource: c.source, context: { taskName: c.taskName, from: user.key } },
    );
  }
  doMarkNudgesSeenForFinding(user.key, c.findingKey);
  completeFollowupBestEffort(doCompleteFollowupsForItem, c);
  return {
    ok: true,
    message: "תיעדתי על המשימה ועדכנתי את מוטי שאתה ממתין להחלטה שלו.",
    tracking: "הכדור אצל מוטי עכשיו. לא אטריד אותך על זה עד שהוא יחזור אליך.",
  };
}

/**
 * "זה כבר לא רלוונטי" → לפי ה-Policy Engine (policy.ts, כלל 6): ביטול/אי-רלוונטיות תמיד דורש
 * אישור מוטי. הסוכן **לא** נוגע בסטטוס ב-Monday ו**לא** סוגר את הממצא לבד — רק מתעד את הבקשה
 * ומעביר להחלטת מוטי. (תיקון: קודם זה סגר את המשימה לבד — זה היה שגוי.)
 */
export async function replyNotRelevant(user: IdentifiedUser, c: LoopContext, reason?: string): Promise<LoopResult> {
  const ctx: ApprovalContext = { itemId: c.itemId, source: c.source, findingKey: c.findingKey, taskName: c.taskName, requestedBy: user.key };
  const decision = evaluateCancellationRequest(ctx, reason);
  // בכוונה: אין "if (decision.action === allow)" כאן — לפי המדיניות היום ביטול תמיד manager_approval_required.
  // אם policy.ts ישתנה בעתיד, ה-throw הבא ימנע מהקוד "ליפול" בשקט לביצוע לא-מכוסה.
  if (decision.action !== "manager_approval_required") {
    throw new Error(`מדיניות בלתי צפויה עבור ביטול/לא-רלוונטי: ${decision.action} (${decision.ruleId})`);
  }

  await addTaskNote(
    c.itemId,
    `❓ ${who(user)} מבקש/ת לסמן כלא רלוונטי${reason ? ` — ${reason}` : ""} (ממתין לאישור מוטי, דרך פנייה יזומה של הבקרה)`,
  );
  // לא resolved_by_reply (זה לא נסגר) ולא manager_pinged (זה לא "מחכה למנהל" הרגיל) —
  // manager_approval_required מסמן בדיוק את המצב: בקשה שעברה את ה-Policy Engine וממתינה להחלטה.
  recordFindingEvent(c.findingKey, "manager_approval_required", {
    byUser: user.key,
    action: decision.ruleId,
    note: reason,
    details: decision.approvalPayload,
  });
  const moti = resolveUserByKey("moti");
  if (moti) {
    addNotification(
      moti.key,
      "awaiting_decision",
      `${who(user)} מבקש/ת לסגור כ"לא רלוונטי" את "${c.taskName ?? c.itemId}"${reason ? `: ${reason}` : ""}. לאשר?`,
      c.findingKey,
      { itemId: c.itemId, itemSource: c.source, context: { taskName: c.taskName, from: user.key, reason, ruleId: decision.ruleId } },
    );
  }
  markNudgesSeenForFinding(user.key, c.findingKey);
  logger.info(
    { findingKey: c.findingKey, user: user.key, ruleId: decision.ruleId },
    "בקשת 'לא רלוונטי' ממתינה לאישור מוטי (Policy Engine) — לא בוצע שינוי ב-Monday",
  );
  return {
    ok: true,
    message: "רשמתי את הבקשה שלך והעברתי להחלטת מוטי — לא סגרתי את המשימה לבד.",
    tracking: "לא אטריד אותך על זה עד שמוטי יחליט.",
  };
}
