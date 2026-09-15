/**
 * סגירת פער ה-Audit (2026-09-14): תשובת עובד לשאלה/הנחיה של מוטי מתוך Approval חוזרת אליו,
 * נשמרת בהיסטוריה, ומחזירה את ה-Approval ל-pending. DB אמיתי (מקומי), אפס Monday אמיתי.
 *
 *   npm run test:approval-conversation
 */

import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { db } from "../src/db/db.js";
import { upsertFinding } from "../src/db/repositories/controlFindings.js";
import { findingEvents } from "../src/db/repositories/findingEvents.js";
import { listApprovalMessages } from "../src/db/repositories/approvalMessages.js";
import { createApproval, getApproval } from "../src/db/repositories/managerApprovals.js";
import { resolveUserByKey } from "../src/identity/index.js";
import {
  approveApproval,
  getApprovalWithMessages,
  giveApprovalInstruction,
  replyToApprovalInstruction,
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
const newDate10d = now.plus({ days: 10 }).toISODate()!;
const dov = resolveUserByKey("dov")!;
const eitan = resolveUserByKey("eitan")!;
const moti = resolveUserByKey("moti")!;

function makeSpy<TArgs extends unknown[]>() {
  const calls: TArgs[] = [];
  const fn = ((...args: TArgs) => {
    calls.push(args);
  }) as unknown as (...args: TArgs) => unknown;
  return { fn, calls };
}

function cleanup(): void {
  const ids = db.prepare(`SELECT id FROM manager_approvals WHERE item_id LIKE '%__conv_%'`).all() as { id: number }[];
  for (const { id } of ids) db.exec(`DELETE FROM manager_approval_messages WHERE approval_id = ${id}`);
  db.exec(`DELETE FROM manager_approvals WHERE item_id LIKE '%__conv_%'`);
  db.exec(`DELETE FROM control_followups WHERE item_id LIKE '%__conv_%'`);
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '%__conv_%'`);
  db.exec(`DELETE FROM control_findings WHERE item_id LIKE '%__conv_%'`);
  db.exec(`DELETE FROM notifications WHERE item_id LIKE '%__conv_%'`);
}
cleanup();

function seedFinding(itemId: string): string {
  const findingKey = `overdue:${itemId}`;
  upsertFinding({
    findingKey,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: "בדיקת שיחת אישור",
    detail: "בדיקה",
    itemId,
    itemSource: "general",
    dueDate: overdue2d,
    now: nowIso,
  });
  return findingKey;
}

function seedApproval(itemId: string) {
  const findingKey = seedFinding(itemId);
  const { approval } = createApproval({
    kind: "deferral",
    requestedBy: "dov",
    managerUserKey: "moti",
    findingKey,
    itemId,
    itemSource: "general",
    taskName: "תוכנית חשמל",
    payload: {
      oldDueDate: overdue2d,
      requestedNewDueDate: newDate10d,
      reason: "צריך עוד זמן",
      priorDeferrals: { beforeOverdue: 0, afterOverdue: 0 },
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
// 1+2. מוטי שולח instruction → נשמר message של manager, worker notification כולל approvalId
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 1+2. instruction → message + notification עם approvalId ──");
let convA: ReturnType<typeof seedApproval>;
{
  convA = seedApproval("__conv_flow__");
  const notifSpy = makeSpy<[string, string, string, string?, { itemId?: string; itemSource?: string; context: Record<string, unknown> }?]>();
  const result = await giveApprovalInstruction(moti, convA.id, "למה אתה צריך 10 ימים?", {
    addNotification: (...args: unknown[]) => {
      notifSpy.fn(...(args as [string, string, string, string?, { itemId?: string; itemSource?: string; context: Record<string, unknown> }?]));
      return 1;
    },
  });
  check("giveApprovalInstruction מצליח", result.ok === true);

  const msgs = listApprovalMessages(convA.id);
  check("נשמר message יחיד של manager", msgs.length === 1 && msgs[0]!.senderRole === "manager" && msgs[0]!.message === "למה אתה צריך 10 ימים?");

  check("worker notification נשלח", notifSpy.calls.length === 1 && notifSpy.calls[0]![0] === "dov");
  const ctx = notifSpy.calls[0]![4]!.context;
  check(
    "ה-notification כולל approvalId/findingKey/itemId/kind/interactionType (מובנה, לא רק טקסט)",
    ctx.approvalId === convA.id &&
      ctx.findingKey === convA.findingKey &&
      ctx.itemId === convA.itemId &&
      ctx.kind === "deferral" &&
      ctx.interactionType === "approval_instruction",
    JSON.stringify(ctx),
  );
  check("Approval במצב pending_instruction", getApproval(convA.id)!.status === "pending_instruction");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3+4. העובד הנכון עונה → נשמר message של employee, Approval חוזר ל-pending
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 3+4. תשובת העובד הנכון ──");
{
  const beforeCount = (db.prepare(`SELECT count(*) c FROM manager_approvals WHERE item_id = ?`).get(convA.itemId) as { c: number }).c;

  const result = await replyToApprovalInstruction(dov, convA.id, "כי הלקוח שינה את כל החלוקה.", okDeps());
  check("replyToApprovalInstruction מצליח", result.ok === true, JSON.stringify(result));

  const msgs = listApprovalMessages(convA.id);
  check(
    "נשמר message של employee, אחרי הודעת המנהל",
    msgs.length === 2 && msgs[1]!.senderRole === "employee" && msgs[1]!.message === "כי הלקוח שינה את כל החלוקה.",
    JSON.stringify(msgs),
  );
  check("Approval חוזר ל-pending ('הכדור אצל מוטי')", getApproval(convA.id)!.status === "pending");

  // 12. לא נוצר Approval נוסף על אותה משימה
  const afterCount = (db.prepare(`SELECT count(*) c FROM manager_approvals WHERE item_id = ?`).get(convA.itemId) as { c: number }).c;
  check("תשובת worker לא יוצרת Approval נוסף", afterCount === beforeCount, `before=${beforeCount} after=${afterCount}`);

  // 10. לא נוגע ב-Monday — גם אם מזריקים spy ל-setTaskDueDate, replyToApprovalInstruction לא קורא לו בכלל
  const mondaySpy = makeSpy();
  await replyToApprovalInstruction(dov, convA.id, "עוד תשובה", { ...okDeps(), setTaskDueDate: async (...a: unknown[]) => { mondaySpy.fn(...a); } });
  check("תשובת worker לעולם לא קוראת ל-setTaskDueDate", mondaySpy.calls.length === 0);

  // 11. לא סוגרת finding — אין resolved_by_reply/snoozed, רק employee_responded
  const events = findingEvents(convA.findingKey!).map((e) => e.event);
  check(
    "תשובת worker לא סוגרת את הממצא (אין resolved_by_reply/snoozed, יש employee_responded)",
    events.includes("employee_responded") && !events.includes("resolved_by_reply") && !events.includes("snoozed"),
    JSON.stringify(events),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. מוטי מקבל live event עם תשובת העובד
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 5. live event למוטי ──");
{
  const a = seedApproval("__conv_live__");
  await giveApprovalInstruction(moti, a.id, "פרטים בבקשה", okDeps());

  const seenByMoti: unknown[] = [];
  const seenByDov: unknown[] = [];
  const u1 = subscribeNotifications((n) => {
    if (n.userKey === "moti") seenByMoti.push(n);
  });
  const u2 = subscribeNotifications((n) => {
    if (n.userKey === "dov") seenByDov.push(n);
  });
  await replyToApprovalInstruction(dov, a.id, "תשובה חיה", okDeps());
  u1();
  u2();
  check("מוטי מקבל live event אחד עם תשובת העובד, לא העובד עצמו", seenByMoti.length === 1 && seenByDov.length === 0);
  const evt = seenByMoti[0] as { kind: string; context: { interactionType?: string; approvalId?: number } };
  check(
    "האירוע החי מסוג approval_reply עם approvalId מובנה",
    evt.kind === "approval_reply" && evt.context.interactionType === "approval_reply" && evt.context.approvalId === a.id,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Approval card API data — כל היסטוריית ההודעות
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 6. getApprovalWithMessages (מה ש-GET /api/approvals מחזיר) ──");
{
  const withMsgs = getApprovalWithMessages(convA.id);
  check(
    "מחזיר את כל היסטוריית ההודעות של ה-Approval, לפי סדר",
    !!withMsgs && withMsgs.messages.length === 2 && withMsgs.messages[0]!.senderRole === "manager" && withMsgs.messages[1]!.senderRole === "employee",
    JSON.stringify(withMsgs?.messages),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7+8. אבטחה: worker אחר → forbidden; approvalId לא קיים → not_found
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 7+8. אבטחה ──");
{
  const a = seedApproval("__conv_security__");
  await giveApprovalInstruction(moti, a.id, "שאלה", okDeps());

  const wrongWorker = await replyToApprovalInstruction(eitan, a.id, "זו לא הבקשה שלי", okDeps());
  check("עובד אחר (איתן) מנסה לענות על approval של דוב → forbidden", !wrongWorker.ok && wrongWorker.code === "forbidden");
  check("ה-Approval לא השתנה מהניסיון החסום", getApproval(a.id)!.status === "pending_instruction");

  const notFound = await replyToApprovalInstruction(dov, 999999999, "תשובה", okDeps());
  check("approvalId שלא קיים → not_found", !notFound.ok && notFound.code === "not_found");
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Approval שכבר approved/rejected → אי אפשר להוסיף תשובת worker
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 9. Approval כבר הוכרע ──");
{
  const a = seedApproval("__conv_decided__");
  await giveApprovalInstruction(moti, a.id, "שאלה לפני החלטה", okDeps());
  await replyToApprovalInstruction(dov, a.id, "תשובה", okDeps()); // חוזר ל-pending
  const approveResult = await approveApproval(moti, a.id, undefined, okDeps());
  check("האישור עצמו הצליח (הכנה לתרחיש)", approveResult.ok === true);

  const lateReply = await replyToApprovalInstruction(dov, a.id, "תשובה מאוחרת מדי", okDeps());
  check("תשובת worker אחרי approved → נדחית (already_decided), לא נשמרת כרשמית", !lateReply.ok && lateReply.code === "already_decided");
  const msgsAfter = listApprovalMessages(a.id);
  check("התשובה המאוחרת לא נוספה להיסטוריה", !msgsAfter.some((m) => m.message === "תשובה מאוחרת מדי"));
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. יותר מסבב אחד — נשמר לפי הסדר
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 13. כמה סבבים ──");
{
  const a = seedApproval("__conv_multi__");
  await giveApprovalInstruction(moti, a.id, "שאלה 1", okDeps());
  await replyToApprovalInstruction(dov, a.id, "תשובה 1", okDeps());
  await giveApprovalInstruction(moti, a.id, "שאלה 2", okDeps());
  await replyToApprovalInstruction(dov, a.id, "תשובה 2", okDeps());

  const msgs = listApprovalMessages(a.id);
  check(
    "4 הודעות, בסדר הנכון: מנהל-עובד-מנהל-עובד",
    msgs.length === 4 &&
      msgs.map((m) => m.senderRole).join(",") === "manager,employee,manager,employee" &&
      msgs.map((m) => m.message).join("|") === "שאלה 1|תשובה 1|שאלה 2|תשובה 2",
    JSON.stringify(msgs.map((m) => [m.senderRole, m.message])),
  );
  check("Approval חוזר ל-pending אחרי הסבב השני", getApproval(a.id)!.status === "pending");
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. refresh/restart לא מאבד את היסטוריית השיחה
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 14. persistence אחרי restart ──");
{
  const a = seedApproval("__conv_restart__");
  await giveApprovalInstruction(moti, a.id, "שאלה לפני restart", okDeps());
  await replyToApprovalInstruction(dov, a.id, "תשובה לפני restart", okDeps());

  const fresh = new DatabaseSync("data/agent.db", { readOnly: true });
  const rows = fresh.prepare(`SELECT * FROM manager_approval_messages WHERE approval_id = ? ORDER BY id ASC`).all(a.id) as {
    sender_role: string;
    message: string;
  }[];
  fresh.close();
  check(
    "היסטוריית השיחה נקראת מחיבור SQLite חדש (persistence אמיתי, לא זיכרון)",
    rows.length === 2 && rows[0]!.sender_role === "manager" && rows[1]!.sender_role === "employee",
    JSON.stringify(rows),
  );
}

cleanup();

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות שיחת האישור עברו ✅");
