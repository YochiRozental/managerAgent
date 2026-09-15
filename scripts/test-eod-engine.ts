/**
 * EOD Engine (2026-09-16) על גבי ה-Follow-up Engine הקיים — שני תרחישים:
 *   A. "אסיים היום" (end_of_day_check).
 *   B. אי-מענה לפניית בקרה (Rule 18: no_response_reminder → end_of_day_no_response → מוטי).
 * DB אמיתי (מקומי), אפס Monday אמיתי.
 *
 *   npm run test:eod-engine
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../src/config/env.js";
import { db } from "../src/db/db.js";
import { upsertFinding } from "../src/db/repositories/controlFindings.js";
import { recordFindingEvent as realRecordFindingEvent, isResolvedByReply } from "../src/db/repositories/findingEvents.js";
import { getFollowup, listFollowups, recoverStuckFollowups } from "../src/db/repositories/controlFollowups.js";
import { listApprovalsForManager } from "../src/db/repositories/managerApprovals.js";
import { resolveUserByKey } from "../src/identity/index.js";
import {
  FOLLOWUP_CONFIG,
  runDueFollowups,
  scheduleCommitmentCheck,
  scheduleEndOfDayCheck,
  type FollowupRunnerDeps,
} from "../src/ops/followups.js";
import { isWithinFollowupWindow } from "../src/ops/scheduler.js";
import {
  replyDefer,
  replyDone,
  replyFinishingToday,
  replyProgress,
  replyWaiting,
  type LoopContext,
  type ReplyDeferDeps,
  type ReplyDoneDeps,
  type ReplyFinishingTodayDeps,
  type SimpleLoopReplyDeps,
} from "../src/ops/loopReply.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const dov = resolveUserByKey("dov")!;
const overdue2d = DateTime.now().setZone(env.TIMEZONE).minus({ days: 2 }).toISODate()!;

function cleanup(): void {
  db.exec(
    `DELETE FROM manager_approval_messages WHERE approval_id IN (SELECT id FROM manager_approvals WHERE item_id LIKE '%__eod_%')`,
  );
  db.exec(`DELETE FROM manager_approvals WHERE item_id LIKE '%__eod_%'`);
  db.exec(`DELETE FROM control_followups WHERE item_id LIKE '%__eod_%'`);
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '%__eod_%'`);
  db.exec(`DELETE FROM control_findings WHERE item_id LIKE '%__eod_%'`);
  db.exec(`DELETE FROM notifications WHERE item_id LIKE '%__eod_%'`);
}
cleanup();

function seedFinding(itemId: string, now: DateTime): string {
  const findingKey = `overdue:${itemId}`;
  upsertFinding({
    findingKey,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: "בדיקת EOD engine",
    detail: "בדיקה",
    itemId,
    itemSource: "general",
    dueDate: overdue2d,
    now: now.toISO()!,
  });
  return findingKey;
}

function baseCtx(itemId: string, findingKey: string, currentDueDateISO: string | null = null, missedCommitment = false): LoopContext {
  return { itemId, source: "general", findingKey, taskName: "בדיקת EOD", currentDueDateISO, missedCommitment };
}

function forceDue(id: number, dueAtUtcIso: string): void {
  db.prepare(`UPDATE control_followups SET due_at = ? WHERE id = ?`).run(dueAtUtcIso, id);
}

/**
 * ספירת נודג'ים/התראות ממוקדת ל-itemId ספציפי בלבד. הכרחי: כל בלוק בקובץ הזה כותב ל-DB אמיתי
 * משותף, ובלוקים שמפורשות עוצרים אחרי "בדיקת יצירה" (למשל בדיקה 6, 11, ולולאת בדיקה 16) משאירים
 * בכוונה שורות pending שנשארות "due" גם מול now של בלוקים מאוחרים יותר (due_at<=now מושווה בלי
 * תלות בתאריך-בלוק) — ספירה גלובלית לא-ממוקדת הייתה נספרת כפילות שלא קשורות לבדיקה הנוכחית.
 */
function scopedNotifSpy(itemId: string): { count: () => number; addNotification: FollowupRunnerDeps["addNotification"] } {
  let n = 0;
  return {
    count: () => n,
    addNotification: (_userKey, _kind, _body, _findingKey, ctx) => {
      if (ctx?.itemId === itemId) n++;
      return 1;
    },
  };
}

function scopedMotiSpy(itemId: string): { lastBody: () => string | null; count: () => number; addNotification: FollowupRunnerDeps["addNotification"] } {
  let n = 0;
  let body: string | null = null;
  return {
    count: () => n,
    lastBody: () => body,
    addNotification: (userKey, _kind, b, _findingKey, ctx) => {
      if (userKey === "moti" && ctx?.itemId === itemId) {
        n++;
        body = b;
      }
      return 1;
    },
  };
}

const okRunnerDeps = (label: string, spies?: { notif?: () => void; nudge?: () => void }): FollowupRunnerDeps => ({
  getTaskStatusLabel: async () => label,
  addNotification: () => {
    spies?.notif?.();
    return 1;
  },
  publishNudge: () => {
    spies?.nudge?.();
  },
});

const noopReplyDeps = (): Pick<ReplyDeferDeps, "setTaskDueDate" | "addTaskNote" | "updateTask"> => ({
  setTaskDueDate: async () => {},
  addTaskNote: async () => {},
  updateTask: async () => undefined as never,
});

const simpleDeps = (): SimpleLoopReplyDeps => ({
  updateTask: async () => ({ ok: true, message: "" }),
  addTaskNote: async () => {},
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. "אסיים היום" → EOD check ב-17:00 Israel (אותו יום)
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 1. replyFinishingToday יוצר end_of_day_check ב-17:00 Israel ──");
{
  const itemId = "__eod_finishing_today__";
  const now = DateTime.now().setZone(env.TIMEZONE);
  const findingKey = seedFinding(itemId, now);
  const c = baseCtx(itemId, findingKey, overdue2d);
  const deps: ReplyFinishingTodayDeps = simpleDeps();
  const result = await replyFinishingToday(dov, c, deps);
  check("replyFinishingToday מצליח", result.ok === true);

  const eod = listFollowups().find((f) => f.itemId === itemId && f.kind === "end_of_day_check");
  check("נוצר end_of_day_check", !!eod);
  const local = eod ? DateTime.fromISO(eod.dueAt, { zone: "utc" }).setZone(env.TIMEZONE) : null;
  check(
    "ה-EOD check קבוע בדיוק ל-17:00 שעון ישראל, אותו יום",
    !!local && local.hour === FOLLOWUP_CONFIG.endOfDay.hour && local.minute === FOLLOWUP_CONFIG.endOfDay.minute && local.toISODate() === now.toISODate(),
    local ? local.toISO()! : "",
  );
  check(
    "התאריך האמיתי (currentDueDateISO) נשמר ב-payload — לא אבד (לא null)",
    !!eod && (eod.payload as { currentDueDateISO?: string | null } | null)?.currentDueDateISO === overdue2d,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2-3. עיבוד ה-EOD check עצמו: בוצע → אין פנייה; פתוח → נשלח נודג' מדויק
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 2. EOD check: המשימה כבר בוצעה → אין פנייה, נסגר בשקט ──");
{
  const itemId = "__eod_already_done__";
  const now = DateTime.now().setZone(env.TIMEZONE);
  const findingKey = seedFinding(itemId, now);
  const f = scheduleEndOfDayCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", taskName: "תוכנית חשמל", currentDueDateISO: overdue2d }, now);
  forceDue(f.id, now.minus({ minutes: 1 }).toUTC().toISO()!);

  let notified = 0;
  const result = await runDueFollowups(now, okRunnerDeps("בוצע", { notif: () => notified++ }));
  check("לא נשלחה שום פנייה לעובד", notified === 0);
  check("outcome completed_done", result.processed.some((p) => p.id === f.id && p.outcome === "completed_done"));
  check("ה-follow-up completed", getFollowup(f.id)!.status === "completed");
  check("ה-finding נסגר (resolved_by_reply) — לא מוטרד מוטי, לא נשאר תחת מעקב", isResolvedByReply(findingKey));
}

logger.info("── 3. EOD check: המשימה עדיין פתוחה → נשלח נודג' מדויק ──");
{
  const itemId = "__eod_still_open__";
  const now = DateTime.now().setZone(env.TIMEZONE);
  const findingKey = seedFinding(itemId, now);
  const f = scheduleEndOfDayCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", taskName: "תוכנית חשמל", currentDueDateISO: overdue2d }, now);
  forceDue(f.id, now.minus({ minutes: 1 }).toUTC().toISO()!);

  let sentBody = "";
  const result = await runDueFollowups(now, {
    getTaskStatusLabel: async () => "בעבודה",
    addNotification: (_u, _k, body) => {
      sentBody = body;
      return 1;
    },
    publishNudge: () => {},
  });
  check(
    "הנוסח מדויק כפי שהתבקש",
    sentBody === `התחייבת לסיים היום את המשימה "תוכנית חשמל", והיא עדיין פתוחה. האם סיימת, או שצריך לדחות?`,
    sentBody,
  );
  check("outcome nudge_sent, follow-up triggered", result.processed.some((p) => p.id === f.id && p.outcome === "nudge_sent") && getFollowup(f.id)!.status === "triggered");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. EOD nudge + "סיימתי" → נסגר כרגיל
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 4. EOD nudge + replyDone → נסגר כרגיל ──");
{
  const itemId = "__eod_then_done__";
  const now = DateTime.now().setZone(env.TIMEZONE);
  const findingKey = seedFinding(itemId, now);
  const f = scheduleEndOfDayCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", taskName: "בדיקה", currentDueDateISO: overdue2d }, now);
  forceDue(f.id, now.minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(now, okRunnerDeps("בעבודה"));
  check("הכנה: EOD check triggered", getFollowup(f.id)!.status === "triggered");

  const c = baseCtx(itemId, findingKey, overdue2d);
  const deps: ReplyDoneDeps = { updateTask: async () => ({ ok: true, message: "" }), addTaskNote: async () => {} };
  const result = await replyDone(dov, c, deps);
  check("replyDone מצליח", result.ok === true);
  check("ה-EOD follow-up נסגר כרגיל (completed)", getFollowup(f.id)!.status === "completed");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. EOD nudge + בקשת דחייה → Policy מזהה missed commitment, דורש מוטי
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 5. EOD nudge + דחייה → Policy Engine מזהה התחייבות שהוחמצה (Rule 4, missedCommitment) ──");
{
  // התרחיש המילולי המדויק: dueDate=היום עצמו (לא overdue לפי date-only math, אין דחייה קודמת
  // בכלל) — ובכל זאת manager_approval_required, כי missedCommitment מגיע כ-context מפורש מה-
  // EOD flow, לא נגזר מ-wasOverdue/תאריכים (2026-09-16).
  const itemId = "__eod_then_defer__";
  const now = DateTime.now().setZone(env.TIMEZONE);
  const todayISO = now.toISODate()!;
  const findingKey = seedFinding(itemId, now);

  const f = scheduleEndOfDayCheck(
    { itemId, itemSource: "general", findingKey, userKey: "dov", taskName: "בדיקה", currentDueDateISO: todayISO },
    now,
  );
  forceDue(f.id, now.minus({ minutes: 1 }).toUTC().toISO()!);

  // תופסים את ה-context שהנודג' עצמו נשלח איתו (בדיוק מה ש-/api/nudges היה מחזיר ל-UI) — לא את
  // payload הפנימי של ה-follow-up (שדה נפרד, לא אמור לשאת missedCommitment בעצמו).
  let nudgeContext: { currentDueDateISO?: string | null; missedCommitment?: boolean } | undefined;
  await runDueFollowups(now, {
    getTaskStatusLabel: async () => "בעבודה",
    addNotification: (_u, _k, _b, _fk, ctx) => {
      nudgeContext = ctx?.context as typeof nudgeContext;
      return 1;
    },
    publishNudge: () => {},
  });
  check("ה-nudge שנשלח נושא missedCommitment=true בקונטקסט (מה ש-/api/nudges/about מקבלים)", nudgeContext?.missedCommitment === true);

  // בדיוק כמו chat.ts היה בונה LoopContext מ-context ה-notification — לא מטקסט חופשי.
  const c = baseCtx(itemId, findingKey, nudgeContext?.currentDueDateISO ?? null, nudgeContext?.missedCommitment ?? false);
  const deps: ReplyDeferDeps = { ...noopReplyDeps(), addNotification: () => 1, recordFindingEvent: realRecordFindingEvent };
  const result = await replyDefer(dov, c, now.plus({ days: 1 }).toISODate()!, "עוד קצת", null, deps);
  check(
    "1. dueDate=היום + missedCommitment (EOD) + replyDefer → manager_approval_required, גם ש-wasOverdue date-only=false",
    result.status === "manager_approval_required",
    result.status,
  );

  const approval = listApprovalsForManager("moti").find((a) => a.itemId === itemId);
  check("5. ה-approval שנוצר קיים ונושא context מפורש (לא רק ruleId) שזו missedCommitment", approval?.payload.missedCommitment === true, JSON.stringify(approval?.payload));
}

logger.info("── 2. proactive deferral רגילה לפני EOD (לא דרך end_of_day_check) → לא מסומנת missed commitment ──");
{
  // אותו dueDate=היום בדיוק כמו בבדיקה 1 — אבל הפעם *לא* דרך nudge של end_of_day_check: עובד
  // שפשוט מבקש דחייה יזומה, בלי שהתבקש קודם לעדכן ב-EOD. missedCommitment חייב להישאר false.
  const itemId = "__eod_proactive_defer_today__";
  const now = DateTime.now().setZone(env.TIMEZONE);
  const todayISO = now.toISODate()!;
  const findingKey = seedFinding(itemId, now);

  const c = baseCtx(itemId, findingKey, todayISO); // missedCommitment ברירת מחדל false — לא הועבר מ-EOD
  const deps: ReplyDeferDeps = { ...noopReplyDeps(), addNotification: () => 1, recordFindingEvent: realRecordFindingEvent };
  const result = await replyDefer(dov, c, now.plus({ days: 2 }).toISODate()!, undefined, null, deps);
  check(
    "2. proactive deferral (בלי missedCommitment) על dueDate=היום → מדיניות רגילה (before-due-ok), לא נגרר ל-missed commitment",
    result.status === "executed",
    result.status,
  );
}

logger.info("── 3. dueDate עתידי + follow-up אחר (commitment_check) קיים → לא מסומן missed commitment ──");
{
  // עצם קיומו של follow-up כלשהו על הפריט (מסוג אחר, לא end_of_day_check) לא אמור להדליק
  // missedCommitment — הדגל חייב להגיע רק מ-EOD flow עצמו, לא "יש follow-up אז חייב אישור".
  const itemId = "__eod_other_followup_future__";
  const now = DateTime.now().setZone(env.TIMEZONE);
  const futureISO = now.plus({ days: 10 }).toISODate()!;
  const findingKey = seedFinding(itemId, now);
  scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: now.plus({ days: 5 }).toISODate()! });

  const c = baseCtx(itemId, findingKey, futureISO); // dueDate עתידי, אין EOD בכלל, missedCommitment=false
  const deps: ReplyDeferDeps = { ...noopReplyDeps(), addNotification: () => 1, recordFindingEvent: realRecordFindingEvent };
  const result = await replyDefer(dov, c, now.plus({ days: 12 }).toISODate()!, undefined, null, deps);
  check(
    "3. dueDate עתידי + follow-up אחר קיים על הפריט → עדיין before-due-ok, לא missed commitment",
    result.status === "executed",
    result.status,
  );
}

logger.info("── 4. [רגרסיה] dueDate overdue רגיל, בלי missedCommitment → התנהגות קיימת נשמרת ──");
{
  const itemId = "__eod_regression_overdue__";
  const now = DateTime.now().setZone(env.TIMEZONE);
  const findingKey = seedFinding(itemId, now);
  const c = baseCtx(itemId, findingKey, overdue2d); // missedCommitment=false — כמו כל קריאה קיימת
  const deps: ReplyDeferDeps = { ...noopReplyDeps(), addNotification: () => 1, recordFindingEvent: realRecordFindingEvent };
  const result = await replyDefer(dov, c, now.plus({ days: 2 }).toISODate()!, undefined, null, deps);
  check(
    "4. משימה overdue רגילה, בלי missedCommitment → executed (after-overdue-short) כמו לפני השינוי",
    result.status === "executed",
    result.status,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6-10. Rule 18: no_response_reminder → end_of_day_no_response → מוטי
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 6. nudge ב-10:30 → reminder ב-13:30 ──");
{
  const itemId = "__eod_reminder_1030__";
  const t1030 = DateTime.fromObject(
    { year: 2026, month: 9, day: 14, hour: 10, minute: 30 },
    { zone: "Asia/Jerusalem" },
  );
  const findingKey = seedFinding(itemId, t1030);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: t1030.toISODate()! });
  forceDue(f.id, t1030.minus({ minutes: 1 }).toUTC().toISO()!);

  await runDueFollowups(t1030, okRunnerDeps("בעבודה"));
  check("commitment_check נשלח ב-10:30", getFollowup(f.id)!.status === "triggered");

  const reminder = listFollowups().find((x) => x.itemId === itemId && x.kind === "no_response_reminder");
  check("נוצר no_response_reminder", !!reminder);
  const reminderLocal = reminder ? DateTime.fromISO(reminder.dueAt, { zone: "utc" }).setZone(env.TIMEZONE) : null;
  check(
    "התזכורת בדיוק 3 שעות אחרי — 13:30",
    !!reminderLocal && reminderLocal.hour === 13 && reminderLocal.minute === 30,
    reminderLocal?.toISO() ?? "",
  );
}

logger.info("── 7. תשובה ב-12:00 (לפני התזכורת) → reminder לא נשלח ──");
{
  const itemId = "__eod_response_before_reminder__";
  const t1030 = DateTime.fromObject({ year: 2026, month: 9, day: 15, hour: 10, minute: 30 }, { zone: "Asia/Jerusalem" });
  const findingKey = seedFinding(itemId, t1030);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: t1030.toISODate()! });
  forceDue(f.id, t1030.minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(t1030, okRunnerDeps("בעבודה"));
  const reminder = listFollowups().find((x) => x.itemId === itemId && x.kind === "no_response_reminder")!;

  const c = baseCtx(itemId, findingKey, t1030.toISODate());
  await replyProgress(dov, c, "עוד קצת", simpleDeps());
  check("תשובת העובד (12:00) משלימה את ה-reminder הממתין — לא נשאר pending", getFollowup(reminder.id)!.status === "completed");

  const t1330 = t1030.set({ hour: 13, minute: 30 });
  const spy = scopedNotifSpy(itemId);
  await runDueFollowups(t1330, { getTaskStatusLabel: async () => "בעבודה", addNotification: spy.addNotification, publishNudge: () => {} });
  check("ב-13:30 לא נשלחת שום תזכורת — כבר ענו", spy.count() === 0);
}

logger.info("── 8. אין תשובה עד 13:30 → תזכורת אחת בדיוק ──");
{
  const itemId = "__eod_reminder_sent_once__";
  const t1030 = DateTime.fromObject({ year: 2026, month: 9, day: 16, hour: 10, minute: 30 }, { zone: "Asia/Jerusalem" });
  const findingKey = seedFinding(itemId, t1030);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: t1030.toISODate()! });
  forceDue(f.id, t1030.minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(t1030, okRunnerDeps("בעבודה"));
  const reminder = listFollowups().find((x) => x.itemId === itemId && x.kind === "no_response_reminder")!;
  forceDue(reminder.id, t1030.set({ hour: 13, minute: 30 }).minus({ minutes: 1 }).toUTC().toISO()!);

  const t1330 = t1030.set({ hour: 13, minute: 30 });
  const spy1 = scopedNotifSpy(itemId);
  const r1 = await runDueFollowups(t1330, { getTaskStatusLabel: async () => "בעבודה", addNotification: spy1.addNotification, publishNudge: () => {} });
  check("התזכורת נשלחת בפעם הראשונה", spy1.count() === 1 && r1.processed.some((p) => p.id === reminder.id && p.outcome === "reminder_sent"));
  check("סטטוס triggered אחרי שליחה", getFollowup(reminder.id)!.status === "triggered");

  const spy2 = scopedNotifSpy(itemId);
  const r2 = await runDueFollowups(t1330.plus({ minutes: 5 }), { getTaskStatusLabel: async () => "בעבודה", addNotification: spy2.addNotification, publishNudge: () => {} });
  check("הרצה נוספת לא שולחת תזכורת שנייה (triggered, לא pending)", spy2.count() === 0, `processed2=${JSON.stringify(r2.processed)}`);
}

logger.info("── 9. אין תשובה עד 17:00 → notification אחת למוטי ──");
{
  const itemId = "__eod_escalate_to_moti__";
  const t1030 = DateTime.fromObject({ year: 2026, month: 9, day: 17, hour: 10, minute: 30 }, { zone: "Asia/Jerusalem" });
  const findingKey = seedFinding(itemId, t1030);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: t1030.toISODate()! });
  forceDue(f.id, t1030.minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(t1030, okRunnerDeps("בעבודה"));
  const reminder = listFollowups().find((x) => x.itemId === itemId && x.kind === "no_response_reminder")!;
  forceDue(reminder.id, t1030.set({ hour: 13, minute: 30 }).minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(t1030.set({ hour: 13, minute: 30 }), okRunnerDeps("בעבודה"));
  const eodNoResponse = listFollowups().find((x) => x.itemId === itemId && x.kind === "end_of_day_no_response")!;
  check("נוצר end_of_day_no_response אחרי התזכורת", !!eodNoResponse);
  const eodLocal = DateTime.fromISO(eodNoResponse.dueAt, { zone: "utc" }).setZone(env.TIMEZONE);
  check("קבוע ל-17:00 של אותו יום", eodLocal.hour === 17 && eodLocal.minute === 0 && eodLocal.toISODate() === t1030.toISODate());

  const t1700 = t1030.set({ hour: 17, minute: 0 });
  const motiSpy = scopedMotiSpy(itemId);
  const result = await runDueFollowups(t1700, { getTaskStatusLabel: async () => "בעבודה", addNotification: motiSpy.addNotification, publishNudge: () => {} });
  check("נשלחה בדיוק התראה אחת למוטי", motiSpy.count() === 1);
  check(
    "ההתראה כוללת עובד ומשימה",
    !!motiSpy.lastBody() && motiSpy.lastBody()!.includes("דוב") && motiSpy.lastBody()!.includes(itemId),
    motiSpy.lastBody() ?? "",
  );
  check("outcome escalated_no_response, follow-up completed", result.processed.some((p) => p.id === eodNoResponse.id && p.outcome === "escalated_no_response") && getFollowup(eodNoResponse.id)!.status === "completed");
}

logger.info("── 10. תשובה אחרי reminder ולפני 17:00 → אין escalation ──");
{
  const itemId = "__eod_response_after_reminder__";
  const t1030 = DateTime.fromObject({ year: 2026, month: 9, day: 18, hour: 10, minute: 30 }, { zone: "Asia/Jerusalem" });
  const findingKey = seedFinding(itemId, t1030);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: t1030.toISODate()! });
  forceDue(f.id, t1030.minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(t1030, okRunnerDeps("בעבודה"));
  const t1330 = t1030.set({ hour: 13, minute: 30 });
  const reminder = listFollowups().find((x) => x.itemId === itemId && x.kind === "no_response_reminder")!;
  forceDue(reminder.id, t1330.minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(t1330, okRunnerDeps("בעבודה"));
  const eodNoResponse = listFollowups().find((x) => x.itemId === itemId && x.kind === "end_of_day_no_response")!;
  check("הכנה: end_of_day_no_response נוצר אחרי התזכורת", !!eodNoResponse);

  const c = baseCtx(itemId, findingKey, t1030.toISODate());
  await replyWaiting(dov, c, "consultant", "מחכה ליועץ", simpleDeps());
  check("תשובת העובד (לפני 17:00) משלימה את end_of_day_no_response", getFollowup(eodNoResponse.id)!.status === "completed");

  const motiSpy = scopedMotiSpy(itemId);
  await runDueFollowups(t1030.set({ hour: 17, minute: 0 }), { getTaskStatusLabel: async () => "בעבודה", addNotification: motiSpy.addNotification, publishNudge: () => {} });
  check("אין שום escalation למוטי ב-17:00 — כבר ענו", motiSpy.count() === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. nudge ב-16:30 → אין reminder בלילה; ישר ל-EOD ב-17:00
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 11. nudge ב-16:30 → אין reminder אחרי שעות; ישר ל-end_of_day_no_response ──");
{
  const itemId = "__eod_late_nudge__";
  const t1630 = DateTime.fromObject({ year: 2026, month: 9, day: 19, hour: 16, minute: 30 }, { zone: "Asia/Jerusalem" });
  const findingKey = seedFinding(itemId, t1630);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: t1630.toISODate()! });
  forceDue(f.id, t1630.minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(t1630, okRunnerDeps("בעבודה"));

  const reminder = listFollowups().find((x) => x.itemId === itemId && x.kind === "no_response_reminder");
  check("לא נוצר no_response_reminder (19:30 היה נופל אחרי שעות העבודה)", !reminder);
  const eodNoResponse = listFollowups().find((x) => x.itemId === itemId && x.kind === "end_of_day_no_response");
  check("נוצר ישירות end_of_day_no_response", !!eodNoResponse);
  const eodLocal = eodNoResponse ? DateTime.fromISO(eodNoResponse.dueAt, { zone: "utc" }).setZone(env.TIMEZONE) : null;
  check("קבוע ל-17:00 (לא 19:30, לא בלילה)", !!eodLocal && eodLocal.hour === 17 && eodLocal.minute === 0, eodLocal?.toISO() ?? "");
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. restart לא מאבד reminder/EOD
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 12. restart (processing תקוע) לא מאבד reminder/EOD ──");
{
  const itemId = "__eod_crash_recovery__";
  const t1030 = DateTime.fromObject({ year: 2026, month: 9, day: 20, hour: 10, minute: 30 }, { zone: "Asia/Jerusalem" });
  const findingKey = seedFinding(itemId, t1030);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: t1030.toISODate()! });
  forceDue(f.id, t1030.minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(t1030, okRunnerDeps("בעבודה"));
  const reminder = listFollowups().find((x) => x.itemId === itemId && x.kind === "no_response_reminder")!;
  forceDue(reminder.id, t1030.set({ hour: 13, minute: 30 }).minus({ minutes: 1 }).toUTC().toISO()!);

  // מדמים קריסה בדיוק אחרי claim.
  db.exec(`UPDATE control_followups SET status = 'processing', processing_started_at = datetime('now') WHERE id = ${reminder.id}`);
  const recovered = recoverStuckFollowups();
  check("recoverStuckFollowups משחזר את ה-reminder התקוע", recovered >= 1);
  check("חוזר ל-pending", getFollowup(reminder.id)!.status === "pending");

  const spy = scopedNotifSpy(itemId);
  await runDueFollowups(t1030.set({ hour: 13, minute: 30 }), { getTaskStatusLabel: async () => "בעבודה", addNotification: spy.addNotification, publishNudge: () => {} });
  check("אחרי שחזור — התזכורת נשלחת כרגיל", spy.count() === 1 && getFollowup(reminder.id)!.status === "triggered");
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. שתי ריצות מקבילות לא יוצרות duplicate
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 13. שתי ריצות מקבילות על end_of_day_no_response — לא duplicate ──");
{
  const itemId = "__eod_concurrent_escalation__";
  const t1030 = DateTime.fromObject({ year: 2026, month: 9, day: 21, hour: 10, minute: 30 }, { zone: "Asia/Jerusalem" });
  const findingKey = seedFinding(itemId, t1030);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: t1030.toISODate()! });
  forceDue(f.id, t1030.minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(t1030, okRunnerDeps("בעבודה"));
  const reminder = listFollowups().find((x) => x.itemId === itemId && x.kind === "no_response_reminder")!;
  forceDue(reminder.id, t1030.set({ hour: 13, minute: 30 }).minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(t1030.set({ hour: 13, minute: 30 }), okRunnerDeps("בעבודה"));
  const eodNoResponse = listFollowups().find((x) => x.itemId === itemId && x.kind === "end_of_day_no_response")!;

  const t1700 = t1030.set({ hour: 17, minute: 0 });
  const motiSpy = scopedMotiSpy(itemId);
  const deps: FollowupRunnerDeps = { getTaskStatusLabel: async () => "בעבודה", addNotification: motiSpy.addNotification, publishNudge: () => {} };
  const p1 = runDueFollowups(t1700, deps);
  const p2 = runDueFollowups(t1700, deps);
  await Promise.all([p1, p2]);
  check("שתי ריצות בו-זמנית → התראה אחת בדיוק למוטי", motiSpy.count() === 1, String(motiSpy.count()));
  check("סטטוס סופי completed", getFollowup(eodNoResponse.id)!.status === "completed");
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. כשל בהתראה למוטי → retry אפשרי, לא מסומן completed בטעות
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 14. כשל בהתראה למוטי → retry אפשרי ──");
{
  const itemId = "__eod_moti_notify_fails__";
  const t1030 = DateTime.fromObject({ year: 2026, month: 9, day: 22, hour: 10, minute: 30 }, { zone: "Asia/Jerusalem" });
  const findingKey = seedFinding(itemId, t1030);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: t1030.toISODate()! });
  forceDue(f.id, t1030.minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(t1030, okRunnerDeps("בעבודה"));
  const reminder = listFollowups().find((x) => x.itemId === itemId && x.kind === "no_response_reminder")!;
  forceDue(reminder.id, t1030.set({ hour: 13, minute: 30 }).minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(t1030.set({ hour: 13, minute: 30 }), okRunnerDeps("בעבודה"));
  const eodNoResponse = listFollowups().find((x) => x.itemId === itemId && x.kind === "end_of_day_no_response")!;

  const t1700 = t1030.set({ hour: 17, minute: 0 });
  let attempt = 0;
  const flakyDeps: FollowupRunnerDeps = {
    getTaskStatusLabel: async () => "בעבודה",
    addNotification: (userKey, _kind, _body, _findingKey, ctx) => {
      if (userKey === "moti" && ctx?.itemId === itemId) {
        attempt++;
        if (attempt === 1) throw new Error("DB זמנית לא זמין (מדומה)");
      }
      return 1;
    },
    publishNudge: () => {},
  };
  await runDueFollowups(t1700, flakyDeps);
  check("ניסיון ראשון נכשל — לא מסומן completed בטעות", getFollowup(eodNoResponse.id)!.status === "pending");
  check("last_error גלוי", !!getFollowup(eodNoResponse.id)!.lastError);

  await runDueFollowups(t1700, flakyDeps);
  check("ניסיון שני מצליח", getFollowup(eodNoResponse.id)!.status === "completed" && attempt === 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. worker response משלים את כל ה-follow-ups הרלוונטיים יחד
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 15. תשובת עובד משלימה commitment_check + no_response_reminder יחד ──");
{
  const itemId = "__eod_response_completes_both__";
  const t1030 = DateTime.fromObject({ year: 2026, month: 9, day: 23, hour: 10, minute: 30 }, { zone: "Asia/Jerusalem" });
  const findingKey = seedFinding(itemId, t1030);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: t1030.toISODate()! });
  forceDue(f.id, t1030.minus({ minutes: 1 }).toUTC().toISO()!);
  await runDueFollowups(t1030, okRunnerDeps("בעבודה"));
  const reminder = listFollowups().find((x) => x.itemId === itemId && x.kind === "no_response_reminder")!;
  check("הכנה: commitment_check triggered, reminder pending", getFollowup(f.id)!.status === "triggered" && getFollowup(reminder.id)!.status === "pending");

  const c = baseCtx(itemId, findingKey, t1030.toISODate());
  const deps: ReplyDoneDeps = { updateTask: async () => ({ ok: true, message: "" }), addTaskNote: async () => {} };
  await replyDone(dov, c, deps);
  check("replyDone משלים גם commitment_check וגם no_response_reminder יחד", getFollowup(f.id)!.status === "completed" && getFollowup(reminder.id)!.status === "completed");
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. שום פעולה לא נשלחת לעובד אחרי 17:00 — בשום שלב של השרשרת
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 16. שום nudge/reminder מתוזמן לעובד אחרי 17:00 ──");
{
  const cases = [
    { hour: 8, minute: 30 },
    { hour: 12, minute: 0 },
    { hour: 14, minute: 0 }, // בדיוק הגבול: +3h = 17:00
    { hour: 14, minute: 1 }, // מעבר לגבול: +3h = 17:01 → אמור לדלג ל-EOD ישירות
    { hour: 16, minute: 59 },
  ];
  for (const { hour, minute } of cases) {
    const itemId = `__eod_boundary_${hour}_${minute}__`;
    const t = DateTime.fromObject({ year: 2026, month: 9, day: 25, hour, minute }, { zone: "Asia/Jerusalem" });
    const findingKey = seedFinding(itemId, t);
    const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: t.toISODate()! });
    forceDue(f.id, t.minus({ minutes: 1 }).toUTC().toISO()!);
    await runDueFollowups(t, okRunnerDeps("בעבודה"));

    const reminder = listFollowups().find((x) => x.itemId === itemId && x.kind === "no_response_reminder");
    const eodNoResponse = listFollowups().find((x) => x.itemId === itemId && x.kind === "end_of_day_no_response");
    if (reminder) {
      const local = DateTime.fromISO(reminder.dueAt, { zone: "utc" }).setZone(env.TIMEZONE);
      check(`[${hour}:${minute}] reminder המתוזמן (אם נוצר) לא אחרי 17:00`, local <= t.set({ hour: 17, minute: 0 }), local.toISO()!);
    } else {
      check(`[${hour}:${minute}] אין reminder → end_of_day_no_response נוצר ישירות ל-17:00`, !!eodNoResponse);
    }
  }
  // ובנוסף: השכבה שמפעילה את הסבב מלכתחילה (ה-scheduler) חסומה אחרי 17:30 — שום tick לא קורה בלילה.
  const night = DateTime.fromObject({ year: 2026, month: 9, day: 26, hour: 20, minute: 0 }, { zone: "Asia/Jerusalem" });
  check("בלילה (20:00) ה-scheduler לא מריץ סבב בכלל — שכבת הגנה נוספת", isWithinFollowupWindow(night) === false);
}

// ─────────────────────────────────────────────────────────────────────────────
// bonus: debug endpoint רואה את שלושת ה-kinds החדשים
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── בונוס: listFollowups חושף kinds חדשים עם השדות הנדרשים ──");
{
  const itemId = "__eod_debug_visibility__";
  const t = DateTime.now().setZone(env.TIMEZONE);
  const findingKey = seedFinding(itemId, t);
  scheduleEndOfDayCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", taskName: "בדיקה", currentDueDateISO: overdue2d }, t);
  const rows = listFollowups().filter((f) => f.itemId === itemId);
  check("end_of_day_check מופיע עם status/dueAt/kind/itemId/userKey", rows.some((f) => f.kind === "end_of_day_check" && "status" in f && "dueAt" in f && "userKey" in f));
}

cleanup();

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות ה-EOD Engine עברו ✅");
