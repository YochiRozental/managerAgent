/**
 * Follow-up Engine — Audit 2026-09-15: שעת commitment_check, timezone/UTC, כשל בשליחה,
 * שחזור אחרי קריסה תוך-כדי-עיבוד, semantics של "מושהה", ניקוי follow-up ישן בכל סוגי תשובה,
 * וזהות item_id+item_source+kind (לא finding_key). DB אמיתי (מקומי), אפס Monday אמיתי.
 *
 *   npm run test:followups
 */

import "dotenv/config";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { env } from "../src/config/env.js";
import { db } from "../src/db/db.js";
import { upsertFinding } from "../src/db/repositories/controlFindings.js";
import { recordFindingEvent as realRecordFindingEvent } from "../src/db/repositories/findingEvents.js";
import { getFollowup, listFollowups, recoverStuckFollowups } from "../src/db/repositories/controlFollowups.js";
import { userCan, resolveUserByKey } from "../src/identity/index.js";
import {
  commitmentCheckDueAt,
  FOLLOWUP_CONFIG,
  runDueFollowups,
  scheduleCommitmentCheck,
  type FollowupRunnerDeps,
} from "../src/ops/followups.js";
import {
  replyBlocked,
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

const now = DateTime.fromISO("2026-09-14T10:00:00", { zone: "Asia/Jerusalem" });
const nowIso = now.toISO()!;
const overdue2d = now.minus({ days: 2 }).toISODate()!;
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
    `DELETE FROM manager_approval_messages WHERE approval_id IN (SELECT id FROM manager_approvals WHERE item_id LIKE '%__fu_%')`,
  );
  db.exec(`DELETE FROM manager_approvals WHERE item_id LIKE '%__fu_%'`);
  db.exec(`DELETE FROM control_followups WHERE item_id LIKE '%__fu_%'`);
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '%__fu_%'`);
  db.exec(`DELETE FROM control_findings WHERE item_id LIKE '%__fu_%'`);
  db.exec(`DELETE FROM notifications WHERE item_id LIKE '%__fu_%'`);
}
cleanup();

function seedFinding(itemId: string, findingKeyOverride?: string): string {
  const findingKey = findingKeyOverride ?? `overdue:${itemId}`;
  upsertFinding({
    findingKey,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: "בדיקת follow-up",
    detail: "בדיקה",
    itemId,
    itemSource: "general",
    dueDate: overdue2d,
    now: nowIso,
  });
  return findingKey;
}

function baseCtx(itemId: string, findingKey: string): LoopContext {
  return { itemId, source: "general", findingKey, taskName: "בדיקת follow-up", currentDueDateISO: overdue2d };
}

const monetaryNoop = (): Pick<ReplyDeferDeps, "setTaskDueDate" | "addTaskNote" | "updateTask"> => ({
  setTaskDueDate: async () => {},
  addTaskNote: async () => {},
  updateTask: async () => undefined as never,
});

const okRunnerDeps = (label: string): FollowupRunnerDeps => ({
  getTaskStatusLabel: async () => label,
  addNotification: () => 1,
  publishNudge: () => {},
});

function forceDue(id: number): void {
  db.exec(`UPDATE control_followups SET due_at = '${now.minus({ hours: 1 }).toUTC().toISO()}' WHERE id = ${id}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. commitment_check = 10:30 שעון ישראל, באותו יום ההתחייבות
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 1. שעת commitment_check = 10:30 Israel, אותו יום ──");
{
  const commitmentDate = "2026-09-17";
  const dueAt = commitmentCheckDueAt(commitmentDate);
  const local = DateTime.fromISO(dueAt).setZone(env.TIMEZONE);
  check(
    "10:30 בדיוק, שעון ישראל, ב-17/09 (לא 18/09, לא לפני שעות העבודה)",
    local.hour === 10 && local.minute === 30 && local.toISODate() === commitmentDate,
    `local=${local.toISO()}`,
  );
  check("השעה מוגדרת דרך FOLLOWUP_CONFIG (configurable), לא hard-code בלוגיקה", FOLLOWUP_CONFIG.commitmentCheck.hour === 10 && FOLLOWUP_CONFIG.commitmentCheck.minute === 30);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. timezone: נשמר תמיד ב-UTC, נכון גם בקיץ וגם בחורף (offset שונה)
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 2. timezone: UTC storage, נכון קיץ/חורף ──");
{
  const summer = commitmentCheckDueAt("2026-09-17"); // DST פעיל בישראל — +03:00
  const winter = commitmentCheckDueAt("2026-12-17"); // שעון חורף — +02:00
  check("ה-dueAt נשמר תמיד ב-UTC (מסתיים ב-Z), לא offset משתנה", summer.endsWith("Z") && winter.endsWith("Z"));

  const summerLocal = DateTime.fromISO(summer).setZone(env.TIMEZONE);
  const winterLocal = DateTime.fromISO(winter).setZone(env.TIMEZONE);
  check("קיץ: 10:30 שעון ישראל נכון על אף DST", summerLocal.hour === 10 && summerLocal.minute === 30);
  check("חורף: 10:30 שעון ישראל נכון גם ב-UTC+2", winterLocal.hour === 10 && winterLocal.minute === 30);
  // ה-offset בפועל שונה בין העונות — אם זה לא היה מטופל נכון, שעת ה-UTC הגולמית הייתה זהה בטעות.
  check(
    "שעת ה-UTC הגולמית שונה בין הקיץ לחורף (משקפת offset אמיתי, לא קבוע בטעות)",
    DateTime.fromISO(summer, { zone: "utc" }).hour !== DateTime.fromISO(winter, { zone: "utc" }).hour,
    `summerUTC=${summer} winterUTC=${winter}`,
  );

  // ההשוואה ב-runDueFollowups חייבת גם היא UTC — לא lexicographic-שגוי בין offsets שונים.
  const itemId = "__fu_tz__";
  const findingKey = seedFinding(itemId);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: now.toISODate()! });
  check("dueAt שנשמר בפועל דרך scheduleCommitmentCheck גם הוא UTC", f.dueAt.endsWith("Z"));
  forceDue(f.id);
  const result = await runDueFollowups(now, okRunnerDeps("בעבודה"));
  check("ההשוואה מול now (גם הוא מומר ל-UTC בתוך runDueFollowups) מוצאת את הרשומה נכון", result.processed.some((p) => p.id === f.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3+4. כשל בשליחה לא מאבד follow-up; retry שולח פעם אחת בדיוק
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 3+4. כשל שליחה → לא אבוד, retry שולח פעם אחת ──");
{
  const itemId = "__fu_sendfail__";
  const findingKey = seedFinding(itemId);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: now.toISODate()! });
  forceDue(f.id);

  let attempt = 0;
  const notifSpy = makeSpy();
  const flakyDeps: FollowupRunnerDeps = {
    getTaskStatusLabel: async () => {
      attempt++;
      if (attempt === 1) throw new Error("Monday API timeout (מדומה)");
      return "בעבודה";
    },
    addNotification: () => {
      notifSpy.fn();
      return 1;
    },
    publishNudge: () => {},
  };

  const run1 = await runDueFollowups(now, flakyDeps);
  check("ניסיון ראשון נכשל — לא נשלחה שום פנייה", notifSpy.calls.length === 0);
  check("outcome מדווח כ-reverted (לא נעלם, לא נחשב הצלחה)", run1.processed.some((p) => p.id === f.id && p.outcome === "reverted_pending_error"));
  const afterFail = getFollowup(f.id)!;
  check("אחרי כשל — חוזר ל-pending (לא נשאר processing, לא הופך triggered)", afterFail.status === "pending", afterFail.status);
  check("last_error נשמר (retry metadata גלוי)", !!afterFail.lastError && afterFail.lastError.includes("Monday API timeout"));

  // הרצה נוספת (ה-followup עדיין due — pending + due_at<=now) — עכשיו מצליחה.
  const run2 = await runDueFollowups(now, flakyDeps);
  check("ניסיון שני מצליח ושולח פנייה אחת בדיוק", notifSpy.calls.length === 1 && run2.processed.some((p) => p.id === f.id && p.outcome === "nudge_sent"));
  check("סטטוס סופי triggered", getFollowup(f.id)!.status === "triggered");

  // הרצה שלישית לא שולחת שוב (כבר triggered, לא pending).
  await runDueFollowups(now, flakyDeps);
  check("לא נשלחה פנייה נוספת אחרי שכבר triggered", notifSpy.calls.length === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. קריסה/הפרעה תוך-כדי-עיבוד (processing) — ניתן לשחזור, לא תקוע לנצח
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 5. שחזור אחרי קריסה באמצע processing ──");
{
  const itemId = "__fu_crash__";
  const findingKey = seedFinding(itemId);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: now.toISODate()! });
  forceDue(f.id);

  // מדמים קריסה בדיוק אחרי ה-claim: מסמנים ידנית processing ולא ממשיכים אף שלב נוסף.
  db.exec(`UPDATE control_followups SET status = 'processing', processing_started_at = datetime('now') WHERE id = ${f.id}`);
  check("הרשומה כרגע 'processing' (מדמה תהליך שקרס בדיוק כאן)", getFollowup(f.id)!.status === "processing");

  // בזמן שהוא 'processing' — runDueFollowups לא מוצא אותו כלל (השאילתה היא רק pending).
  const whileStuck = await runDueFollowups(now, okRunnerDeps("בעבודה"));
  check("בזמן שהוא תקוע ב-processing — runner לא נוגע בו (לא due כ-pending)", !whileStuck.processed.some((p) => p.id === f.id));

  const recovered = recoverStuckFollowups();
  check("recoverStuckFollowups משחזר לפחות שורה אחת", recovered >= 1, String(recovered));
  const afterRecover = getFollowup(f.id)!;
  check("אחרי שחזור — חוזר ל-pending עם last_error גלוי (לא נמחק, לא מנחש)", afterRecover.status === "pending" && !!afterRecover.lastError);

  const retry = await runDueFollowups(now, okRunnerDeps("בעבודה"));
  check("אחרי שחזור — ניתן לעבד אותו שוב בהצלחה", retry.processed.some((p) => p.id === f.id && p.outcome === "nudge_sent"));
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. "בוצע" → completion אמיתי, אין nudge
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 6. 'בוצע' → completed, אין nudge ──");
{
  const itemId = "__fu_closed__";
  const findingKey = seedFinding(itemId);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: now.toISODate()!, taskName: "תוכנית חשמל" });
  forceDue(f.id);

  const notifSpy = makeSpy();
  const result = await runDueFollowups(now, { ...okRunnerDeps("בוצע"), addNotification: () => { notifSpy.fn(); return 1; } });
  check("לא נשלחה שום notification לעובד", notifSpy.calls.length === 0);
  check("ה-outcome מסומן completed_done", result.processed.some((p) => p.id === f.id && p.outcome === "completed_done"));
  check("ה-follow-up עצמו completed", getFollowup(f.id)!.status === "completed");
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. "מושהה" — לא נחשב הושלם, לא נשלחת פנייה, לא מניחים שההתחייבות קוימה
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 7. semantics של 'מושהה' — paused, לא completed ──");
{
  const itemId = "__fu_parked__";
  const findingKey = seedFinding(itemId);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: now.toISODate()!, taskName: "תוכנית חשמל" });
  forceDue(f.id);

  const notifSpy = makeSpy();
  const result = await runDueFollowups(now, { ...okRunnerDeps("מושהה"), addNotification: () => { notifSpy.fn(); return 1; } });
  check("'מושהה' לא שולח נודג' (אין טעם לשאול 'איפה זה עומד' על משהו מוקפא)", notifSpy.calls.length === 0);
  check("outcome מפורש: skipped_parked (לא completed_done — אלה semantics שונים)", result.processed.some((p) => p.id === f.id && p.outcome === "skipped_parked"));
  const after = getFollowup(f.id)!;
  check(
    "לא מסומן completed — לא מניחים שההתחייבות קוימה כי המשימה 'מושהה'",
    after.status === "pending",
    after.status,
  );
  check("last_error/הערה מסבירה למה לא נשלח (debug visibility)", !!after.lastError && after.lastError.includes("מושהה"));
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. replyDefer מטפל ב-follow-up הקודם (גם אם כבר triggered) ויוצר חדש
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 8. replyDefer: follow-up ישן (גם triggered) מטופל + חדש נוצר ──");
{
  const itemId = "__fu_defer_old__";
  const findingKey = seedFinding(itemId);
  const c = baseCtx(itemId, findingKey);

  // commitment_check ראשון — מדמים שהוא *כבר נורה* (triggered), לא רק pending. זה בדיוק המקרה
  // הריאלי: העובד עונה ל-nudge של commitment_check ומבקש עוד זמן.
  const old = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: overdue2d });
  forceDue(old.id);
  await runDueFollowups(now, okRunnerDeps("בעבודה"));
  check("ה-follow-up הישן אכן triggered לפני הבדיקה (הכנה)", getFollowup(old.id)!.status === "triggered");

  const deps: ReplyDeferDeps = { ...monetaryNoop(), addNotification: () => 1, recordFindingEvent: realRecordFindingEvent };
  const newDate = now.plus({ days: 2 }).toISODate()!;
  const result = await replyDefer(dov, c, newDate, "בדיקה", null, deps);
  check("replyDefer מצליח (executed)", result.status === "executed", result.status);

  check("ה-follow-up הישן (שכבר היה triggered) הושלם — לא נשאר תקוע", getFollowup(old.id)!.status === "completed");
  const fresh = listFollowups().find((f) => f.itemId === itemId && f.kind === "commitment_check" && f.status === "pending");
  check("נוצר commitment_check חדש לתאריך החדש", !!fresh && fresh.id !== old.id, JSON.stringify(fresh));
  const activeCount = listFollowups().filter((f) => f.itemId === itemId && f.kind === "commitment_check" && (f.status === "pending" || f.status === "triggered")).length;
  check("אין שני מעקבים חיים במקביל לאותה התחייבות", activeCount === 1, String(activeCount));
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. replyWaiting/replyBlocked/replyProgress לא משאירים follow-up triggered ישן
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 9. replyWaiting/replyBlocked/replyProgress מטפלים ב-follow-up ──");
{
  const simpleDeps = (): SimpleLoopReplyDeps => ({
    updateTask: async () => ({ ok: true, message: "" }),
    addTaskNote: async () => {},
  });

  for (const [label, run] of [
    ["replyWaiting", (c: LoopContext) => replyWaiting(dov, c, "client", "מחכה ללקוח", simpleDeps())],
    ["replyBlocked", (c: LoopContext) => replyBlocked(dov, c, "חסר מידע מהלקוח", simpleDeps())],
    ["replyProgress", (c: LoopContext) => replyProgress(dov, c, "עוד קצת", simpleDeps())],
  ] as const) {
    const itemId = `__fu_${label}__`;
    const findingKey = seedFinding(itemId);
    const c = baseCtx(itemId, findingKey);
    const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: now.toISODate()! });
    forceDue(f.id);
    await runDueFollowups(now, okRunnerDeps("בעבודה"));
    check(`[${label}] הכנה: ה-follow-up triggered לפני התשובה`, getFollowup(f.id)!.status === "triggered");

    const result = await run(c);
    check(`${label} מצליח`, result.ok === true);
    check(`${label}: ה-follow-up שהיה triggered מטופל (completed), לא נשאר תלוי`, getFollowup(f.id)!.status === "completed");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. זהות item_id+item_source+kind — לא finding_key. שינוי finding_key לא יוצר כפילות.
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 10. זהות לפי itemId/itemSource, לא finding_key ──");
{
  const itemId = "__fu_key_change__";
  const findingKeyA = seedFinding(itemId, `overdue:${itemId}`);
  const first = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey: findingKeyA, userKey: "dov", commitmentDateISO: overdue2d });

  // מדמים שממצא הבקרה על אותה משימה עבר ל-kind אחר (למשל stuck) — finding_key אחר לגמרי,
  // itemId זהה. בדיוק התרחיש מ-deferralHistory.ts audit (2026-09-14).
  const findingKeyB = seedFinding(itemId, `stuck:${itemId}`);
  check("finding_key אכן השתנה (הכנה)", findingKeyA !== findingKeyB);

  const second = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey: findingKeyB, userKey: "dov", commitmentDateISO: now.plus({ days: 3 }).toISODate()! });

  check("ה-commitment_check הישן (findingKey אחר) בכל זאת זוהה ובוטל — לפי itemId, לא finding_key", getFollowup(first.id)!.status === "cancelled");
  check("החדש פעיל", getFollowup(second.id)!.status === "pending");
  const activeForItem = listFollowups().filter((f) => f.itemId === itemId && f.kind === "commitment_check" && f.status === "pending");
  check("אין כפילות — רק commitment_check פעיל אחד לאותו itemId על אף שינוי finding_key", activeForItem.length === 1 && activeForItem[0]!.id === second.id);

  // item אחר לגמרי לא מתערבב.
  const otherItemId = "__fu_key_change_other__";
  const otherFindingKey = seedFinding(otherItemId);
  const other = scheduleCommitmentCheck({ itemId: otherItemId, itemSource: "general", findingKey: otherFindingKey, userKey: "dov", commitmentDateISO: overdue2d });
  check("item אחר לא הושפע כלל", getFollowup(other.id)!.status === "pending");
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. GET /api/control/followups מוגן בהרשאת owner/מוטי
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 11. הרשאת debug endpoint ──");
{
  const serverSrc = fs.readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf-8");
  const idx = serverSrc.indexOf('"/api/control/followups"');
  const routeBlock = idx >= 0 ? serverSrc.slice(idx, idx + 400) : "";
  check("ה-route בודק view:all_work ומחזיר 403 אם אין", /view:all_work/.test(routeBlock) && /403/.test(routeBlock));
  check("דוב (עובד רגיל) אין לו view:all_work — היה נחסם באותו תנאי", !userCan(dov, "view:all_work"));
  check("מוטי כן — היה עובר אותו תנאי", userCan(moti, "view:all_work"));

  // שדות דיבוג חיוניים חשופים, בלי payload חשוד — payload הוא JSON פנימי (taskName/commitmentDateISO)
  const anyFollowup = listFollowups({ limit: 1 })[0];
  if (anyFollowup) {
    check(
      "האובייקט המוחזר כולל status/dueAt/kind/itemId/userKey",
      "status" in anyFollowup && "dueAt" in anyFollowup && "kind" in anyFollowup && "itemId" in anyFollowup && "userKey" in anyFollowup,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// רגרסיה: יצירה בסיסית מ-replyDefer/approveApproval, restart, ריצה כפולה
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── רגרסיה: יצירה, restart, ריצה כפולה ──");
{
  const itemId = "__fu_defer__";
  const findingKey = seedFinding(itemId);
  const c = baseCtx(itemId, findingKey);
  const newDate = now.plus({ days: 2 }).toISODate()!;
  const deps: ReplyDeferDeps = { ...monetaryNoop(), addNotification: () => 1, recordFindingEvent: realRecordFindingEvent };
  const result = await replyDefer(dov, c, newDate, "בדיקה", null, deps);
  check("replyDefer מצליח (executed)", result.status === "executed", result.status);
  const created = listFollowups().find((f) => f.itemId === itemId && f.kind === "commitment_check");
  check("נוצר commitment_check עם dueAt=commitmentCheckDueAt(newDate) ו-findingKey/itemId נכונים", !!created && created.dueAt === commitmentCheckDueAt(newDate) && created.findingKey === findingKey);
}
{
  const itemId = "__fu_restart__";
  const findingKey = seedFinding(itemId);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: now.plus({ days: 3 }).toISODate()! });
  const fresh = new DatabaseSync("data/agent.db", { readOnly: true });
  const row = fresh.prepare(`SELECT * FROM control_followups WHERE id = ?`).get(f.id) as { status: string } | undefined;
  fresh.close();
  check("pending follow-up נקרא מחיבור SQLite חדש (persistence אמיתי)", !!row && row.status === "pending");
}
{
  const itemId = "__fu_concurrent__";
  const findingKey = seedFinding(itemId);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: now.toISODate()! });
  forceDue(f.id);
  // סופרים רק פניות שקשורות ל-followup הזה בפועל — לא נספח לספירה גלובלית, כי runDueFollowups
  // סורק את כל ה-due הפעילים (כולל שיירי followups מבדיקות קודמות שעדיין due).
  let nudgeCountForThisItem = 0;
  const deps: FollowupRunnerDeps = {
    ...okRunnerDeps("בעבודה"),
    addNotification: (userKey, kind, body, findingKeyArg, ctx) => {
      if (ctx?.itemId === itemId) nudgeCountForThisItem++;
      return 1;
    },
  };
  const p1 = runDueFollowups(now, deps);
  const p2 = runDueFollowups(now, deps);
  await Promise.all([p1, p2]);
  check("שתי קריאות runner בו-זמנית → פנייה אחת בדיוק (לא כפול על אותו followup)", nudgeCountForThisItem === 1, String(nudgeCountForThisItem));
  check("סטטוס סופי triggered אחרי המרוץ", getFollowup(f.id)!.status === "triggered");
}
{
  const itemId = "__fu_done__";
  const findingKey = seedFinding(itemId);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: now.toISODate()! });
  const c = baseCtx(itemId, findingKey);
  const deps: ReplyDoneDeps = { updateTask: async () => ({ ok: true, message: "" }), addTaskNote: async () => {} };
  const result = await replyDone(dov, c, deps);
  check("replyDone מצליח", result.ok === true);
  check("replyDone משלים follow-up פעיל", getFollowup(f.id)!.status === "completed");
}
{
  const itemId = "__fu_eod__";
  const findingKey = seedFinding(itemId);
  const priorCommitment = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO: now.toISODate()! });
  const c = baseCtx(itemId, findingKey);
  const deps: ReplyFinishingTodayDeps = { updateTask: async () => ({ ok: true, message: "" }), addTaskNote: async () => {} };
  const result = await replyFinishingToday(dov, c, deps);
  check("replyFinishingToday מצליח", result.ok === true);
  const eod = listFollowups().find((f) => f.itemId === itemId && f.kind === "end_of_day_check");
  check("נוצר end_of_day_check חדש", !!eod, JSON.stringify(listFollowups().filter((f) => f.itemId === itemId)));
  // replyFinishingToday משתמש ב-DateTime.now() האמיתי (לא מוזרק) — משווים מול "היום" האמיתי, לא מול now המדומה של שאר הבדיקות.
  const realToday = DateTime.now().setZone(env.TIMEZONE).toISODate();
  check(
    "ה-end_of_day_check ליום הנוכחי (לא לתאריך אחר)",
    !!eod && DateTime.fromISO(eod.dueAt, { zone: "utc" }).setZone(env.TIMEZONE).toISODate() === realToday,
    eod ? `dueAt=${eod.dueAt}` : "",
  );
  check("commitment_check הקודם הושלם (לא נשאר תלוי לצד ה-EOD החדש)", getFollowup(priorCommitment.id)!.status === "completed", getFollowup(priorCommitment.id)!.status);

  const src = fs.readFileSync(new URL("../src/ops/loopReply.ts", import.meta.url), "utf-8");
  const start = src.indexOf("export async function replyFinishingToday");
  const fnBody = src.slice(start, start + 1500);
  check("replyFinishingToday לא קוראת ל-setTaskDueDate", !/setTaskDueDate/.test(fnBody));
}
{
  const itemId = "__fu_missed__";
  const findingKey = seedFinding(itemId);
  const c = baseCtx(itemId, findingKey);
  const deps: ReplyDeferDeps = { ...monetaryNoop(), addNotification: () => 1, recordFindingEvent: realRecordFindingEvent };
  const first = await replyDefer(dov, c, now.plus({ days: 2 }).toISODate()!, "התחייבות ראשונה", null, deps);
  check("דחייה ראשונה executed", first.status === "executed");
  const second = await replyDefer(dov, c, now.plus({ days: 1 }).toISODate()!, "עוד קצת", null, deps);
  check("בקשה נוספת → manager_approval_required (פספוס התחייבות, מזוהה ע\"י Policy Engine)", second.status === "manager_approval_required", second.status);
}

cleanup();

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות ה-Follow-up Engine עברו ✅");
