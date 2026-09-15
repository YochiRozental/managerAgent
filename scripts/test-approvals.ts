/**
 * בדיקות למערכת האישורים למוטי (manager_approvals + approvalActions.ts + notificationBus.ts).
 * DB אמיתי (מקומי, לא Monday) לחלוטין — כל side-effect שיכול לגעת ב-Monday מוזרק/מזוייף.
 *
 *   npm run test:approvals
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { db } from "../src/db/db.js";
import { upsertFinding } from "../src/db/repositories/controlFindings.js";
import { findingEvents } from "../src/db/repositories/findingEvents.js";
import { createApproval, getApproval, type CreateApprovalInput } from "../src/db/repositories/managerApprovals.js";
import { resolveUserByKey } from "../src/identity/index.js";
import {
  approveApproval,
  giveApprovalInstruction,
  rejectApproval,
  type ApprovalDecisionDeps,
} from "../src/ops/approvalActions.js";
import { publishNotificationLive, subscribeNotifications } from "../src/ops/notificationBus.js";
import { replyDefer, type LoopContext } from "../src/ops/loopReply.js";
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
const nowIso = now.toISO()!;
const overdue2d = now.minus({ days: 2 }).toISODate()!;
const newDate5d = now.plus({ days: 5 }).toISODate()!;

const dov = resolveUserByKey("dov")!;
const moti = resolveUserByKey("moti")!;

function makeSpy<TArgs extends unknown[]>() {
  const calls: TArgs[] = [];
  const fn = ((...args: TArgs) => {
    calls.push(args);
  }) as unknown as (...args: TArgs) => unknown;
  return { fn, calls };
}

function cleanup(): void {
  db.exec(
    `DELETE FROM manager_approval_messages WHERE approval_id IN (SELECT id FROM manager_approvals WHERE item_id LIKE '%__appr_%')`,
  );
  db.exec(`DELETE FROM manager_approvals WHERE item_id LIKE '%__appr_%'`);
  db.exec(`DELETE FROM control_followups WHERE item_id LIKE '%__appr_%'`);
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '%__appr_%'`);
  db.exec(`DELETE FROM control_findings WHERE item_id LIKE '%__appr_%'`);
  db.exec(`DELETE FROM notifications WHERE item_id LIKE '%__appr_%'`);
}
cleanup();

function seedFinding(itemId: string): string {
  const findingKey = `overdue:${itemId}`;
  upsertFinding({
    findingKey,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: "בדיקת אישורים",
    detail: "בדיקה",
    itemId,
    itemSource: "general",
    dueDate: overdue2d,
    now: nowIso,
  });
  return findingKey;
}

function defaultPayload(overrides: Record<string, unknown> = {}) {
  return {
    oldDueDate: overdue2d,
    requestedNewDueDate: newDate5d,
    reason: "בדיקה",
    priorDeferrals: { beforeOverdue: 0, afterOverdue: 1 },
    ruleId: "after-overdue-long",
    wasOverdue: true,
    ...overrides,
  };
}

/** יוצר Approval אמיתי (דרך createApproval האמיתי) על פריט חדש, בלי לעבור דרך replyDefer. */
function seedApproval(itemId: string, payloadOverrides: Record<string, unknown> = {}) {
  const findingKey = seedFinding(itemId);
  const { approval } = createApproval({
    kind: "deferral",
    requestedBy: "dov",
    managerUserKey: "moti",
    findingKey,
    itemId,
    itemSource: "general",
    taskName: "בדיקת אישורים",
    payload: defaultPayload(payloadOverrides),
  });
  return approval;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. manager_approval_required יוצר Approval persistent
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 1. Approval persistent ──");
{
  const a = seedApproval("__appr_persist__");
  // "restart" מדומה: לא משתמשים באובייקט שהוחזר — קוראים מחדש מה-DB לפי id בלבד.
  const reread = getApproval(a.id);
  check(
    "Approval נשמר ונקרא מחדש מה-DB אחרי restart מדומה",
    reread !== null && reread.status === "pending" && reread.itemId === "__appr_persist__" && reread.managerUserKey === "moti",
    JSON.stringify(reread),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. אותה בקשה פעמיים לא יוצרת כפילות
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 2. אין כפילויות ──");
{
  const itemId = "__appr_dup__";
  const findingKey = seedFinding(itemId);
  const input: CreateApprovalInput = {
    kind: "deferral",
    requestedBy: "dov",
    managerUserKey: "moti",
    findingKey,
    itemId,
    itemSource: "general",
    taskName: "בדיקה",
    payload: defaultPayload(),
  };
  const r1 = createApproval(input);
  const r2 = createApproval(input);
  check("קריאה ראשונה יוצרת Approval", r1.created === true);
  check("קריאה שנייה זהה מחזירה את אותו Approval, לא יוצרת כפילות", r2.created === false && r2.approval.id === r1.approval.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. approve — Monday פעם אחת, finding_events, notification לעובד
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 3. approve ──");
{
  const a = seedApproval("__appr_approve__");
  const setTaskDueDateSpy = makeSpy<[string, string, string]>();
  const addTaskNoteSpy = makeSpy();
  const updateTaskSpy = makeSpy();
  const addNotificationSpy = makeSpy<[string, string, string, string?, unknown?]>();

  const deps: ApprovalDecisionDeps = {
    setTaskDueDate: async (...args: unknown[]) => { setTaskDueDateSpy.fn(...(args as [string, string, string])); },
    addTaskNote: async (...args: unknown[]) => { addTaskNoteSpy.fn(...args); },
    updateTask: async (...args: unknown[]) => { updateTaskSpy.fn(...args); return undefined as never; },
    addNotification: (...args: unknown[]) => {
      addNotificationSpy.fn(...(args as [string, string, string, string?, unknown?]));
      return 1;
    },
  };

  const result = await approveApproval(moti, a.id, "מאשר", deps);
  check("approve מצליח (ok:true)", result.ok === true);
  check("setTaskDueDate נקרא פעם אחת עם התאריך המבוקש", setTaskDueDateSpy.calls.length === 1 && setTaskDueDateSpy.calls[0]![2] === newDate5d);
  check("addTaskNote נקרא (מתעד שאושר ע\"י מוטי)", addTaskNoteSpy.calls.length === 1);

  const reread = getApproval(a.id)!;
  check(
    "Approval מסומן approved, decidedAt/decisionBy/executionStatus נשמרו",
    reread.status === "approved" && !!reread.decidedAt && reread.decisionBy === "moti" && reread.executionStatus === "executed",
    JSON.stringify(reread),
  );

  const events = findingEvents(a.findingKey!).map((e) => e.event);
  check("נרשם manager_approval_approved", events.includes("manager_approval_approved"));
  check("נרשם snoozed (הבקרה יודעת לא להסלים עד המועד החדש)", events.includes("snoozed"));

  check(
    "נשלחה notification לעובד שביקש (dov), לא למוטי",
    addNotificationSpy.calls.length === 1 && addNotificationSpy.calls[0]![0] === "dov" && addNotificationSpy.calls[0]![1] === "manager_decision",
  );
  check("ל-approve מוחזר אובייקט Approval מלא (id מספרי), לא רק טקסט", result.ok && typeof result.approval.id === "number");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. double approve — Monday נקרא רק פעם אחת
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 4. double approve ──");
{
  const a = seedApproval("__appr_double__");
  let mondayCalls = 0;
  const deps: ApprovalDecisionDeps = {
    setTaskDueDate: async () => {
      mondayCalls++;
    },
    addTaskNote: async () => {},
    updateTask: async () => undefined as never,
    addNotification: () => 1,
  };

  // שתי קריאות "כמעט בו-זמנית" — בלי await בין היצירה של השתיים, כדי לחקות דאבל-קליק אמיתי.
  const p1 = approveApproval(moti, a.id, undefined, deps);
  const p2 = approveApproval(moti, a.id, undefined, deps);
  const [r1, r2] = await Promise.all([p1, p2]);

  const results = [r1, r2];
  const succeeded = results.filter((r) => r.ok);
  const failedOnes = results.filter((r) => !r.ok);
  check("בדיוק קריאה אחת הצליחה מתוך שתי קריאות מקבילות", succeeded.length === 1);
  check(
    "הקריאה השנייה קיבלה already_decided",
    failedOnes.length === 1 && !failedOnes[0]!.ok && failedOnes[0]!.code === "already_decided",
  );
  check("Monday נקרא בדיוק פעם אחת, לא פעמיים", mondayCalls === 1, String(mondayCalls));
  check("Approval הסופי במצב approved (לא נתקע ב-approving)", getApproval(a.id)!.status === "approved");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. reject — לא נוגע ב-Monday, העובד מקבל notification, הממצא נשאר פתוח
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 5. reject ──");
{
  const a = seedApproval("__appr_reject__");
  const setTaskDueDateSpy = makeSpy();
  const addNotificationSpy = makeSpy<[string, string, string, string?, unknown?]>();
  const deps: ApprovalDecisionDeps = {
    setTaskDueDate: async (...args: unknown[]) => { setTaskDueDateSpy.fn(...args); },
    addNotification: (...args: unknown[]) => {
      addNotificationSpy.fn(...(args as [string, string, string, string?, unknown?]));
      return 1;
    },
  };

  const result = await rejectApproval(moti, a.id, "לא הפעם", deps);
  check("reject מצליח", result.ok === true);
  check("Monday לא נקרא", setTaskDueDateSpy.calls.length === 0);
  check("Approval מסומן rejected, decidedAt/decisionBy נשמרו", getApproval(a.id)!.status === "rejected" && !!getApproval(a.id)!.decidedAt);
  check("העובד (dov) מקבל notification", addNotificationSpy.calls.length === 1 && addNotificationSpy.calls[0]![0] === "dov");

  const events = findingEvents(a.findingKey!).map((e) => e.event);
  check("נרשם manager_approval_rejected", events.includes("manager_approval_rejected"));
  check(
    "הממצא נשאר פתוח — אין resolved_by_reply ואין snoozed",
    !events.includes("resolved_by_reply") && !events.includes("snoozed"),
    JSON.stringify(events),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. instruction — נשמר, worker notification, לא נוגע ב-Monday, נשאר actionable
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 6. instruction ──");
{
  const a = seedApproval("__appr_instr__");
  const setTaskDueDateSpy = makeSpy();
  const addNotificationSpy = makeSpy<[string, string, string, string?, unknown?]>();
  const deps: ApprovalDecisionDeps = {
    setTaskDueDate: async (...args: unknown[]) => { setTaskDueDateSpy.fn(...args); },
    addNotification: (...args: unknown[]) => {
      addNotificationSpy.fn(...(args as [string, string, string, string?, unknown?]));
      return 1;
    },
  };

  const result = await giveApprovalInstruction(moti, a.id, "תדבר איתי קודם", deps);
  check("instruction מצליח", result.ok === true);
  check("Monday לא נקרא", setTaskDueDateSpy.calls.length === 0);
  const reread = getApproval(a.id)!;
  check("Approval במצב pending_instruction, ההנחיה נשמרה", reread.status === "pending_instruction" && reread.decisionNote === "תדבר איתי קודם");
  check(
    "worker notification נוצר עם תוכן ההנחיה",
    addNotificationSpy.calls.length === 1 && addNotificationSpy.calls[0]![0] === "dov" && addNotificationSpy.calls[0]![2].includes("תדבר איתי קודם"),
  );

  // עדיין actionable: אפשר עדיין לאשר/לדחות אחרי הנחיה (לא סופי).
  const approveDeps: ApprovalDecisionDeps = {
    setTaskDueDate: async () => {},
    addTaskNote: async () => {},
    updateTask: async () => undefined as never,
    addNotification: () => 1,
  };
  const followUp = await approveApproval(moti, a.id, undefined, approveDeps);
  check("ה-Approval עדיין actionable אחרי instruction — ניתן לאשר בהמשך", followUp.ok === true);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. כשל Monday בזמן approve
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 7. כשל Monday בזמן approve ──");
{
  const a = seedApproval("__appr_fail__");
  const addNotificationSpy = makeSpy();
  const failDeps: ApprovalDecisionDeps = {
    setTaskDueDate: async () => {
      throw new Error("Monday API down (מדומה)");
    },
    addNotification: (...args: unknown[]) => {
      addNotificationSpy.fn(...args);
      return 1;
    },
  };

  const result = await approveApproval(moti, a.id, undefined, failDeps);
  check("approve מחזיר execution_failed", !result.ok && result.code === "execution_failed", JSON.stringify(result));

  const reread = getApproval(a.id)!;
  check(
    "Approval לא מסומן approved — חוזר ל-pending, execution_status=failed, error נשמר",
    reread.status === "pending" && reread.executionStatus === "failed" && !!reread.executionError,
    JSON.stringify(reread),
  );
  check("העובד לא קיבל שום notification (לא 'אושר')", addNotificationSpy.calls.length === 0);

  // ניתן לנסות שוב — ה-claim לא נתקע כי revertAfterFailure מחזיר ל-pending.
  const setTaskDueDateSpy2 = makeSpy();
  const retryDeps: ApprovalDecisionDeps = {
    setTaskDueDate: async (...args: unknown[]) => { setTaskDueDateSpy2.fn(...args); },
    addTaskNote: async () => {},
    updateTask: async () => undefined as never,
    addNotification: () => 1,
  };
  const retry = await approveApproval(moti, a.id, undefined, retryDeps);
  check("ניסיון חוזר אחרי כשל מצליח", retry.ok === true && setTaskDueDateSpy2.calls.length === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. הרשאות: לא-מוטי לא יכול להכריע; מוטי לא יכול לאשר בקשה של עצמו
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 8. הרשאות ──");
{
  const a = seedApproval("__appr_auth__");
  const result = await approveApproval(dov, a.id, undefined, {});
  check("עובד רגיל (dov) לא יכול להכריע — forbidden", !result.ok && result.code === "forbidden", JSON.stringify(result));
  check("ה-Approval נשאר pending", getApproval(a.id)!.status === "pending");

  const rejectByDov = await rejectApproval(dov, a.id, undefined, {});
  check("גם reject חסום לעובד רגיל", !rejectByDov.ok && rejectByDov.code === "forbidden");
}
{
  const itemId = "__appr_self__";
  const findingKey = seedFinding(itemId);
  const { approval } = createApproval({
    kind: "deferral",
    requestedBy: "moti",
    managerUserKey: "moti",
    findingKey,
    itemId,
    itemSource: "general",
    taskName: "בדיקה",
    payload: defaultPayload(),
  });
  const result = await approveApproval(moti, approval.id, undefined, {});
  check("מוטי לא יכול לאשר בקשה שהוא עצמו ביקש", !result.ok && result.code === "self_approval", JSON.stringify(result));
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. SSE — approval מגיע רק למוטי (userKey filtering) · 10. ה-payload מובנה (approvalId), לא טקסט חופשי
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 9+10. SSE ל-manager בלבד, ו-payload מובנה ──");
{
  const receivedByMoti: { context: unknown }[] = [];
  const receivedByDov: { context: unknown }[] = [];
  const unsub1 = subscribeNotifications((n) => {
    if (n.userKey === "moti") receivedByMoti.push(n);
  });
  const unsub2 = subscribeNotifications((n) => {
    if (n.userKey === "dov") receivedByDov.push(n);
  });

  publishNotificationLive({
    userKey: "moti",
    id: 999999,
    kind: "approval_request",
    body: "בדיקה",
    findingKey: null,
    itemId: null,
    itemSource: null,
    context: { approvalId: 999999 },
    createdAt: nowIso,
  });
  check("פרסום ל-moti מגיע ל-listener של moti בלבד", receivedByMoti.length === 1 && receivedByDov.length === 0);
  check(
    "ה-payload נושא approvalId מספרי במבנה נתונים, לא רק טקסט חופשי בגוף ההודעה",
    typeof (receivedByMoti[0]!.context as { approvalId?: number }).approvalId === "number",
  );
  unsub1();
  unsub2();

  // מקצה-לקצה: replyDefer עצמו (לא רק publishNotificationLive הידני) מפרסם רק ל-moti.
  const liveEvents: { userKey: string; kind: string; context: unknown }[] = [];
  const unsub3 = subscribeNotifications((n) => liveEvents.push(n));
  const itemId = "__appr_sse__";
  const findingKey = seedFinding(itemId);
  const c: LoopContext = { itemId, source: "general", findingKey, taskName: "בדיקת SSE", currentDueDateISO: overdue2d };
  await replyDefer(dov, c, now.plus({ days: 10 }).toISODate()!, "בדיקה", true); // 10 ימים → תמיד manager_approval_required
  unsub3();

  check("replyDefer פרסם אירוע SSE אחד בדיוק, למוטי בלבד", liveEvents.length === 1 && liveEvents[0]!.userKey === "moti");
  check("קינד ה-SSE הוא approval_request", liveEvents[0]!.kind === "approval_request");
  check(
    "ה-context של האירוע החי נושא approvalId מספרי (לא רק body טקסטואלי)",
    typeof (liveEvents[0]!.context as { approvalId?: number }).approvalId === "number",
  );
}

cleanup();

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות מערכת האישורים עברו ✅");
