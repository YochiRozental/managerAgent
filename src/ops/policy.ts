/**
 * Policy Engine — מי מחליט מה מותר לסוכן לבצע לבד, מתי צריך לברר עוד, ומתי חובה אישור מוטי.
 *
 * עקרון: ה-AI (בצ'אט) מפרש מה העובד אמר — כוונה, תאריך מבוקש, האם הסיבה שנתן (אם נתן) נשמעת
 * הגיונית. **ההחלטה עצמה — מותר/לברר/לאישור — עוברת תמיד דרך הקוד כאן, לא נשארת בפרומפט.**
 * כל פונקציית evaluate* טהורה לגמרי — בלי Monday, בלי DB, בלי AI, בלי import של אף אחד מהם —
 * וניתנת לבדיקה ישירה. npm run test:policy.
 *
 * היסטוריית דחיות (כדי לספור "כמה פעמים כבר נדחתה המשימה הזו") **לא** נטענת כאן — זה קורא ל-DB,
 * וזה שובר את הטוהר. הטעינה גרה ב-db/repositories/deferralHistory.ts, ומוזרקת לכאן כמערך
 * DeferralRecord[] מוכן. ראה שם למה המפתח הוא itemId+itemSource ולא finding_key.
 *
 * שימוש היום (2026-09-14, חיבור בפועל):
 *   • evaluateCancellationRequest — מחובר, דרך loopReply.replyNotRelevant.
 *   • evaluateDeferralRequest — מחובר, דרך src/ops/deferralPlan.ts (planDeferralReply) ←
 *     loopReply.replyDefer. replyDefer **חייב** לעבור דרך planDeferralReply לפני כל כתיבה
 *     ל-Monday — ראה deferralPlan.ts ו-loopReply.ts לפרטי הזרימה המלאה (executed /
 *     needs_clarification / manager_approval_required).
 *   • evaluateReassignmentRequest — קיימת ונבדקת, עדיין לא מחוברת (reassignItem לא עבר עדיין).
 */

import { DateTime } from "luxon";
import type { OpsTaskSource } from "../integrations/monday/opsRead.js";

// ─────────────────────────────────────────────────────────────────────────────
// Config — הספים. לשנות כאן, לא בקוד ההחלטה.
// ─────────────────────────────────────────────────────────────────────────────

export const POLICY_CONFIG = {
  /** דחייה שמבוקשת אחרי שהמשימה כבר באיחור. */
  afterOverdue: {
    /** מותר אוטומטית אם התאריך החדש עד כה ימים קדימה מהיום. */
    autoApproveWithinDays: 3,
    /** ומעל זה — עד כה ימים, ורק עם סיבה שה-AI העריך כהגיונית. מעל זה: תמיד אישור מוטי. */
    withReasonUpToDays: 7,
    /** כמה "התחייבויות חדשות" (דחיות) מותר לעובד לבקש אחרי שהמשימה נכנסה לאיחור, לפני
     *  שכל דחייה נוספת — לא משנה כמה קטנה — דורשת אישור מוטי (כי הוא כבר פספס את הקודמת). */
    newCommitmentsAllowed: 1,
  },
  /** דחייה שמבוקשת לפני שתאריך היעד עבר (המשימה עדיין לא באיחור). */
  beforeDue: {
    /** כמה דחיות-מראש מותרות בלי אישור; הבאה אחריהן דורשת אישור מוטי. */
    autoApproveCount: 2,
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// טיפוסים
// ─────────────────────────────────────────────────────────────────────────────

export type PolicyAction = "allow" | "needs_clarification" | "manager_approval_required";

export interface ApprovalContext {
  itemId: string;
  source: OpsTaskSource;
  findingKey: string;
  taskName?: string;
  /** מפתח המשתמש שביקש את הפעולה */
  requestedBy: string;
}

/** כל מה שצריך כדי להמשיך טיפול בבקשה שהועברה למוטי, בלי לחזור ולשאול את העובד מההתחלה. */
export interface ManagerApprovalPayload extends ApprovalContext {
  kind: "deferral" | "cancellation" | "reassignment";
  details: Record<string, unknown>;
}

export interface PolicyDecision {
  action: PolicyAction;
  /** מזהה הכלל שקבע את ההחלטה — ללוגים ולבדיקות, לא לתצוגה */
  ruleId: string;
  /** הסבר בעברית — אפשר להראות לעובד/למוטי כמו שהוא */
  reasonHe: string;
  /** רק כש-action === "needs_clarification" */
  question?: string;
  /** רק כש-action === "manager_approval_required" */
  approvalPayload?: ManagerApprovalPayload;
  /** רק מ-evaluateDeferralRequest: האם הבקשה הייתה לפני או אחרי שהדדליין עבר. */
  wasOverdue?: boolean;
}

function approval(kind: ManagerApprovalPayload["kind"], ctx: ApprovalContext, details: Record<string, unknown>): ManagerApprovalPayload {
  return { kind, ...ctx, details };
}

// ─────────────────────────────────────────────────────────────────────────────
// היסטוריית דחיות — "דרך ברורה לספור דחיות קודמות של אותה משימה"
// ─────────────────────────────────────────────────────────────────────────────

export interface DeferralRecord {
  /** מתי בוצעה הבקשה (ISO) — לא נמחק לעולם, גם כשהתאריך משתנה שוב */
  requestedAt: string;
  /** האם המשימה כבר הייתה באיחור כשהבקשה הזו נעשתה */
  wasOverdue: boolean;
  /** התאריך החדש שהתבקש, YYYY-MM-DD */
  newDueDate: string;
}

export interface DeferralCounts {
  /** דחיות שביקש העובד לפני שתאריך היעד עבר */
  beforeOverdue: number;
  /** דחיות שביקש העובד אחרי שהמשימה כבר הייתה באיחור */
  afterOverdue: number;
}

/** סופר דחיות קודמות של אותה משימה, מפוצל לפי "לפני/אחרי איחור". פונקציה טהורה — קלה לבדיקה. */
export function countDeferrals(history: readonly DeferralRecord[]): DeferralCounts {
  let beforeOverdue = 0;
  let afterOverdue = 0;
  for (const d of history) {
    if (d.wasOverdue) afterOverdue++;
    else beforeOverdue++;
  }
  return { beforeOverdue, afterOverdue };
}

/** הפרש בימים קלנדריים בין שני תאריכי YYYY-MM-DD — בלי תלות באזור זמן (ראה תקרית businessDaysBetween). */
function daysBetweenDates(fromISODate: string, toISODate: string): number {
  const a = DateTime.fromISO(fromISODate, { zone: "utc" });
  const b = DateTime.fromISO(toISODate, { zone: "utc" });
  return Math.round(b.diff(a, "days").days);
}

// ─────────────────────────────────────────────────────────────────────────────
// כלל 2+3+4 — דחייה (אחרי איחור ולפני איחור)
// ─────────────────────────────────────────────────────────────────────────────

export interface DeferralRequestInput {
  ctx: ApprovalContext;
  /** "עכשיו", לפי אזור הזמן של המשרד — רק לחישוב תאריך היום */
  now: DateTime;
  /** תאריך היעד הנוכחי של המשימה, YYYY-MM-DD, או null אם אין */
  currentDueDate: string | null;
  /** התאריך החדש שהעובד ביקש, YYYY-MM-DD */
  requestedNewDueDate: string;
  /** דחיות קודמות של אותה משימה (לא כולל הבקשה הנוכחית) */
  history: readonly DeferralRecord[];
  /** טקסט הסיבה כפי שהעובד ניסח אותה, אם ניסח — לתיעוד/payload בלבד, לא משפיע על ההחלטה. */
  reasonText?: string;
  /**
   * שיפוט ה-AI על הסיבה — הערך היחיד שמשפיע על ההחלטה בענף "צריך סיבה":
   *   true  — העובד הסביר משהו קונקרטי שבאמת מצדיק את הזמן הנוסף.
   *   false — העובד נתן "סיבה", אבל היא לא נשמעת כמו הצדקה אמיתית (למשל "ככה", "סתם").
   *   null  — העובד לא נתן שום הסבר, או שהוא כללי/סתמי מדי כדי לשפוט לפיו בכלל.
   * ה-AI מפרש; הקוד כאן מחליט מה לעשות עם השיפוט.
   */
  reasonJudgedPlausible: boolean | null;
  /**
   * דגל מפורש (2026-09-16, Rule 4 — "אסיים היום" שהוחמצה) — **לא** נגזר מ-wasOverdue/תאריכים
   * ולא מהטקסט החופשי של העובד. חייב להגיע אמין מה-EOD/Follow-up flow: true רק כאשר (1) היה
   * end_of_day_check על הפריט, (2) המשימה עדיין הייתה פתוחה כשה-nudge נשלח, (3) העובד התבקש
   * לעדכן ב-EOD. שונה במפורש מ-"המשימה טכנית overdue" — יכול להיות true גם כש-currentDueDate
   * הוא היום עצמו (date-only math לא הופך אותו ל-wasOverdue). ר' followups.ts/loopReply.ts.
   */
  missedCommitment?: boolean;
  /**
   * scope change (audit 2026-09-18/19): metadata לתיעוד/audit בלבד — **לא** משתתף בשום החלטה
   * כאן (בדיוק כמו reasonText). מגיע מ-chat.ts (המודל זיהה שהסיבה היא שינוי היקף), לא מנוחש כאן.
   * כלל 8 עדיין לא צריך נתיב החלטה נפרד — רק דגל שעובר דרך details/payload לצפייה מאוחרת.
   */
  scopeChange?: boolean;
}

/**
 * כלל 1 ("משימה באיחור לעולם לא מתעלמים ממנה") מתבטא כאן בכך שאין נתיב שמדלג על ההערכה —
 * כל בקשת דחייה, קטנה כגדולה, עוברת את הפונקציה הזו ומקבלת ruleId מתועד.
 * כלל 8 (שינוי היקף) לא משנה שום ענף כאן: scopeChange (כמו reasonText) הוא metadata שמועבר
 * ל-details בלבד — אותם כללי אישור בדיוק (2 דחיות לפני יעד, ספי ימים אחרי איחור וכו') חלים גם עליו.
 */
export function evaluateDeferralRequest(input: DeferralRequestInput): PolicyDecision {
  const { ctx, now, currentDueDate, requestedNewDueDate, history, reasonText, reasonJudgedPlausible, missedCommitment, scopeChange } = input;
  const today = now.toISODate()!;
  const wasOverdue = !!currentDueDate && daysBetweenDates(currentDueDate, today) > 0;
  const daysAhead = daysBetweenDates(today, requestedNewDueDate);
  // מחושב פעם אחת, מוצג תמיד ב-details — "מספר הדחיות הקודמות" חייב להופיע בכל payload לאישור מוטי.
  const priorDeferrals = countDeferrals(history);

  const details = { currentDueDate, requestedNewDueDate, daysAhead, wasOverdue, reasonText, reasonJudgedPlausible, priorDeferrals, missedCommitment: !!missedCommitment, scopeChange: !!scopeChange };

  // Rule 4 (EOD Engine, 2026-09-16): התחייבות "אסיים היום" שהוחמצה דורשת אישור מוטי תמיד —
  // גם אם date-only math לא רואה את זה כ-overdue (currentDueDate=היום). לפני wasOverdue בכוונה:
  // זה context מפורש ונפרד, לא תת-מקרה של הכלל הרגיל, ולא משנה את wasOverdue/beforeDue/afterOverdue
  // עבור שום בקשה אחרת (ברירת המחדל היא false/undefined — התנהגות קיימת לא זזה).
  if (missedCommitment) {
    return {
      action: "manager_approval_required",
      ruleId: "eod-commitment-missed",
      reasonHe: "העובד התחייב לסיים את המשימה היום, הגיע סוף יום העבודה והמשימה עדיין פתוחה — זו התחייבות שהוחמצה (גם אם תאריך היעד עצמו הוא היום) — דורש אישור מוטי.",
      approvalPayload: approval("deferral", ctx, details),
      wasOverdue,
    };
  }

  if (wasOverdue) {
    // כלל 3: "התחייבות חדשה" אחת מותרת אחרי איחור. אם כבר נוצלה ולא עמדו בה — כל דחייה נוספת
    // דורשת אישור מוטי, בלי קשר לכמה ימים מבוקשים הפעם.
    if (priorDeferrals.afterOverdue >= POLICY_CONFIG.afterOverdue.newCommitmentsAllowed) {
      return {
        action: "manager_approval_required",
        ruleId: "after-overdue-commitment-missed",
        reasonHe: `העובד כבר קיבל ${priorDeferrals.afterOverdue} דחיה/ות אחרי שהמשימה נכנסה לאיחור ולא עמד בהן — כל דחייה נוספת דורשת אישור מוטי.`,
        approvalPayload: approval("deferral", ctx, details),
        wasOverdue,
      };
    }

    // כלל 2, שורה 1: עד 3 ימים קדימה — מותר.
    if (daysAhead <= POLICY_CONFIG.afterOverdue.autoApproveWithinDays) {
      return {
        action: "allow",
        ruleId: "after-overdue-short",
        reasonHe: `דחייה של ${daysAhead} ימים אחרי איחור — בתוך הסף (${POLICY_CONFIG.afterOverdue.autoApproveWithinDays} ימים), אין צורך באישור.`,
        wasOverdue,
      };
    }

    // כלל 2, שורה 4: מעל 7 ימים — תקרה מוחלטת, גם אם יש סיבה.
    if (daysAhead > POLICY_CONFIG.afterOverdue.withReasonUpToDays) {
      return {
        action: "manager_approval_required",
        ruleId: "after-overdue-long",
        reasonHe: `דחייה של ${daysAhead} ימים אחרי איחור — מעל ${POLICY_CONFIG.afterOverdue.withReasonUpToDays} ימים, דורש אישור מוטי בכל מקרה.`,
        approvalPayload: approval("deferral", ctx, details),
        wasOverdue,
      };
    }

    // 3 < daysAhead <= 7: צריך סיבה הגיונית. null = לא ניתן הסבר שאפשר לשפוט → לברר.
    if (reasonJudgedPlausible === null) {
      const pretty = DateTime.fromISO(requestedNewDueDate, { zone: "utc" }).toFormat("dd/MM");
      return {
        action: "needs_clarification",
        ruleId: "after-overdue-needs-reason",
        reasonHe: `דחייה של ${daysAhead} ימים אחרי איחור — מעל ${POLICY_CONFIG.afterOverdue.autoApproveWithinDays} ימים, צריך סיבה לפני שאפשר לאשר.`,
        question: `אתה מבקש לדחות עד ${pretty} — זה ${daysAhead} ימים. מה הסיבה שנדרשים עוד כל כך הרבה זמן?`,
        wasOverdue,
      };
    }
    if (reasonJudgedPlausible) {
      return {
        action: "allow",
        ruleId: "after-overdue-reason-plausible",
        reasonHe: `דחייה של ${daysAhead} ימים עם סיבה הגיונית — בתוך הסף (${POLICY_CONFIG.afterOverdue.withReasonUpToDays} ימים), מאושר.`,
        wasOverdue,
      };
    }
    return {
      action: "manager_approval_required",
      ruleId: "after-overdue-reason-not-plausible",
      reasonHe: "ניתנה סיבה לדחייה, אבל היא לא נראתה מספיק משכנעת לדחייה של מעל 3 ימים — דורש אישור מוטי.",
      approvalPayload: approval("deferral", ctx, details),
      wasOverdue,
    };
  }

  // כלל 4: המשימה עדיין לא באיחור — דחייה מראש.
  if (priorDeferrals.beforeOverdue < POLICY_CONFIG.beforeDue.autoApproveCount) {
    return {
      action: "allow",
      ruleId: "before-due-ok",
      reasonHe: `דחייה מספר ${priorDeferrals.beforeOverdue + 1} לפני שתאריך היעד עבר — בתוך הסף (${POLICY_CONFIG.beforeDue.autoApproveCount}), מותר.`,
      wasOverdue,
    };
  }
  return {
    action: "manager_approval_required",
    ruleId: "before-due-too-many",
    reasonHe: `זו הדחייה ה-${priorDeferrals.beforeOverdue + 1} לפני שתאריך היעד עבר — מעל הסף (${POLICY_CONFIG.beforeDue.autoApproveCount}), דורש אישור מוטי.`,
    approvalPayload: approval("deferral", ctx, details),
    wasOverdue,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// כלל 5 — "בוצע"
// ─────────────────────────────────────────────────────────────────────────────

/** דיווח סיום — תמיד מותר לסוכן לסגור לבד. אין תלות בהיסטוריה. */
export function evaluateCompletionRequest(): PolicyDecision {
  return { action: "allow", ruleId: "completion-always-allowed", reasonHe: "דיווח סיום משימה — מותר לסגור ב-Monday ללא אישור נוסף." };
}

// ─────────────────────────────────────────────────────────────────────────────
// כלל 6 — "לא רלוונטי / בוטל"
// ─────────────────────────────────────────────────────────────────────────────

/** ביטול/אי-רלוונטיות — תמיד דורש אישור מוטי. הסוכן לא סוגר ולא מבטל לבד. */
export function evaluateCancellationRequest(ctx: ApprovalContext, reason?: string): PolicyDecision {
  return {
    action: "manager_approval_required",
    ruleId: "cancellation-requires-approval",
    reasonHe: "העובד מדווח שהמשימה לא רלוונטית/בוטלה — ביטול תמיד דורש אישור מוטי, לא נסגר לבד.",
    approvalPayload: approval("cancellation", ctx, { reason }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// כלל 7 — "זו משימה של מישהו אחר"
// ─────────────────────────────────────────────────────────────────────────────

/** בקשת שינוי אחראי דרך תשובה לפנייה — תמיד דורש אישור מוטי. */
export function evaluateReassignmentRequest(ctx: ApprovalContext, claimedOwner?: string): PolicyDecision {
  return {
    action: "manager_approval_required",
    ruleId: "reassignment-requires-approval",
    reasonHe: "העובד טוען שהמשימה שייכת למישהו אחר — שינוי אחראי תמיד דורש אישור מוטי, לא משתנה לבד.",
    approvalPayload: approval("reassignment", ctx, { claimedOwner }),
  };
}
