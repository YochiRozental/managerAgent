/**
 * Audit 2026-09-14 — בדיקות ממוקדות לממצאים שנמצאו בביקורת מערכת האישורים:
 *   1. persistence אמיתי (חיבור SQLite טרי, לא מטמון זיכרון) — pending וגם pending_instruction.
 *   2. שחזור אחרי קריסה שהשאירה approval תקוע ב-'approving'.
 *   3. בידוד כשלים: setTaskDueDate מצליח אבל addTaskNote/finding_event/notification נכשלים —
 *      בשלושת המקרים ה-approve חייב להישאר "approved", לא stuck, לא retriable.
 *   4. retry אחרי הצלחה מלאה (refresh / timeout-retry / לשונית שנייה) — לא Monday פעמיים.
 *   5. אין זליגת SSE בין משתמשים (שני הכיוונים).
 *   6. kind לא-נתמך (cancellation/reassignment) → unsupported_kind נקי, בלי claim/Monday.
 *
 * DB אמיתי (מקומי), אפס Monday אמיתי.
 *
 *   npm run test:approvals-audit
 */

import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { db } from "../src/db/db.js";
import { upsertFinding } from "../src/db/repositories/controlFindings.js";
import {
  claimApproval,
  createApproval,
  getApproval,
  recoverStuckApprovals,
} from "../src/db/repositories/managerApprovals.js";
import { resolveUserByKey } from "../src/identity/index.js";
import {
  approveApproval,
  giveApprovalInstruction,
  type ApprovalDecisionDeps,
} from "../src/ops/approvalActions.js";
import { subscribeNotifications } from "../src/ops/notificationBus.js";
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
    `DELETE FROM manager_approval_messages WHERE approval_id IN (SELECT id FROM manager_approvals WHERE item_id LIKE '%__audit_%')`,
  );
  db.exec(`DELETE FROM manager_approvals WHERE item_id LIKE '%__audit_%'`);
  db.exec(`DELETE FROM control_followups WHERE item_id LIKE '%__audit_%'`);
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '%__audit_%'`);
  db.exec(`DELETE FROM control_findings WHERE item_id LIKE '%__audit_%'`);
  db.exec(`DELETE FROM notifications WHERE item_id LIKE '%__audit_%'`);
}
cleanup();

function seedFinding(itemId: string): string {
  const findingKey = `overdue:${itemId}`;
  upsertFinding({
    findingKey,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: "בדיקת audit אישורים",
    detail: "בדיקה",
    itemId,
    itemSource: "general",
    dueDate: overdue2d,
    now: nowIso,
  });
  return findingKey;
}

function seedApproval(itemId: string, kind: "deferral" | "cancellation" = "deferral") {
  const findingKey = seedFinding(itemId);
  const { approval } = createApproval({
    kind,
    requestedBy: "dov",
    managerUserKey: "moti",
    findingKey,
    itemId,
    itemSource: "general",
    taskName: "בדיקת audit",
    payload: {
      oldDueDate: overdue2d,
      requestedNewDueDate: newDate5d,
      reason: "בדיקה",
      priorDeferrals: { beforeOverdue: 0, afterOverdue: 1 },
      ruleId: "after-overdue-long",
      wasOverdue: true,
    },
  });
  return approval;
}

const okDeps = (): ApprovalDecisionDeps => ({
  setTaskDueDate: async () => {},
  addTaskNote: async () => {},
  updateTask: async () => undefined as never,
  addNotification: () => 1,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Persistence אמיתי — חיבור SQLite טרי (לא אותו handle) לאותו קובץ
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 1. Persistence אחרי restart (חיבור טרי) ──");
{
  const a = seedApproval("__audit_persist__");
  const fresh = new DatabaseSync("data/agent.db", { readOnly: true });
  const row = fresh.prepare("SELECT * FROM manager_approvals WHERE id = ?").get(a.id) as
    | { status: string; item_id: string; manager_user_key: string }
    | undefined;
  fresh.close();
  check(
    "pending נקרא מחיבור SQLite חדש לגמרי (לא מטמון תהליך) — מוכיח persistence אמיתי, לא רק in-memory",
    !!row && row.status === "pending" && row.item_id === "__audit_persist__" && row.manager_user_key === "moti",
    JSON.stringify(row),
  );
}
{
  const a = seedApproval("__audit_persist_instr__");
  await giveApprovalInstruction(moti, a.id, "תדבר איתי קודם", okDeps());
  const fresh = new DatabaseSync("data/agent.db", { readOnly: true });
  const row = fresh.prepare("SELECT * FROM manager_approvals WHERE id = ?").get(a.id) as
    | { status: string; decision_note: string }
    | undefined;
  fresh.close();
  check(
    "pending_instruction גם נשמר ונקרא מחדש מחיבור טרי",
    !!row && row.status === "pending_instruction" && row.decision_note === "תדבר איתי קודם",
    JSON.stringify(row),
  );
}
// GET /api/approvals (server/index.ts) קורא listApprovalsForManager שהוא db.prepare(...).all()
// ישיר מול אותו db singleton — אין שכבת cache באמצע. מאומת בקריאת קוד + בעקיפין ע"י הבדיקה למעלה
// (אותה תשתית קריאה בדיוק).

// ─────────────────────────────────────────────────────────────────────────────
// 2. שחזור אחרי קריסה שהשאירה approval תקוע ב-'approving'
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 2. שחזור approval תקוע ב-approving ──");
{
  const a = seedApproval("__audit_stuck__");
  // מדמים קריסה בדיוק אחרי claim: קוראים ל-claimApproval ישירות ולא ממשיכים אף שלב נוסף.
  const claimed = claimApproval(a.id);
  check("claim תפס — הממצא כרגע 'approving' (מדמה תהליך שקרס בדיוק כאן)", claimed && getApproval(a.id)!.status === "approving");

  const whileStuck = await approveApproval(moti, a.id, undefined, okDeps());
  check("בזמן שהוא תקוע — אף אחד לא יכול להכריע בו (already_decided, לא claim כפול)", !whileStuck.ok && whileStuck.code === "already_decided");

  const recovered = recoverStuckApprovals();
  check("recoverStuckApprovals מוצא ומשחזר לפחות שורה אחת", recovered >= 1, String(recovered));
  const reread = getApproval(a.id)!;
  check(
    "אחרי שחזור — חוזר ל-pending עם execution_error גלוי (לא נמחק, לא מנחש הצלחה)",
    reread.status === "pending" && reread.executionStatus === "failed" && !!reread.executionError,
    JSON.stringify(reread),
  );

  const retry = await approveApproval(moti, a.id, undefined, okDeps());
  check("אחרי שחזור — ניתן להכריע בו שוב בהצלחה (לא נעול לצמיתות)", retry.ok === true);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. בידוד כשלים — הפעולה הקריטית הצליחה, שלב נלווה נכשל
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 3. בידוד כשלים אחרי setTaskDueDate מוצלח ──");
{
  // 3א: addTaskNote נכשל
  const a = seedApproval("__audit_notefail__");
  const setSpy = makeSpy();
  const deps: ApprovalDecisionDeps = {
    setTaskDueDate: async (...args: unknown[]) => { setSpy.fn(...args); },
    addTaskNote: async () => {
      throw new Error("Monday create_update נכשל (מדומה — בדיוק כמו שקרה בפועל בבדיקה קודמת)");
    },
    updateTask: async () => undefined as never,
    addNotification: () => 1,
  };
  const result = await approveApproval(moti, a.id, undefined, deps);
  check("approve מצליח (ok:true) גם כש-addTaskNote נכשל אחרי setTaskDueDate", result.ok === true, JSON.stringify(result));
  check("Approval מסומן approved — לא נשאר תקוע ולא חוזר ל-pending", getApproval(a.id)!.status === "approved");
  const retry = await approveApproval(moti, a.id, undefined, deps);
  check(
    "ניסיון נוסף על אותו approval לא מריץ setTaskDueDate שוב (כבר approved → already_decided)",
    !retry.ok && retry.code === "already_decided" && setSpy.calls.length === 1,
  );
}
{
  // 3ב: recordFindingEvent (DB מקומי) נכשל
  const a = seedApproval("__audit_eventfail__");
  const deps: ApprovalDecisionDeps = {
    ...okDeps(),
    recordFindingEvent: () => {
      throw new Error("DB error מדומה");
    },
  };
  const result = await approveApproval(moti, a.id, undefined, deps);
  check("approve מצליח גם כש-recordFindingEvent זורק", result.ok === true, JSON.stringify(result));
  check("Approval נשאר approved — לא חוזר ל-pending כאילו אפשר לבצע מחדש", getApproval(a.id)!.status === "approved");
}
{
  // 3ג: notification לעובד נכשל
  const a = seedApproval("__audit_notiffail__");
  const deps: ApprovalDecisionDeps = {
    ...okDeps(),
    addNotification: () => {
      throw new Error("notification DB error מדומה");
    },
  };
  const result = await approveApproval(moti, a.id, undefined, deps);
  check("approve מצליח (ok:true) גם כש-addNotification זורק — לא הופך את האישור לכישלון", result.ok === true, JSON.stringify(result));
  check("Approval נשאר approved", getApproval(a.id)!.status === "approved");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. retry אחרי הצלחה מלאה — refresh / timeout-retry / לשונית שנייה של מוטי
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 4. retry אחרי הצלחה (לא רק double-click) ──");
{
  const a = seedApproval("__audit_retry__");
  let mondayCalls = 0;
  const deps: ApprovalDecisionDeps = { ...okDeps(), setTaskDueDate: async () => { mondayCalls++; } };

  const first = await approveApproval(moti, a.id, undefined, deps);
  check("קריאה ראשונה מצליחה במלואה", first.ok === true);

  // "אותו POST חוזר אחרי timeout" / "refresh אחרי אישור" / "לשונית שנייה" — כולם, מבחינת השרת,
  // בדיוק אותה קריאה שנייה ל-approveApproval על approvalId שכבר טופל.
  const second = await approveApproval(moti, a.id, undefined, deps);
  check(
    "קריאה שנייה על approvalId שכבר אושר — already_decided, Monday לא נקרא שוב",
    !second.ok && second.code === "already_decided" && mondayCalls === 1,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SSE — אין זליגה בין משתמשים, שני הכיוונים
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 5. SSE: אין זליגה בין משתמשים ──");
{
  const seenByMoti: unknown[] = [];
  const seenByDov: unknown[] = [];
  const u1 = subscribeNotifications((n) => {
    if (n.userKey === "moti") seenByMoti.push(n);
  });
  const u2 = subscribeNotifications((n) => {
    if (n.userKey === "dov") seenByDov.push(n);
  });
  const a = seedApproval("__audit_sse_leak__");
  await approveApproval(moti, a.id, undefined, okDeps());
  u1();
  u2();
  check(
    "החלטת approve מפורסמת לעובד (dov) שביקש — לא חוזרת גם למוטי עצמו",
    seenByDov.length === 1 && seenByMoti.length === 0,
    `dov=${seenByDov.length} moti=${seenByMoti.length}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. kind לא-נתמך — unsupported_kind נקי, בלי claim/Monday
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 6. kind לא-נתמך (cancellation) ──");
{
  const a = seedApproval("__audit_kind__", "cancellation");
  const setSpy = makeSpy();
  const deps: ApprovalDecisionDeps = { ...okDeps(), setTaskDueDate: async (...args: unknown[]) => { setSpy.fn(...args); } };
  const result = await approveApproval(moti, a.id, undefined, deps);
  check("kind='cancellation' → unsupported_kind, לא claim ולא Monday", !result.ok && result.code === "unsupported_kind" && setSpy.calls.length === 0);
  check("ה-Approval נשאר pending (claim מעולם לא נעשה)", getApproval(a.id)!.status === "pending");
}

cleanup();

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות ה-Audit עברו ✅");
