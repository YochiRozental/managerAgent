/**
 * בדיקות ל"אישורים למוטי בזמן אמת" עבור מסלול הביטול (replyNotRelevant → cancellation approval),
 * audit 2026-09-17 → מימוש 2026-09-20. אותו pattern בדיוק כמו scripts/test-reply-defer.ts /
 * scripts/test-approvals.ts: DB אמיתי (מקומי, לא Monday) לגמרי, כל side-effect שיכול לגעת
 * ב-Monday מוזרק/מזוייף. `now` דינמי (DateTime.now()) — לא תאריך קפוא, כדי לא לחזור על הבאג
 * שתוקן ב-test-reply-defer.ts (audit 2026-09-20: תאריך קפוא + Policy Engine שמחשב "today" מהשעון
 * האמיתי = date drift).
 *
 *   npm run test:cancellation-approval
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../src/config/env.js";
import { db } from "../src/db/db.js";
import { upsertFinding } from "../src/db/repositories/controlFindings.js";
import { findingEvents } from "../src/db/repositories/findingEvents.js";
import {
  createApproval as realCreateApproval,
  getApproval,
  type CreateApprovalInput,
  type StoredApproval,
} from "../src/db/repositories/managerApprovals.js";
import { resolveUserByKey } from "../src/identity/index.js";
import { replyNotRelevant, type LoopContext, type ReplyNotRelevantDeps } from "../src/ops/loopReply.js";
import { approveApproval, rejectApproval, type ApprovalDecisionDeps } from "../src/ops/approvalActions.js";
import { publishNotificationLive, subscribeNotifications } from "../src/ops/notificationBus.js";
import { PARKED_LABEL } from "../src/integrations/monday/opsWrite.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const now = DateTime.now().setZone(env.TIMEZONE);
const dov = resolveUserByKey("dov")!;
const moti = resolveUserByKey("moti")!;

function makeSpy<TArgs extends unknown[]>() {
  const calls: TArgs[] = [];
  const fn = ((...args: TArgs) => {
    calls.push(args);
    return undefined as unknown;
  }) as unknown as (...args: TArgs) => unknown;
  return { fn, calls };
}

function cleanup(): void {
  db.exec(
    `DELETE FROM manager_approval_messages WHERE approval_id IN (SELECT id FROM manager_approvals WHERE item_id LIKE '%__cnl_%')`,
  );
  db.exec(`DELETE FROM manager_approvals WHERE item_id LIKE '%__cnl_%'`);
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '%__cnl_%'`);
  db.exec(`DELETE FROM control_findings WHERE item_id LIKE '%__cnl_%'`);
  db.exec(`DELETE FROM notifications WHERE item_id LIKE '%__cnl_%'`);
}
cleanup();

function seedFinding(itemId: string): string {
  const findingKey = `overdue:${itemId}`;
  upsertFinding({
    findingKey,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: "בדיקת ביטול",
    detail: "בדיקה",
    itemId,
    itemSource: "general",
    dueDate: now.minus({ days: 2 }).toISODate()!,
    now: now.toISO()!,
  });
  return findingKey;
}

/** עוטף את createApproval האמיתי (DB מקומי, לא Monday) — כדי לתפוס גם את הקלט וגם את approval.id. */
function makeCreateApprovalWrapper() {
  const calls: { input: CreateApprovalInput; result: { approval: StoredApproval; created: boolean } }[] = [];
  const fn = (input: CreateApprovalInput) => {
    const result = realCreateApproval(input);
    calls.push({ input, result });
    return result;
  };
  return { fn, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. cancellation שדורש manager approval → נוצר approval, notification, publish live
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 1. cancellation חדש → approval + notification + live publish ──");
let firstApprovalId: number;
{
  const itemId = "__cnl_new__";
  const findingKey = seedFinding(itemId);
  const c: LoopContext = { itemId, source: "general", findingKey, taskName: "בדיקת ביטול" };

  const addTaskNoteSpy = makeSpy<[string, string]>();
  const recordFindingEventSpy = makeSpy<[string, string, Record<string, unknown>]>();
  const addNotificationSpy = makeSpy<[string, string, string, string?, unknown?]>();
  const markSeenSpy = makeSpy<[string, string]>();
  const createWrap = makeCreateApprovalWrapper();

  const deps: ReplyNotRelevantDeps = {
    addTaskNote: async (...a: unknown[]) => { addTaskNoteSpy.fn(...(a as [string, string])); },
    recordFindingEvent: (...a: unknown[]) => recordFindingEventSpy.fn(...(a as [string, string, Record<string, unknown>])),
    addNotification: (...a: unknown[]) => {
      addNotificationSpy.fn(...(a as [string, string, string, string?, unknown?]));
      return 1;
    },
    markNudgesSeenForFinding: (...a: unknown[]) => markSeenSpy.fn(...(a as [string, string])),
    createApproval: createWrap.fn,
  };

  const liveEvents: { userKey: string; kind: string; context: unknown }[] = [];
  const unsub = subscribeNotifications((n) => liveEvents.push(n));
  const result = await replyNotRelevant(dov, c, "הלקוח ביטל את הפרויקט", deps);
  unsub();

  check("replyNotRelevant מצליח", result.ok === true, JSON.stringify(result));
  check("addTaskNote (Monday, מזוייף) נקרא בדיוק פעם אחת", addTaskNoteSpy.calls.length === 1);
  // התנהגות קיימת (לא שונתה): replyNotRelevant תמיד סימן seen מיד — בניגוד ל-replyDefer's
  // manager_approval_required, שלא מסמן seen עד שמוטי מכריע. לא נגעתי בזה (מחוץ לסקופ הבקשה).
  check("markNudgesSeenForFinding נקרא (התנהגות קיימת, לא שונתה)", markSeenSpy.calls.length === 1 && markSeenSpy.calls[0]![0] === "dov");

  check(
    "נוצר Approval אחד מסוג cancellation, requestedBy=dov, managerUserKey=moti",
    createWrap.calls.length === 1 &&
      createWrap.calls[0]!.result.created === true &&
      createWrap.calls[0]!.input.kind === "cancellation" &&
      createWrap.calls[0]!.input.requestedBy === "dov" &&
      createWrap.calls[0]!.input.managerUserKey === "moti",
    JSON.stringify(createWrap.calls[0]),
  );
  firstApprovalId = createWrap.calls[0]!.result.approval.id;

  check(
    "ה-payload נושא reason ו-ruleId",
    (createWrap.calls[0]!.input.payload as Record<string, unknown>).reason === "הלקוח ביטל את הפרויקט" &&
      typeof (createWrap.calls[0]!.input.payload as Record<string, unknown>).ruleId === "string",
    JSON.stringify(createWrap.calls[0]!.input.payload),
  );

  check(
    "נרשם finding_event מסוג manager_approval_required",
    recordFindingEventSpy.calls.some((c2) => c2[1] === "manager_approval_required"),
  );

  check(
    "נוצרה notification למוטי מסוג approval_request",
    addNotificationSpy.calls.length === 1 && addNotificationSpy.calls[0]![0] === "moti" && addNotificationSpy.calls[0]![1] === "approval_request",
    JSON.stringify(addNotificationSpy.calls[0]),
  );

  check(
    "publishNotificationLive נקרא — אירוע SSE אחד בדיוק, למוטי, קינד approval_request, עם approvalId מספרי",
    liveEvents.length === 1 &&
      liveEvents[0]!.userKey === "moti" &&
      liveEvents[0]!.kind === "approval_request" &&
      typeof (liveEvents[0]!.context as { approvalId?: number }).approvalId === "number",
    JSON.stringify(liveEvents),
  );

  const reread = getApproval(firstApprovalId);
  check("ה-Approval נשמר וניתן לקרוא מחדש מה-DB, במצב pending", reread !== null && reread.status === "pending", JSON.stringify(reread));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. אותה בקשה שוב → אין approval כפול, אין notification/live כפולים
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 2. אותה בקשה שוב → dedup (אין כפילות) ──");
{
  const itemId = "__cnl_new__"; // אותו item — אותו findingKey בדיוק
  const findingKey = `overdue:${itemId}`;
  const c: LoopContext = { itemId, source: "general", findingKey, taskName: "בדיקת ביטול" };

  const addNotificationSpy = makeSpy<[string, string, string, string?, unknown?]>();
  const createWrap = makeCreateApprovalWrapper();

  const deps: ReplyNotRelevantDeps = {
    addTaskNote: async () => {},
    recordFindingEvent: () => {},
    addNotification: (...a: unknown[]) => {
      addNotificationSpy.fn(...(a as [string, string, string, string?, unknown?]));
      return 1;
    },
    markNudgesSeenForFinding: () => {},
    createApproval: createWrap.fn,
  };

  const liveEvents: unknown[] = [];
  const unsub = subscribeNotifications((n) => liveEvents.push(n));
  const result = await replyNotRelevant(dov, c, "הלקוח ביטל את הפרויקט", deps);
  unsub();

  check("replyNotRelevant עדיין מצליח (לא זורק על כפילות)", result.ok === true);
  check(
    "createApproval מזהה כפילות — created=false, אותו approval.id כמו קודם",
    createWrap.calls.length === 1 && createWrap.calls[0]!.result.created === false && createWrap.calls[0]!.result.approval.id === firstApprovalId,
    JSON.stringify(createWrap.calls[0]),
  );
  check("אין notification נוספת למוטי (dedup)", addNotificationSpy.calls.length === 0);
  check("אין אירוע SSE נוסף (dedup)", liveEvents.length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. מוטי מאשר cancellation → פעולת הביטול הקיימת מתבצעת, approval נסגר, audit נשמר, העובד מודע
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 3. אישור cancellation ──");
{
  const updateTaskSpy = makeSpy<[unknown, { action: string; source: string; itemId: string; label?: string }]>();
  const addTaskNoteSpy = makeSpy<[string, string]>();
  const recordFindingEventSpy = makeSpy<[string, string, Record<string, unknown>]>();
  const addNotificationSpy = makeSpy<[string, string, string, string?, unknown?]>();
  const markSeenSpy = makeSpy<[string, string]>();

  const deps: ApprovalDecisionDeps = {
    updateTask: async (...a: unknown[]) => {
      updateTaskSpy.fn(...(a as [unknown, { action: string; source: string; itemId: string; label?: string }]));
      return undefined as never;
    },
    addTaskNote: async (...a: unknown[]) => { addTaskNoteSpy.fn(...(a as [string, string])); },
    recordFindingEvent: (...a: unknown[]) => recordFindingEventSpy.fn(...(a as [string, string, Record<string, unknown>])),
    addNotification: (...a: unknown[]) => {
      addNotificationSpy.fn(...(a as [string, string, string, string?, unknown?]));
      return 1;
    },
    markNudgesSeenForFinding: (...a: unknown[]) => markSeenSpy.fn(...(a as [string, string])),
  };

  const result = await approveApproval(moti, firstApprovalId, "מאשר לבטל", deps);
  check("approve מצליח (ok:true)", result.ok === true, JSON.stringify(result));

  check(
    "פעולת הביטול הקיימת בוצעה: updateTask({action:'state', label: PARKED_LABEL.general}) — לא הומצאה פעולה חדשה",
    updateTaskSpy.calls.length === 1 &&
      updateTaskSpy.calls[0]![1].action === "state" &&
      updateTaskSpy.calls[0]![1].source === "general" &&
      updateTaskSpy.calls[0]![1].itemId === "__cnl_new__" &&
      updateTaskSpy.calls[0]![1].label === PARKED_LABEL.general,
    JSON.stringify(updateTaskSpy.calls[0]),
  );
  check("addTaskNote (תיעוד) נקרא אחרי updateTask", addTaskNoteSpy.calls.length === 1);

  const reread = getApproval(firstApprovalId)!;
  check(
    "ה-Approval נסגר: status=approved, decidedAt/decisionBy/executionStatus נשמרו",
    reread.status === "approved" && !!reread.decidedAt && reread.decisionBy === "moti" && reread.executionStatus === "executed",
    JSON.stringify(reread),
  );

  const events = recordFindingEventSpy.calls.map((c2) => c2[1]);
  check("audit נשמר: manager_approval_approved", events.includes("manager_approval_approved"), JSON.stringify(events));
  check(
    "audit נשמר: resolved_by_reply (סגירת הממצא — 'לא רלוונטי' הוא סגירה, לא snooze)",
    events.includes("resolved_by_reply"),
    JSON.stringify(events),
  );
  check("ה-nudge סומן seen לעובד (dov)", markSeenSpy.calls.length === 1 && markSeenSpy.calls[0]![0] === "dov");

  check(
    "העובד (dov) מקבל notification, לא מוטי",
    addNotificationSpy.calls.length === 1 && addNotificationSpy.calls[0]![0] === "dov" && addNotificationSpy.calls[0]![1] === "manager_decision",
    JSON.stringify(addNotificationSpy.calls[0]),
  );
  check(
    "תוכן ההתראה לעובד מדבר על 'לא רלוונטי', לא על תאריך (הודעת דחייה/אישור ספציפית ל-cancellation, לא נוסח deferral)",
    addNotificationSpy.calls[0]![2].includes("לא רלוונטי") && !addNotificationSpy.calls[0]![2].includes("תאריך"),
    addNotificationSpy.calls[0]![2],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. מוטי דוחה cancellation → המשימה לא מבוטלת, approval נסגר, העובד מודע
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 4. דחיית cancellation ──");
let secondApprovalId: number;
{
  const itemId = "__cnl_reject__";
  const findingKey = seedFinding(itemId);
  const { approval } = realCreateApproval({
    kind: "cancellation",
    requestedBy: "dov",
    managerUserKey: "moti",
    findingKey,
    itemId,
    itemSource: "general",
    taskName: "בדיקת דחיית ביטול",
    payload: { reason: "לא באמת רלוונטי", ruleId: "cancellation-requires-approval" },
  });
  secondApprovalId = approval.id;

  const updateTaskSpy = makeSpy();
  const setTaskDueDateSpy = makeSpy();
  const addNotificationSpy = makeSpy<[string, string, string, string?, unknown?]>();

  const deps: ApprovalDecisionDeps = {
    updateTask: async (...a: unknown[]) => { updateTaskSpy.fn(...a); return undefined as never; },
    setTaskDueDate: async (...a: unknown[]) => { setTaskDueDateSpy.fn(...a); },
    addNotification: (...a: unknown[]) => {
      addNotificationSpy.fn(...(a as [string, string, string, string?, unknown?]));
      return 1;
    },
  };

  const result = await rejectApproval(moti, secondApprovalId, "לא, זה עדיין רלוונטי", deps);
  check("reject מצליח", result.ok === true, JSON.stringify(result));

  check("המשימה לא בוטלה — Monday לא נקרא בכלל (לא updateTask, לא setTaskDueDate)", updateTaskSpy.calls.length === 0 && setTaskDueDateSpy.calls.length === 0);

  const reread = getApproval(secondApprovalId)!;
  check("ה-Approval נסגר: status=rejected, decidedAt/decisionBy נשמרו", reread.status === "rejected" && !!reread.decidedAt && reread.decisionBy === "moti", JSON.stringify(reread));

  const events = findingEvents(findingKey).map((e) => e.event);
  check(
    "audit: manager_approval_rejected נרשם, הממצא נשאר פתוח (אין resolved_by_reply)",
    events.includes("manager_approval_rejected") && !events.includes("resolved_by_reply"),
    JSON.stringify(events),
  );

  check(
    "העובד (dov) מקבל notification שהבקשה לא אושרה",
    addNotificationSpy.calls.length === 1 && addNotificationSpy.calls[0]![0] === "dov" && addNotificationSpy.calls[0]![1] === "manager_decision",
    JSON.stringify(addNotificationSpy.calls[0]),
  );
  check(
    "תוכן ההתראה קורא נכון ל-cancellation ('לא רלוונטי'), לא לנוסח דחייה-תאריך הישן ('התאריך נשאר')",
    addNotificationSpy.calls[0]![2].includes("לא רלוונטי") && !addNotificationSpy.calls[0]![2].includes("התאריך נשאר"),
    addNotificationSpy.calls[0]![2],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. רגרסיה: deferral approval הקיים ממשיך לעבוד (approve + reject, כולל נוסח הדחייה המקורי)
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 5. רגרסיה: deferral ממשיך לעבוד (approve + reject עם הנוסח המקורי) ──");
{
  const newDate5d = now.plus({ days: 5 }).toISODate()!;
  const overdue2d = now.minus({ days: 2 }).toISODate()!;

  function seedDeferralApproval(itemId: string) {
    const findingKey = seedFinding(itemId);
    return realCreateApproval({
      kind: "deferral",
      requestedBy: "dov",
      managerUserKey: "moti",
      findingKey,
      itemId,
      itemSource: "general",
      taskName: "בדיקת רגרסיה — דחייה",
      payload: {
        oldDueDate: overdue2d,
        requestedNewDueDate: newDate5d,
        reason: "בדיקה",
        priorDeferrals: { beforeOverdue: 0, afterOverdue: 1 },
        ruleId: "after-overdue-long",
        wasOverdue: true,
      },
    }).approval;
  }

  // 5א. approve דחייה — עדיין setTaskDueDate (לא updateTask עם PARKED_LABEL).
  {
    const a = seedDeferralApproval("__cnl_regress_approve__");
    const setTaskDueDateSpy = makeSpy<[string, string, string]>();
    const deps: ApprovalDecisionDeps = {
      setTaskDueDate: async (...args: unknown[]) => { setTaskDueDateSpy.fn(...(args as [string, string, string])); },
      addTaskNote: async () => {},
      updateTask: async () => undefined as never,
      addNotification: () => 1,
    };
    const result = await approveApproval(moti, a.id, "מאשר", deps);
    check("5א: deferral approve עדיין מצליח", result.ok === true, JSON.stringify(result));
    check(
      "5א: setTaskDueDate נקרא עם התאריך הנכון — לא הושפע מהוספת cancellationExecutor",
      setTaskDueDateSpy.calls.length === 1 && setTaskDueDateSpy.calls[0]![2] === newDate5d,
    );
  }

  // 5ב. reject דחייה — נוסח ההודעה לעובד זהה בדיוק למקור ("התאריך נשאר").
  {
    const a = seedDeferralApproval("__cnl_regress_reject__");
    const addNotificationSpy = makeSpy<[string, string, string, string?, unknown?]>();
    const deps: ApprovalDecisionDeps = {
      addNotification: (...args: unknown[]) => {
        addNotificationSpy.fn(...(args as [string, string, string, string?, unknown?]));
        return 1;
      },
    };
    const result = await rejectApproval(moti, a.id, "לא הפעם", deps);
    check("5ב: deferral reject עדיין מצליח", result.ok === true, JSON.stringify(result));
    check(
      "5ב: נוסח ה-reject לעובד נשאר בדיוק כמו לפני הריפקטור (executor-based) — 'מוטי לא אישר את הדחייה שביקשת. התאריך נשאר'",
      addNotificationSpy.calls.length === 1 && addNotificationSpy.calls[0]![2].includes("מוטי לא אישר את הדחייה שביקשת. התאריך נשאר"),
      addNotificationSpy.calls[0]?.[2],
    );
    check(
      "5ב: התאריך המדויק בנוסח נכון (oldDueDate המקורי)",
      addNotificationSpy.calls[0]![2].includes(DateTime.fromISO(overdue2d, { zone: env.TIMEZONE }).toFormat("dd/MM")),
      addNotificationSpy.calls[0]?.[2],
    );
  }
}

cleanup();

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות ה-cancellation approval עברו ✅");
