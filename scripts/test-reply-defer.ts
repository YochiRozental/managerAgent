/**
 * בדיקות ל-replyDefer אחרי החיבור בפועל ל-Policy Engine (2026-09-14).
 * כל side-effect שיכול לגעת ב-Monday מוזרק (spy/mock) — הבדיקות האלה לעולם לא קוראות ל-Monday
 * האמיתי. חלק מהבדיקות כן נוגעות ב-DB האמיתי (control_findings/finding_events) בכוונה, כדי
 * להוכיח את זרימת ההיסטוריה מקצה-לקצה — בדיוק כמו test-loop.ts / test-deferral-plan.ts.
 *
 *   npm run test:reply-defer
 */

import "dotenv/config";
import fs from "node:fs";
import { DateTime } from "luxon";
import { db } from "../src/db/db.js";
import { upsertFinding } from "../src/db/repositories/controlFindings.js";
import { recordFindingEvent as realRecordFindingEvent } from "../src/db/repositories/findingEvents.js";
import { loadDeferralHistoryForItem } from "../src/db/repositories/deferralHistory.js";
import type { CreateApprovalInput, StoredApproval } from "../src/db/repositories/managerApprovals.js";
import { resolveUserByKey } from "../src/identity/index.js";
import { replyDefer, type LoopContext, type ReplyDeferDeps } from "../src/ops/loopReply.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const now = DateTime.fromISO("2026-09-14T10:00:00", { zone: "Asia/Jerusalem" });
const dov = resolveUserByKey("dov")!;

/** ספיר גנרי: סופר קריאות, שומר ארגומנטים, אפשר להזריק שגיאה. */
function makeSpy<TArgs extends unknown[]>(opts: { throws?: Error } = {}) {
  const calls: TArgs[] = [];
  const fn = ((...args: TArgs) => {
    calls.push(args);
    if (opts.throws) throw opts.throws;
    return undefined as unknown;
  }) as unknown as (...args: TArgs) => unknown;
  return { fn, calls };
}

function baseCtx(itemId: string, currentDueDateISO: string | null): LoopContext {
  return { itemId, source: "general", findingKey: `overdue:${itemId}`, taskName: "בדיקה", currentDueDateISO };
}

let fakeApprovalId = 900000;
/** מזייף createApproval — מחזיר "נוצר" תמיד, לא נוגע ב-manager_approvals האמיתי. שומר את הקלט לבדיקה. */
function makeCreateApprovalMock() {
  const calls: CreateApprovalInput[] = [];
  const fn = (input: CreateApprovalInput): { approval: StoredApproval; created: boolean } => {
    calls.push(input);
    const approval: StoredApproval = {
      id: ++fakeApprovalId,
      status: "pending",
      kind: input.kind,
      requestedBy: input.requestedBy,
      managerUserKey: input.managerUserKey,
      findingKey: input.findingKey ?? null,
      itemId: input.itemId ?? null,
      itemSource: input.itemSource ?? null,
      taskName: input.taskName ?? null,
      payload: input.payload,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      decisionBy: null,
      decisionNote: null,
      executionStatus: null,
      executionError: null,
    };
    return { approval, created: true };
  };
  return { fn, calls };
}

const overdue2d = now.minus({ days: 2 }).toISODate()!; // תאריך יעד שכבר עבר

// replyDefer("executed") מפעיל scheduleCommitmentCheck (follow-up engine) גם כשלא הוזרק deps
// עבורו — כותב ל-control_followups האמיתי (DB מקומי, לא Monday). מנקים לפני ואחרי כל הבדיקות.
function cleanupFollowups(): void {
  db.exec(`DELETE FROM control_followups WHERE item_id LIKE '%__rd_%'`);
}
cleanupFollowups();

// ─────────────────────────────────────────────────────────────────────────────
// 1. דחייה מותרת (executed) — הכל מזוייף, כלום לא נוגע ב-Monday/DB אמיתי
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 1. executed ──");
{
  const callOrder: string[] = [];
  const setTaskDueDateSpy = makeSpy<[string, string, string]>();
  const updateTaskSpy = makeSpy<[unknown, unknown]>();
  const addTaskNoteSpy = makeSpy<[string, string]>();
  const recordFindingEventSpy = makeSpy<[string, string, unknown]>();
  const addNotificationSpy = makeSpy<[string, string, string, string?, unknown?]>();
  const markSeenSpy = makeSpy<[string, string]>();

  const deps: ReplyDeferDeps = {
    setTaskDueDate: async (...a) => {
      callOrder.push("setTaskDueDate");
      setTaskDueDateSpy.fn(...a);
    },
    updateTask: async (...a) => {
      updateTaskSpy.fn(...a);
      return undefined as never;
    },
    addTaskNote: async (...a) => {
      addTaskNoteSpy.fn(...a);
    },
    recordFindingEvent: (...a) => {
      callOrder.push("recordFindingEvent:" + a[1]);
      recordFindingEventSpy.fn(...a);
    },
    addNotification: (...a) => {
      addNotificationSpy.fn(...a);
      return 1;
    },
    markNudgesSeenForFinding: (...a) => {
      callOrder.push("markNudgesSeenForFinding");
      markSeenSpy.fn(...a);
    },
  };

  const c = baseCtx("__rd_exec__", overdue2d);
  const newDate = now.plus({ days: 2 }).toISODate()!; // 2 ימים אחרי איחור → allow (short)
  const result = await replyDefer(dov, c, newDate, "עוד קצת עבודה", null, deps);

  check("Policy מחזיר executed", result.status === "executed", result.status);
  check("setTaskDueDate נקרא פעם אחת עם התאריך הנכון", setTaskDueDateSpy.calls.length === 1 && setTaskDueDateSpy.calls[0]![2] === newDate);
  check("updateTask נקרא (עדכון סטטוס best-effort)", updateTaskSpy.calls.length === 1);
  check("נרשם finding_event יחיד מסוג snoozed", recordFindingEventSpy.calls.length === 1 && recordFindingEventSpy.calls[0]![1] === "snoozed");
  check("snoozed נרשם רק אחרי setTaskDueDate (סדר קריאות)", callOrder.indexOf("setTaskDueDate") < callOrder.indexOf("recordFindingEvent:snoozed"));
  check("ה-nudge סומן seen", markSeenSpy.calls.length === 1 && markSeenSpy.calls[0]![1] === c.findingKey);
  check("markNudgesSeenForFinding נקרא אחרי recordFindingEvent (רק אחרי שהכתיבה תועדה)", callOrder.indexOf("recordFindingEvent:snoozed") < callOrder.indexOf("markNudgesSeenForFinding"));
  check("לא נשלחה notification למוטי (זה לא מצריך אישור)", addNotificationSpy.calls.length === 0);

  const payload = recordFindingEventSpy.calls[0]![2] as Record<string, unknown>;
  check(
    "payload ה-snoozed מכיל itemId/itemSource/oldDueDate/newDueDate(snoozeUntil)/reason/wasOverdue",
    payload.itemId === c.itemId &&
      payload.itemSource === c.source &&
      payload.oldDueDate === overdue2d &&
      payload.snoozeUntil === newDate &&
      payload.note === "עוד קצת עבודה" &&
      payload.wasOverdue === true,
    JSON.stringify(payload),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. needs_clarification — שום כתיבה, שום snooze, שום notification
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 2. needs_clarification ──");
{
  const setTaskDueDateSpy = makeSpy();
  const updateTaskSpy = makeSpy();
  const recordFindingEventSpy = makeSpy();
  const addNotificationSpy = makeSpy();
  const markSeenSpy = makeSpy();

  const deps: ReplyDeferDeps = {
    setTaskDueDate: async (...a: unknown[]) => { setTaskDueDateSpy.fn(...(a as [string, string, string])); },
    updateTask: async (...a: unknown[]) => { updateTaskSpy.fn(...(a as [unknown, unknown])); return undefined as never; },
    recordFindingEvent: (...a: unknown[]) => recordFindingEventSpy.fn(...(a as [string, string, unknown])),
    addNotification: (...a: unknown[]) => {
      addNotificationSpy.fn(...(a as [string, string, string]));
      return 1;
    },
    markNudgesSeenForFinding: (...a: unknown[]) => markSeenSpy.fn(...(a as [string, string])),
  };

  const c = baseCtx("__rd_clarify__", overdue2d);
  const newDate = now.plus({ days: 5 }).toISODate()!; // 5 ימים, בלי reasonJudgedPlausible → needs_clarification
  const result = await replyDefer(dov, c, newDate, undefined, null, deps);

  check("Policy מחזיר needs_clarification", result.status === "needs_clarification", result.status);
  check("מוחזרת שאלת ההבהרה", result.status === "needs_clarification" && !!result.question && result.message === result.question);
  check("setTaskDueDate לא נקרא", setTaskDueDateSpy.calls.length === 0);
  check("updateTask לא נקרא", updateTaskSpy.calls.length === 0);
  check("לא נרשם finding_event בכלל", recordFindingEventSpy.calls.length === 0);
  check("לא נוצרה notification למוטי", addNotificationSpy.calls.length === 0);
  check("ה-nudge לא סומן seen (העובד עוד יענה על ההבהרה)", markSeenSpy.calls.length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. manager_approval_required — שום כתיבה, כן תיעוד + notification עם payload מלא
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 3. manager_approval_required ──");
{
  const setTaskDueDateSpy = makeSpy();
  const updateTaskSpy = makeSpy();
  const recordFindingEventSpy = makeSpy<[string, string, Record<string, unknown>]>();
  const addNotificationSpy = makeSpy<[string, string, string, string, { itemId: string; itemSource: string; context: Record<string, unknown> }]>();
  const markSeenSpy = makeSpy();
  const createApprovalMock = makeCreateApprovalMock();

  const deps: ReplyDeferDeps = {
    setTaskDueDate: async (...a: unknown[]) => { setTaskDueDateSpy.fn(...(a as [string, string, string])); },
    updateTask: async (...a: unknown[]) => { updateTaskSpy.fn(...(a as [unknown, unknown])); return undefined as never; },
    recordFindingEvent: (...a: unknown[]) => recordFindingEventSpy.fn(...(a as [string, string, Record<string, unknown>])),
    addNotification: (...a: unknown[]) => {
      addNotificationSpy.fn(...(a as [string, string, string, string, { itemId: string; itemSource: string; context: Record<string, unknown> }]));
      return 1;
    },
    markNudgesSeenForFinding: (...a: unknown[]) => markSeenSpy.fn(...(a as [string, string])),
    createApproval: createApprovalMock.fn,
  };

  const c = baseCtx("__rd_manager__", overdue2d);
  const newDate = now.plus({ days: 10 }).toISODate()!; // 10 ימים → תמיד אישור מוטי
  const result = await replyDefer(dov, c, newDate, "המשרד סגור בחג", true, deps);

  check("Policy מחזיר manager_approval_required", result.status === "manager_approval_required", result.status);
  check("הניסוח לעובד לא אומר שהדחייה אושרה", !result.message.includes("עדכנתי") && result.message.includes("דורשת אישור") && result.message.includes("לא שיניתי"));
  check("setTaskDueDate לא נקרא", setTaskDueDateSpy.calls.length === 0);
  check("updateTask לא נקרא", updateTaskSpy.calls.length === 0);
  check("לא נרשם snoozed", recordFindingEventSpy.calls.every((c2) => c2[1] !== "snoozed"));
  check("כן נרשם manager_approval_required", recordFindingEventSpy.calls.some((c2) => c2[1] === "manager_approval_required"));
  check("ה-nudge לא סומן seen (עדיין ממתין למוטי)", markSeenSpy.calls.length === 0);

  // 1. manager_approval_required יוצר Approval persistent — עם ה-payload המדויק שהתבקש.
  check("createApproval נקרא פעם אחת, kind=deferral, אצל מוטי", createApprovalMock.calls.length === 1 && createApprovalMock.calls[0]!.kind === "deferral" && createApprovalMock.calls[0]!.managerUserKey === "moti");
  const created = createApprovalMock.calls[0]!;
  check(
    "ה-payload של ה-Approval מכיל oldDueDate/requestedNewDueDate/reason/priorDeferrals/ruleId/wasOverdue",
    (created.payload as Record<string, unknown>).oldDueDate === overdue2d &&
      (created.payload as Record<string, unknown>).requestedNewDueDate === newDate &&
      (created.payload as Record<string, unknown>).reason === "המשרד סגור בחג" &&
      "priorDeferrals" in (created.payload as Record<string, unknown>) &&
      typeof (created.payload as Record<string, unknown>).ruleId === "string" &&
      typeof (created.payload as Record<string, unknown>).wasOverdue === "boolean",
    JSON.stringify(created.payload),
  );
  check("ה-Approval נושא itemId/itemSource/findingKey/taskName/requestedBy נכונים", created.itemId === c.itemId && created.itemSource === c.source && created.findingKey === c.findingKey && created.taskName === c.taskName && created.requestedBy === dov.key);

  check("נוצרה notification למוטי מסוג approval_request, מצביעה ל-approvalId", addNotificationSpy.calls.length === 1 && addNotificationSpy.calls[0]![1] === "approval_request");
  const [, , , findingKey, meta] = addNotificationSpy.calls[0]!;
  const ctx = meta.context;
  check("ה-notification מצביעה ל-approvalId שנוצר (מספר תקין)", typeof ctx.approvalId === "number" && (ctx.approvalId as number) > 0);
  check("ה-notification נושאת תקציר: taskName/oldDueDate/requestedNewDueDate/reason/priorDeferrals", ctx.taskName === c.taskName && ctx.oldDueDate === overdue2d && ctx.requestedNewDueDate === newDate && ctx.reason === "המשרד סגור בחג" && "priorDeferrals" in ctx);
  check("findingKey שהועבר לנוטיפיקציה נכון", findingKey === c.findingKey);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. כשל ב-Monday בזמן executed — אין snooze, אין seen, אין הודעת הצלחה
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 4. כשל Monday ──");
{
  const recordFindingEventSpy = makeSpy();
  const markSeenSpy = makeSpy();
  const updateTaskSpy = makeSpy();

  const deps: ReplyDeferDeps = {
    setTaskDueDate: async () => {
      throw new Error("Monday API timeout (מדומה)");
    },
    updateTask: async (...a: unknown[]) => { updateTaskSpy.fn(...(a as [unknown, unknown])); return undefined as never; },
    recordFindingEvent: (...a: unknown[]) => recordFindingEventSpy.fn(...(a as [string, string, unknown])),
    markNudgesSeenForFinding: (...a: unknown[]) => markSeenSpy.fn(...(a as [string, string])),
  };

  const c = baseCtx("__rd_fail__", overdue2d);
  const newDate = now.plus({ days: 2 }).toISODate()!; // בתוך הסף — היה אמור להיות executed אלמלא הכשל

  let threw = false;
  let errMsg = "";
  try {
    await replyDefer(dov, c, newDate, undefined, null, deps);
  } catch (err) {
    threw = true;
    errMsg = err instanceof Error ? err.message : String(err);
  }

  check("replyDefer זרק שגיאה ברורה כשה-Monday נכשל", threw && errMsg.includes("Monday"), errMsg);
  check("updateTask (סטטוס) לא נקרא — נכשלנו לפני זה", updateTaskSpy.calls.length === 0);
  check("שום finding_event לא נרשם (בטח לא snoozed)", recordFindingEventSpy.calls.length === 0);
  check("ה-nudge לא סומן seen", markSeenSpy.calls.length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. היסטוריית דחיות אמיתית: אחרי executed אמיתי, בקשה נוספת נספרת נכון
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 5. היסטוריה אמיתית אחרי executed ──");
{
  const ITEM = "__rd_history__";
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '%${ITEM}%'`);
  db.exec(`DELETE FROM control_findings WHERE item_id = '${ITEM}'`);

  upsertFinding({
    findingKey: `overdue:${ITEM}`,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: "באיחור 2 ימים: בדיקת היסטוריה",
    detail: "בדיקה",
    itemId: ITEM,
    itemSource: "general",
    dueDate: overdue2d,
    now: now.toISO()!,
  });

  const c = baseCtx(ITEM, overdue2d);
  const firstNewDate = now.plus({ days: 2 }).toISODate()!;

  // רק Monday מזוייף — recordFindingEvent אמיתי, כדי שההיסטוריה תיכתב לטבלה האמיתית.
  // createApproval מזוייף בכוונה — הבדיקה הזו על deferralHistory, לא על manager_approvals.
  const deps: ReplyDeferDeps = {
    setTaskDueDate: async () => {},
    updateTask: async () => undefined as never,
    addTaskNote: async () => {},
    recordFindingEvent: realRecordFindingEvent,
    addNotification: () => 1,
    markNudgesSeenForFinding: () => {},
    createApproval: makeCreateApprovalMock().fn,
  };

  const before = loadDeferralHistoryForItem(ITEM, "general");
  check("לפני הדחייה — אין היסטוריה", before.length === 0);

  const r1 = await replyDefer(dov, c, firstNewDate, "עוד יומיים", null, deps);
  check("הדחייה הראשונה בוצעה (executed)", r1.status === "executed", r1.status);

  const afterOne = loadDeferralHistoryForItem(ITEM, "general");
  check(
    "loadDeferralHistoryForItem סופר את הדחייה שבוצעה בפועל דרך replyDefer",
    afterOne.length === 1 && afterOne[0]!.newDueDate === firstNewDate,
    JSON.stringify(afterOne),
  );

  // עכשיו המשימה עדיין באיחור (התאריך הישן ששמור ב-context הוא לפני היום), ומבקשים דחייה נוספת —
  // לפי כלל 3 (ההתחייבות החדשה כבר נוצלה ולא עמדו בה) זה חייב ללכת ישר למוטי, לא משנה כמה ימים.
  const r2 = await replyDefer(dov, c, now.plus({ days: 1 }).toISODate()!, undefined, null, deps);
  check(
    "בקשת דחייה שנייה לאותה משימה → manager_approval_required (ההיסטוריה האמיתית נספרה)",
    r2.status === "manager_approval_required",
    r2.status,
  );

  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '%${ITEM}%'`);
  db.exec(`DELETE FROM control_findings WHERE item_id = '${ITEM}'`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. reasonJudgedPlausible מגיע בפועל מ-tool call עד Policy Engine
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 6. reasonJudgedPlausible מקצה לקצה ──");
{
  const noopDeps: ReplyDeferDeps = {
    setTaskDueDate: async () => {},
    updateTask: async () => undefined as never,
    addTaskNote: async () => {},
    recordFindingEvent: () => {},
    addNotification: () => 1,
    markNudgesSeenForFinding: () => {},
    createApproval: makeCreateApprovalMock().fn,
  };
  const c = baseCtx("__rd_plausible__", overdue2d);
  const newDate = now.plus({ days: 5 }).toISODate()!; // 5 ימים — התיבה שבה reasonJudgedPlausible קובע הכל

  const rTrue = await replyDefer(dov, c, newDate, "קיבלנו שינוי מהלקוח", true, noopDeps);
  const rFalse = await replyDefer(dov, c, newDate, "ככה", false, noopDeps);
  const rNull = await replyDefer(dov, c, newDate, undefined, null, noopDeps);

  check("reasonJudgedPlausible=true מגיע ל-Policy Engine ומאשר (executed)", rTrue.status === "executed", rTrue.status);
  check("reasonJudgedPlausible=false מגיע ל-Policy Engine ומעביר למוטי", rFalse.status === "manager_approval_required", rFalse.status);
  check("reasonJudgedPlausible=null/חסר מגיע ל-Policy Engine ומברר", rNull.status === "needs_clarification", rNull.status);

  // בדיקה מבנית: chat.ts באמת שולף reasonJudgedPlausible מקלט ה-AI ומעביר אותו ל-replyDefer,
  // ו-input_schema של הכלי באמת מכריז על השדה (לא רק "מבטיח" בתיעוד).
  const chatSrc = fs.readFileSync(new URL("../src/ops/chat.ts", import.meta.url), "utf-8");
  check(
    "input_schema של reply_defer מכריז על reasonJudgedPlausible",
    /reasonJudgedPlausible:\s*\{[^}]*type:\s*"boolean"/.test(chatSrc),
  );
  check(
    "ה-run handler של reply_defer מעביר i.reasonJudgedPlausible ל-replyDefer",
    /replyDefer\(\s*user,\s*c,\s*String\(i\.newDate\),[\s\S]{0,200}i\.reasonJudgedPlausible/.test(chatSrc),
  );
}

cleanupFollowups();

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות ה-replyDefer עברו ✅");
