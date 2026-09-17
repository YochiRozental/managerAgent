/**
 * הכרעת מוטי על בקשת אישור (Approval) — השלב השני של הלולאה: הצד הראשון (יצירת ה-Approval)
 * הוא ב-loopReply.replyDefer, כש-Policy Engine מחזיר manager_approval_required.
 *
 * גנרי לפי kind (deferral/cancellation/reassignment) דרך KIND_EXECUTORS — ראה למטה. **deferral
 * ו-cancellation רשומים בפועל (audit 2026-09-17/20)** — reassignment עדיין לא (evaluateReassignmentRequest
 * קיים ב-policy.ts אבל reassignItem לא עובר דרכו כלל, ר' audit). kind לא-רשום → unsupported_kind בלי לגעת בכלום.
 *
 * idempotency + סדר פעולות (Audit 2026-09-14):
 *   claim (CAS) → executor.applyToMonday (הפעולה הקריטית היחידה שחייבת להצליח, פעם אחת) →
 *   finalizeApproved (המצב הופך ל-"approved" סופית **מיד** אחרי ההצלחה, לפני כל דבר אחר) →
 *   executor.recordApproved (best-effort: finding_events/nudge) → התראה לעובד (best-effort).
 * למה בסדר הזה: ברגע ש-applyToMonday הצליח, אסור בשום מצב שניסיון חוזר/refresh ינסה לבצע אותה
 * שוב — ולכן finalizeApproved קורה *לפני* כל שלב best-effort, לא אחריו. אם finding_event/notification
 * נכשלים אחרי זה — זה מתועד בלוג, לא הופך את האישור לכישלון ולא מוחזר כשגיאה למוטי.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { addNotification } from "../db/repositories/notifications.js";
import { recordFindingEvent } from "../db/repositories/findingEvents.js";
import { addApprovalMessage, listApprovalMessages, type StoredApprovalMessage } from "../db/repositories/approvalMessages.js";
import {
  claimApproval,
  finalizeApproved,
  getApproval,
  markInstruction,
  markRejected,
  returnToPendingAfterReply,
  revertAfterFailure,
  type ApprovalKind,
  type StoredApproval,
} from "../db/repositories/managerApprovals.js";
import { markNudgesSeenForFinding } from "../db/repositories/notifications.js";
import { resolveUserByKey, userCan, type IdentifiedUser } from "../identity/index.js";
import type { OpsTaskSource } from "../integrations/monday/opsRead.js";
import { addTaskNote, setTaskDueDate, PARKED_LABEL } from "../integrations/monday/opsWrite.js";
import { updateTask } from "./actions.js";
import { scheduleCommitmentCheck } from "./followups.js";
import { publishNotificationLive } from "./notificationBus.js";
import { logger } from "../utils/logger.js";

export interface ApprovalDecisionDeps {
  setTaskDueDate?: typeof setTaskDueDate;
  updateTask?: typeof updateTask;
  addTaskNote?: typeof addTaskNote;
  recordFindingEvent?: typeof recordFindingEvent;
  addNotification?: typeof addNotification;
  markNudgesSeenForFinding?: typeof markNudgesSeenForFinding;
  scheduleCommitmentCheck?: typeof scheduleCommitmentCheck;
}

export type ApprovalActionErrorCode =
  | "not_found"
  | "forbidden"
  | "self_approval"
  | "already_decided"
  | "unsupported_kind"
  | "execution_failed"
  | "bad_request"
  /** תשובת עובד הגיעה כשה-Approval לא היה pending_instruction (למשל: כבר חזר ל-pending, או שאף
   *  אחד לא שאל שאלה מלכתחילה) — לא נשמרת כתשובה "רשמית". */
  | "not_awaiting_reply";

export type ApprovalActionResult =
  | { ok: true; approval: StoredApproval }
  | { ok: false; code: ApprovalActionErrorCode; message: string; approval?: StoredApproval };

export interface ApprovalWithMessages extends StoredApproval {
  messages: StoredApprovalMessage[];
}

interface DeferralApprovalPayload {
  oldDueDate: string | null;
  requestedNewDueDate: string;
  reason: string | null;
  priorDeferrals?: unknown;
  ruleId: string;
  wasOverdue: boolean;
  /** scope change (audit 2026-09-18/19): metadata לתיעוד בלבד, מועבר הלאה ל-snoozed. ר' policy.ts. */
  scopeChange?: boolean;
}

/** payload של בקשת ביטול/"לא רלוונטי" — בונה אותו evaluateCancellationRequest (policy.ts, כלל 6). */
interface CancellationApprovalPayload {
  reason: string | null;
  ruleId: string;
}

function pretty(dateISO: string): string {
  return DateTime.fromISO(dateISO, { zone: env.TIMEZONE }).toFormat("dd/MM");
}

// ─────────────────────────────────────────────────────────────────────────────
// Executor per kind — כל מה שספציפי לסוג הבקשה, מבודד מהשלד הגנרי ב-approveApproval.
// להוסיף cancellation/reassignment בעתיד = לכתוב אובייקט כזה ולרשום אותו ב-KIND_EXECUTORS,
// בלי לגעת ב-approveApproval/guard/claim/finalize כלל.
// ─────────────────────────────────────────────────────────────────────────────

interface ExecutorDeps {
  setTaskDueDate: typeof setTaskDueDate;
  updateTask: typeof updateTask;
  addTaskNote: typeof addTaskNote;
  recordFindingEvent: typeof recordFindingEvent;
  markNudgesSeenForFinding: typeof markNudgesSeenForFinding;
  scheduleCommitmentCheck: typeof scheduleCommitmentCheck;
}

interface KindExecutor {
  /**
   * הפעולה הקריטית ב-Monday — היחידה שאסור לבצע פעמיים. זורקת = הכל חוזר ל-pending (revert).
   * שינויים "נלווים" (סטטוס/הערה) מטופלים כאן פנימה אבל תמיד try/catch משלהם — כשלון בהם
   * לא הופך את הפעולה הקריטית ל"נכשלה" (היא כבר הצליחה).
   */
  applyToMonday(approval: StoredApproval, manager: IdentifiedUser, note: string | null, deps: ExecutorDeps): Promise<void>;
  /** best-effort, רץ *אחרי* שה-Approval כבר סומן approved. אסור שתיכשל תבטל את זה. */
  recordApproved(approval: StoredApproval, manager: IdentifiedUser, note: string | null, deps: ExecutorDeps): void;
  /** מה להגיד לעובד שביקש, אחרי אישור בפועל. */
  employeeApprovedMessage(approval: StoredApproval): string;
  /** מה להגיד לעובד שביקש, אחרי דחייה (audit 2026-09-17/20) — kind-specific כמו employeeApprovedMessage,
   *  כי הטקסט הישן היה קשיח לדחייה (מניח oldDueDate) ולא התאים ל-kind אחר. */
  employeeRejectedMessage(approval: StoredApproval, note: string | null): string;
}

const deferralExecutor: KindExecutor = {
  async applyToMonday(approval, manager, note, deps) {
    if (!approval.itemId || !approval.itemSource) throw new Error("לבקשת האישור חסר itemId/itemSource.");
    const payload = approval.payload as unknown as DeferralApprovalPayload;

    // הקריטי היחיד: שינוי תאריך היעד בפועל. זורק ומחוץ ל-try/catch פנימי — צריך לשבור out.
    await deps.setTaskDueDate(approval.itemSource as OpsTaskSource, approval.itemId, payload.requestedNewDueDate);

    // כל השאר כאן — נלווה, best-effort. לא זורקים מ-applyToMonday בגלל כשלון פה: התאריך כבר
    // השתנה בפועל, ואסור שניסיון חוזר יריץ setTaskDueDate שוב.
    try {
      await deps.addTaskNote(
        approval.itemId,
        `📅 הדחייה ל-${pretty(payload.requestedNewDueDate)} אושרה ע"י מוטי${note ? ` — ${note}` : ""} (בקשה מקורית: ${approval.requestedBy})`,
      );
    } catch (err) {
      logger.error({ approvalId: approval.id, err }, "approve(deferral): addTaskNote נכשל אחרי setTaskDueDate — האישור עדיין תקף");
    }
    try {
      await deps.updateTask(manager, {
        action: "state",
        source: approval.itemSource as OpsTaskSource,
        itemId: approval.itemId,
        label: "בעבודה",
      });
    } catch {
      /* best-effort — כמו בכל מקום אחר במערכת הזו */
    }
  },

  recordApproved(approval, manager, note, deps) {
    if (!approval.findingKey) return;
    const payload = approval.payload as unknown as DeferralApprovalPayload;
    deps.recordFindingEvent(approval.findingKey, "manager_approval_approved", {
      byUser: manager.key,
      note: note ?? undefined,
      approvalId: approval.id,
    });
    // "אירוע ברור שממנו מנוע הבקרה יודע לא להסלים עד המועד החדש" — snooze אמיתי, אותו מנגנון
    // שהבקרה כבר מכירה מ-replyDefer (escalationDecision קורא snoozedUntil()).
    deps.recordFindingEvent(approval.findingKey, "snoozed", {
      byUser: manager.key,
      snoozeUntil: payload.requestedNewDueDate,
      note: `אושר ע"י מוטי${note ? `: ${note}` : ""}`,
      itemId: approval.itemId ?? undefined,
      itemSource: approval.itemSource ?? undefined,
      oldDueDate: payload.oldDueDate,
      wasOverdue: payload.wasOverdue,
      scopeChange: payload.scopeChange,
    });
    deps.markNudgesSeenForFinding(approval.requestedBy, approval.findingKey);

    // Follow-up: לחזור ולבדוק בדיוק בתאריך ההתחייבות עצמו — אותו מנגנון כמו ב-replyDefer.
    // best-effort (DB מקומי): כשל כאן לא הופך את האישור שכבר בוצע ל"נכשל".
    if (approval.itemId && approval.itemSource) {
      try {
        deps.scheduleCommitmentCheck({
          itemId: approval.itemId,
          itemSource: approval.itemSource as OpsTaskSource,
          findingKey: approval.findingKey,
          userKey: approval.requestedBy,
          commitmentDateISO: payload.requestedNewDueDate,
          taskName: approval.taskName ?? undefined,
        });
      } catch (err) {
        logger.error({ approvalId: approval.id, err }, "approve(deferral): scheduleCommitmentCheck נכשל — האישור עצמו נשאר approved");
      }
    }
  },

  employeeApprovedMessage(approval) {
    const payload = approval.payload as unknown as DeferralApprovalPayload;
    return `מוטי אישר לדחות את המשימה עד ${pretty(payload.requestedNewDueDate)}. עדכנתי את Monday ואמשיך לעקוב עד אז.`;
  },

  employeeRejectedMessage(approval, note) {
    // טקסט מקורי, הועבר כמו-שהוא לכאן (audit 2026-09-17/20) — התנהגות deferral לא השתנתה.
    const payload = approval.payload as unknown as DeferralApprovalPayload;
    const oldDue = payload.oldDueDate ? pretty(payload.oldDueDate) : "המקורי";
    return `מוטי לא אישר את הדחייה שביקשת. התאריך נשאר ${oldDue}.${note ? ` (${note})` : ""}`;
  },
};

/**
 * ביטול/"לא רלוונטי" (audit 2026-09-17/20) — הפעולה הקריטית היא אותה updateTask({action:"state"})
 * הגנרית שכבר משמשת בכל המערכת (deferralExecutor למעלה, replyBlocked/replyFinishingToday ב-
 * loopReply.ts) עם PARKED_LABEL (opsWrite.ts) — "לא ממציאים פעולה חדשה", כפי שהתבקש.
 */
const cancellationExecutor: KindExecutor = {
  async applyToMonday(approval, manager, note, deps) {
    if (!approval.itemId || !approval.itemSource) throw new Error("לבקשת האישור חסר itemId/itemSource.");
    const label = PARKED_LABEL[approval.itemSource as OpsTaskSource];

    // הקריטי היחיד: שינוי הסטטוס בפועל ל"לא רלוונטי/מושהה". זורק ומחוץ ל-try/catch פנימי.
    await deps.updateTask(manager, { action: "state", source: approval.itemSource as OpsTaskSource, itemId: approval.itemId, label });

    // נלווה, best-effort — הסטטוס כבר השתנה בפועל, כשלון כאן לא הופך את זה ל"נכשל".
    try {
      await deps.addTaskNote(
        approval.itemId,
        `⏸️ סומן/ה כ"${label}" — אושר ע"י מוטי${note ? ` — ${note}` : ""} (בקשה מקורית: ${approval.requestedBy})`,
      );
    } catch (err) {
      logger.error({ approvalId: approval.id, err }, "approve(cancellation): addTaskNote נכשל אחרי updateTask — האישור עדיין תקף");
    }
  },

  recordApproved(approval, manager, note, deps) {
    if (!approval.findingKey) return;
    deps.recordFindingEvent(approval.findingKey, "manager_approval_approved", {
      byUser: manager.key,
      note: note ?? undefined,
      approvalId: approval.id,
    });
    // "לא רלוונטי" הוא סגירה, לא snooze — אין תאריך שאחריו חוזרים לבדוק. resolved_by_reply הוא
    // בדיוק הסמנטיקה הזו (findingEvents.ts: isResolvedByReply — "סיים / לא רלוונטי").
    deps.recordFindingEvent(approval.findingKey, "resolved_by_reply", {
      byUser: manager.key,
      note: note ?? undefined,
      action: "cancellation_approved",
    });
    deps.markNudgesSeenForFinding(approval.requestedBy, approval.findingKey);
  },

  employeeApprovedMessage(approval) {
    return `מוטי אישר לסגור את המשימה "${approval.taskName ?? approval.itemId}" כ"לא רלוונטי". עדכנתי את Monday.`;
  },

  employeeRejectedMessage(approval, note) {
    return `מוטי לא אישר את הבקשה לסגור את המשימה "${approval.taskName ?? approval.itemId}" כ"לא רלוונטי" — היא נשארת פתוחה.${note ? ` (${note})` : ""}`;
  },
};

const KIND_EXECUTORS: Partial<Record<ApprovalKind, KindExecutor>> = {
  deferral: deferralExecutor,
  cancellation: cancellationExecutor,
};

/** בדיקות שמשותפות לשלושת הפעולות: הרשאה server-side, שהבקשה מיועדת לאותו מנהל, לא לאשר לעצמך. */
function guard(manager: IdentifiedUser, approvalId: number): ApprovalActionResult | StoredApproval {
  // ההרשאה נבדקת כאן על ה-IdentifiedUser שהגיע מה-session (server/index.ts: currentUser(req) →
  // readSession → resolveUserByKey) — לעולם לא על שדה מה-body. אי אפשר "לזייף" מנהל דרך הבקשה.
  if (!userCan(manager, "approve:sensitive")) {
    return { ok: false, code: "forbidden", message: "רק מוטי יכול להכריע בקשות אישור." };
  }
  const approval = getApproval(approvalId);
  if (!approval) return { ok: false, code: "not_found", message: "בקשת האישור לא נמצאה." };
  if (approval.managerUserKey !== manager.key) {
    return { ok: false, code: "forbidden", message: "בקשת האישור הזו לא מיועדת אליך." };
  }
  if (approval.requestedBy === manager.key) {
    return { ok: false, code: "self_approval", message: "אי אפשר להכריע בקשה של עצמך." };
  }
  return approval;
}

/** אישור — הזרימה הגנרית: claim → executor.applyToMonday → finalize (מיד!) → best-effort. */
export async function approveApproval(
  manager: IdentifiedUser,
  approvalId: number,
  note: string | undefined,
  deps: ApprovalDecisionDeps = {},
): Promise<ApprovalActionResult> {
  const fullDeps: ExecutorDeps = {
    setTaskDueDate: deps.setTaskDueDate ?? setTaskDueDate,
    updateTask: deps.updateTask ?? updateTask,
    addTaskNote: deps.addTaskNote ?? addTaskNote,
    recordFindingEvent: deps.recordFindingEvent ?? recordFindingEvent,
    markNudgesSeenForFinding: deps.markNudgesSeenForFinding ?? markNudgesSeenForFinding,
    scheduleCommitmentCheck: deps.scheduleCommitmentCheck ?? scheduleCommitmentCheck,
  };
  const doAddNotification = deps.addNotification ?? addNotification;

  const g = guard(manager, approvalId);
  if (!("id" in g)) return g;
  const approval = g;

  const executor = KIND_EXECUTORS[approval.kind];
  if (!executor) {
    return { ok: false, code: "unsupported_kind", message: `אישור מסוג "${approval.kind}" עדיין לא נתמך.`, approval };
  }

  if (!claimApproval(approvalId)) {
    return { ok: false, code: "already_decided", message: "הבקשה הזו כבר הוכרעה.", approval: getApproval(approvalId)! };
  }

  try {
    await executor.applyToMonday(approval, manager, note ?? null, fullDeps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    revertAfterFailure(approvalId, msg);
    return { ok: false, code: "execution_failed", message: `הפעולה ב-Monday נכשלה: ${msg}`, approval: getApproval(approvalId)! };
  }

  // הכתיבה הקריטית הצליחה — ננעלים על "approved" *לפני* כל שלב best-effort. מכאן והלאה שום
  // תקלה (finding_event/notification) לא יכולה להחזיר את זה ל-pending או לגרום לניסיון חוזר.
  finalizeApproved(approvalId, manager.key, note ?? null);
  const finalApproval = getApproval(approvalId)!;

  try {
    executor.recordApproved(finalApproval, manager, note ?? null, fullDeps);
  } catch (err) {
    logger.error({ approvalId, err }, "approve: תיעוד/בקרה אחרי אישור נכשל — האישור עצמו נשאר approved");
  }

  try {
    const body = executor.employeeApprovedMessage(finalApproval);
    const notifId = doAddNotification(finalApproval.requestedBy, "manager_decision", body, finalApproval.findingKey ?? undefined, {
      itemId: finalApproval.itemId ?? undefined,
      itemSource: finalApproval.itemSource ?? undefined,
      context: { approvalId, kind: finalApproval.kind, decision: "approved" },
    });
    publishApprovalLive(finalApproval.requestedBy, notifId, "manager_decision", body, finalApproval, { decision: "approved" });
  } catch (err) {
    // "notification צריך להיות retryable בנפרד" — כרגע אין תור-retry אוטומטי (לא נבנה כאן, זה
    // שלב הבא); מה שחשוב עכשיו: הכשלון הזה לעולם לא הופך את ה-approve לכישלון.
    logger.error({ approvalId, err }, "approve: התראה לעובד נכשלה — האישור עצמו נשאר approved, ניתן לשלוח שוב ידנית");
  }

  return { ok: true, approval: finalApproval };
}

/** דחייה — לעולם לא נוגעת ב-Monday. הממצא נשאר פתוח, המשימה נשארת בטיפול. */
export async function rejectApproval(
  manager: IdentifiedUser,
  approvalId: number,
  note: string | undefined,
  deps: ApprovalDecisionDeps = {},
): Promise<ApprovalActionResult> {
  const doRecordFindingEvent = deps.recordFindingEvent ?? recordFindingEvent;
  const doAddNotification = deps.addNotification ?? addNotification;

  const g = guard(manager, approvalId);
  if (!("id" in g)) return g;
  const approval = g;

  // CAS יחיד, אטומי — pending/pending_instruction → rejected. אין שלב ביניים ("approving")
  // לדחייה כי אין כתיבת Monday: ברגע שזה מצליח, ה-Approval כבר סופי, לא יכול "להיתקע".
  if (!markRejected(approvalId, manager.key, note ?? null)) {
    return { ok: false, code: "already_decided", message: "הבקשה הזו כבר הוכרעה.", approval: getApproval(approvalId)! };
  }

  try {
    if (approval.findingKey) {
      doRecordFindingEvent(approval.findingKey, "manager_approval_rejected", {
        byUser: manager.key,
        note,
        approvalId: approval.id,
      });
    }
  } catch (err) {
    logger.error({ approvalId, err }, "reject: תיעוד finding_event נכשל — הדחייה עצמה כבר תקפה");
  }

  try {
    // kind-specific (audit 2026-09-17/20) — קודם היה קשיח לניסוח דחייה (מניח oldDueDate), לא
    // התאים ל-kind אחר. kind בלי executor רשום (למשל reassignment עדיין) → ניסוח כללי.
    const executor = KIND_EXECUTORS[approval.kind];
    const body = executor
      ? executor.employeeRejectedMessage(approval, note ?? null)
      : `מוטי לא אישר את הבקשה שלך.${note ? ` (${note})` : ""}`;
    const notifId = doAddNotification(approval.requestedBy, "manager_decision", body, approval.findingKey ?? undefined, {
      itemId: approval.itemId ?? undefined,
      itemSource: approval.itemSource ?? undefined,
      context: { approvalId, kind: approval.kind, decision: "rejected" },
    });
    publishApprovalLive(approval.requestedBy, notifId, "manager_decision", body, approval, { decision: "rejected" });
  } catch (err) {
    logger.error({ approvalId, err }, "reject: התראה לעובד נכשלה — הדחייה עצמה כבר תקפה");
  }

  return { ok: true, approval: getApproval(approvalId)! };
}

/**
 * "פרטים / הנחיה אחרת" — לא סופי. הבקשה נשארת actionable (pending_instruction). ההודעה נשמרת גם
 * ב-manager_approval_messages (senderRole=manager) — לא רק ב-decision_note — כדי שהיסטוריית
 * השיחה תישמר גם כשיהיו כמה סבבים. הודעת העובד מגיעה כ-kind ייעודי "approval_instruction" עם
 * payload מובנה (approvalId/findingKey/itemId/kind/interactionType) — לא רק טקסט חופשי — כדי
 * שה-UI (ובהמשך, chat.ts) יוכלו לקשר את תשובת העובד לבקשה הזו בלי לנחש מהטקסט.
 */
export async function giveApprovalInstruction(
  manager: IdentifiedUser,
  approvalId: number,
  instruction: string,
  deps: ApprovalDecisionDeps = {},
): Promise<ApprovalActionResult> {
  const doRecordFindingEvent = deps.recordFindingEvent ?? recordFindingEvent;
  const doAddNotification = deps.addNotification ?? addNotification;

  const text = instruction.trim();
  if (!text) return { ok: false, code: "bad_request", message: "ההנחיה ריקה." };

  const g = guard(manager, approvalId);
  if (!("id" in g)) return g;
  const approval = g;

  if (!markInstruction(approvalId, text)) {
    return { ok: false, code: "already_decided", message: "הבקשה הזו כבר הוכרעה.", approval: getApproval(approvalId)! };
  }

  addApprovalMessage(approvalId, manager.key, "manager", text);

  try {
    if (approval.findingKey) {
      doRecordFindingEvent(approval.findingKey, "manager_pinged", {
        byUser: manager.key,
        note: text,
        action: "approval_instruction",
        approvalId: approval.id,
      });
    }
  } catch (err) {
    logger.error({ approvalId, err }, "instruction: תיעוד finding_event נכשל — ההנחיה עצמה כבר נשמרה");
  }

  try {
    const body = `מוטי מבקש פרטים לגבי הבקשה על "${approval.taskName ?? approval.itemId}": ${text}`;
    const context = {
      approvalId,
      findingKey: approval.findingKey,
      itemId: approval.itemId,
      itemSource: approval.itemSource,
      kind: approval.kind,
      interactionType: "approval_instruction" as const,
      instruction: text,
    };
    const notifId = doAddNotification(approval.requestedBy, "approval_instruction", body, approval.findingKey ?? undefined, {
      itemId: approval.itemId ?? undefined,
      itemSource: approval.itemSource ?? undefined,
      context,
    });
    publishApprovalLive(approval.requestedBy, notifId, "approval_instruction", body, approval, context);
  } catch (err) {
    logger.error({ approvalId, err }, "instruction: התראה לעובד נכשלה — ההנחיה עצמה כבר נשמרה");
  }

  return { ok: true, approval: getApproval(approvalId)! };
}

/**
 * תשובת העובד לשאלה/הנחיה של מוטי (סגירת פער ה-audit, 2026-09-14). מסלול נפרד ודטרמיניסטי —
 * לא עובר דרך ה-AI/reply_* tools: אם ה-Approval שלו pending_instruction, ההודעה כולה היא תשובה
 * למוטי, נקודה. (ראה chat.ts: runOpsChat בודק about.approvalId לפני שהוא בכלל בונה tools.)
 *
 * CAS יחיד (returnToPendingAfterReply: pending_instruction → pending) הוא גם ההגנה מפני תשובה
 * כפולה/מירוץ מול הכרעה של מוטי: אם הוא כבר אישר/דחה/ה-Approval כבר לא pending_instruction —
 * ה-CAS נכשל ולא נשמרת "תשובה רשמית". לא נוגע ב-Monday, לא סוגר finding.
 */
export async function replyToApprovalInstruction(
  employee: IdentifiedUser,
  approvalId: number,
  replyText: string,
  deps: ApprovalDecisionDeps = {},
): Promise<ApprovalActionResult> {
  const doRecordFindingEvent = deps.recordFindingEvent ?? recordFindingEvent;
  const doAddNotification = deps.addNotification ?? addNotification;

  const text = replyText.trim();
  if (!text) return { ok: false, code: "bad_request", message: "התשובה ריקה." };

  const approval = getApproval(approvalId);
  if (!approval) return { ok: false, code: "not_found", message: "בקשת האישור לא נמצאה." };
  // עובד A לא יכול לענות על Approval של עובד B — ולא דרך spoofed approvalId: הבדיקה היא מול
  // requestedBy השמור ב-DB, לא מול משהו שהעובד שלח.
  if (approval.requestedBy !== employee.key) {
    return { ok: false, code: "forbidden", message: "זו לא בקשת האישור שלך." };
  }

  // ה-CAS: רק אם עדיין pending_instruction. אם מוטי כבר הכריע (approved/rejected) בינתיים —
  // נכשל כאן, לא "נדרס" ולא נשמר כתשובה רשמית.
  if (!returnToPendingAfterReply(approvalId)) {
    const fresh = getApproval(approvalId)!;
    const stillOpen = fresh.status !== "approved" && fresh.status !== "rejected";
    return {
      ok: false,
      code: stillOpen ? "not_awaiting_reply" : "already_decided",
      message: stillOpen
        ? "מוטי לא שאל שאלה שממתינה לתשובה כרגע."
        : "מוטי כבר הכריע על הבקשה הזו לפני שהתשובה הגיעה.",
      approval: fresh,
    };
  }

  addApprovalMessage(approvalId, employee.key, "employee", text);
  const fresh = getApproval(approvalId)!;

  try {
    if (approval.findingKey) {
      doRecordFindingEvent(approval.findingKey, "employee_responded", { byUser: employee.key, note: text, action: "approval_reply" });
    }
  } catch (err) {
    logger.error({ approvalId, err }, "reply_to_approval_instruction: תיעוד finding_event נכשל — התשובה עצמה כבר נשמרה");
  }

  try {
    const body = `${employee.name} ענה/תה לגבי "${approval.taskName ?? approval.itemId}": ${text}`;
    const context = {
      approvalId,
      findingKey: approval.findingKey,
      itemId: approval.itemId,
      itemSource: approval.itemSource,
      kind: approval.kind,
      interactionType: "approval_reply" as const,
    };
    const notifId = doAddNotification(approval.managerUserKey, "approval_reply", body, approval.findingKey ?? undefined, {
      itemId: approval.itemId ?? undefined,
      itemSource: approval.itemSource ?? undefined,
      context,
    });
    publishApprovalLive(approval.managerUserKey, notifId, "approval_reply", body, approval, context);
  } catch (err) {
    logger.error({ approvalId, err }, "reply_to_approval_instruction: התראה למוטי נכשלה — התשובה עצמה כבר נשמרה");
  }

  return { ok: true, approval: fresh };
}

/** בקשת אישור + כל היסטוריית ההודעות שלה — ל-GET /api/approvals (כרטיס מוטי צריך את שתיהן יחד). */
export function getApprovalWithMessages(approvalId: number): ApprovalWithMessages | null {
  const approval = getApproval(approvalId);
  if (!approval) return null;
  return { ...approval, messages: listApprovalMessages(approvalId) };
}

function publishApprovalLive(
  userKey: string,
  notifId: number,
  kind: string,
  body: string,
  approval: StoredApproval,
  context: Record<string, unknown>,
): void {
  publishNotificationLive({
    userKey,
    id: notifId,
    kind,
    body,
    findingKey: approval.findingKey,
    itemId: approval.itemId,
    itemSource: approval.itemSource,
    context,
    createdAt: DateTime.now().setZone(env.TIMEZONE).toISO()!,
  });
}

/** לנוחות ה-endpoint: מזהה את מוטי כברירת המחדל (managerUserKey) כשיוצרים Approval חדש. */
export function resolveDefaultManager(): IdentifiedUser | null {
  return resolveUserByKey("moti");
}
