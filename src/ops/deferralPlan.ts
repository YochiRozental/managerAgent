/**
 * שכבת "תכנון" לתשובת דחייה — הגשר בין קלט ה-AI (מהצ'אט) ל-Policy Engine הטהור (policy.ts).
 *
 * במכוון: הקובץ הזה לא מייבא שום דבר שכותב ל-Monday (opsWrite.ts / actions.ts) ולא שום דבר
 * שכותב ל-DB (recordFindingEvent / addNotification וכו') — רק קורא היסטוריה (read-only) ומחזיר
 * החלטה. כך אפשר להוכיח בבדיקה, ולא רק להבטיח בתיעוד, ש-planDeferralReply לעולם לא יכול לגעת
 * ב-Monday ולא יכול לסמן snooze בפועל — ראה scripts/test-deferral-plan.ts.
 *
 * **מחובר בפועל (2026-09-14):** loopReply.replyDefer קורא לכאן קודם לכל דבר, ורק אם התוצאה
 * "executed" הוא ממשיך לכתוב ל-Monday בעצמו (setTaskDueDate/addTaskNote/recordFindingEvent —
 * כל אחד מהם דרך dependency injection, כדי שאפשר לבדוק בלי Monday אמיתי). ה"אין import" כאן
 * למעלה נשאר נכון ומכוון גם עכשיו — זו בדיוק הערובה שגם אחרי החיבור, הכתיבה בפועל קורית רק
 * ב-loopReply.ts, לא כאן. ראה scripts/test-reply-defer.ts לבדיקות ה-integration המלאות.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { loadDeferralHistoryForItem } from "../db/repositories/deferralHistory.js";
import type { IdentifiedUser } from "../identity/index.js";
import type { LoopContext } from "./loopReply.js";
import { evaluateDeferralRequest, type ApprovalContext, type ManagerApprovalPayload } from "./policy.js";

export interface DeferralReplyInput {
  /** "עכשיו", לפי אזור הזמן של המשרד */
  now: DateTime;
  /** תאריך היעד הנוכחי של המשימה ב-Monday, YYYY-MM-DD, או null אם אין */
  currentDueDateISO: string | null;
  /** התאריך החדש שהעובד ביקש, YYYY-MM-DD */
  requestedDueDateISO: string;
  /** הסיבה כפי שהעובד ניסח אותה, אם ניסח — לתיעוד בלבד */
  reasonText?: string;
  /** שיפוט ה-AI על הסיבה: true=הגיונית, false=לא מצדיקה, null=לא ניתן הסבר לשפוט לפיו */
  reasonJudgedPlausible: boolean | null;
  /** ר' policy.ts — מגיע מ-c.missedCommitment (LoopContext), לא מנוחש כאן. */
  missedCommitment?: boolean;
}

export type DeferralReplyPlan =
  | {
      status: "executed";
      ruleId: string;
      newDueDateISO: string;
      /** האם הבקשה הייתה לפני או אחרי שהדדליין עבר — מגיע ישירות מ-Policy Engine, לא מחושב שוב. */
      wasOverdue: boolean;
      message: string;
      tracking: string;
    }
  | {
      status: "needs_clarification";
      ruleId: string;
      wasOverdue: boolean;
      question: string;
    }
  | {
      status: "manager_approval_required";
      ruleId: string;
      wasOverdue: boolean;
      message: string;
      approvalPayload: ManagerApprovalPayload;
    };

/**
 * מחליט מה מותר לעשות עם בקשת דחייה — **לא מבצע כלום בפועל**: לא Monday, לא finding_events,
 * לא notification למוטי. "executed" כאן פירושו "המדיניות מאשרת את זה" — לא "בוצע בפועל ב-Monday".
 * החיבור בפועל (setTaskDueDate + recordFindingEvent + addNotification, כמו ש-replyDefer/
 * replyNotRelevant כבר עושים היום) הוא השלב הבא, אחרי בדיקות end-to-end.
 */
export function planDeferralReply(
  user: IdentifiedUser,
  c: LoopContext,
  input: DeferralReplyInput,
): DeferralReplyPlan {
  const history = loadDeferralHistoryForItem(c.itemId, c.source);
  const ctx: ApprovalContext = {
    itemId: c.itemId,
    source: c.source,
    findingKey: c.findingKey,
    taskName: c.taskName,
    requestedBy: user.key,
  };
  const decision = evaluateDeferralRequest({
    ctx,
    now: input.now,
    currentDueDate: input.currentDueDateISO,
    requestedNewDueDate: input.requestedDueDateISO,
    history,
    reasonText: input.reasonText,
    reasonJudgedPlausible: input.reasonJudgedPlausible,
    missedCommitment: input.missedCommitment,
  });

  const wasOverdue = !!decision.wasOverdue;

  if (decision.action === "allow") {
    const pretty = DateTime.fromISO(input.requestedDueDateISO, { zone: env.TIMEZONE }).toFormat("dd/MM");
    return {
      status: "executed",
      ruleId: decision.ruleId,
      newDueDateISO: input.requestedDueDateISO,
      wasOverdue,
      message: `המדיניות מאשרת לעדכן את תאריך היעד ל-${pretty}.`,
      tracking: decision.reasonHe,
    };
  }
  if (decision.action === "needs_clarification") {
    return { status: "needs_clarification", ruleId: decision.ruleId, wasOverdue, question: decision.question! };
  }
  return {
    status: "manager_approval_required",
    ruleId: decision.ruleId,
    wasOverdue,
    message: decision.reasonHe,
    approvalPayload: decision.approvalPayload!,
  };
}
