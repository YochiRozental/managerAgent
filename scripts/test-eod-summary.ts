/**
 * סיכום סוף יום (eodSummary.ts) — DB מקומי אמיתי, אפס Monday אמיתי (כל קריאה ל-Monday מוזרקת/מדומה).
 *   npm run test:eod-summary
 */
import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../src/config/env.js";
import { db } from "../src/db/db.js";
import { upsertFinding } from "../src/db/repositories/controlFindings.js";
import { addNotification } from "../src/db/repositories/notifications.js";
import { createApproval } from "../src/db/repositories/managerApprovals.js";
import { finishJobRun, jobRunCountOn, lastJobRun, startJobRun } from "../src/db/repositories/systemHealth.js";
import {
  fetchCompletedToday,
  lastEventPerItem,
  parseStatusChangeLog,
  pickDoneCandidates,
  ticksToUnixMs,
  fetchStatusChangeEvents,
  type RawActivityLog,
  type StatusChangeEvent,
  type VerifiedGeneralItem,
  type VerifiedStageItem,
} from "../src/integrations/monday/opsActivity.js";
import {
  buildEndOfDaySummary,
  buildFindingExceptionLines,
  groupInProgressByPerson,
  renderEodSummaryText,
} from "../src/ops/eodSummary.js";
import type { OfficeState } from "../src/ops/officeState.js";
import type { DashboardTask } from "../src/ops/dashboard.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

function cleanup(): void {
  db.exec(`DELETE FROM manager_approvals WHERE item_id LIKE '%__eodsum_%'`);
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '%__eodsum_%'`);
  db.exec(`DELETE FROM control_findings WHERE item_id LIKE '%__eodsum_%'`);
  db.exec(`DELETE FROM notifications WHERE item_id LIKE '%__eodsum_%'`);
  db.exec(`DELETE FROM job_runs WHERE job = 'eod_summary_test'`);
}
cleanup();

const emptyOffice: OfficeState = {
  now: DateTime.now().setZone(env.TIMEZONE),
  generatedAt: "",
  perPerson: [],
  allTasks: [],
  projects: [],
  reverseDeps: new Map(),
};

// ─────────────────────────────────────────────────────────────────────────────
// G. ticks → unix-ms — הערך האמיתי מה-spike (2026-09-17)
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── G. ticksToUnixMs ──");
{
  const ms = ticksToUnixMs("17896378511161132");
  const dt = DateTime.fromMillis(ms, { zone: "utc" });
  check("הערך האמיתי מה-spike ממופה ל-2026, לא לתאריך שרירותי", dt.year === 2026, dt.toISO() ?? "");
  check("החודש הוא ספטמבר (תואם את זמן ריצת ה-spike)", dt.month === 9, dt.toISO() ?? "");
  let threw = false;
  try {
    ticksToUnixMs("not-a-number");
  } catch {
    threw = true;
  }
  check("קלט לא-מספרי זורק שגיאה גלויה (לא NaN שקט)", threw);
}

// ─────────────────────────────────────────────────────────────────────────────
// E/F. parseStatusChangeLog — מבנה אמיתי מה-spike, שני המקורות
// ─────────────────────────────────────────────────────────────────────────────
function fakeLog(overrides: Partial<RawActivityLog> & { dataObj: Record<string, unknown> }): RawActivityLog {
  const { dataObj, ...rest } = overrides;
  return {
    id: "1",
    event: "update_column_value",
    entity: "pulse",
    created_at: "17896378511161132",
    user_id: "62912552",
    data: JSON.stringify(dataObj),
    ...rest,
  };
}

logger.info("── E. GENERAL — done label 'בוצע' ──");
{
  const log = fakeLog({
    dataObj: {
      pulse_id: 111,
      pulse_name: "הכנת תוכניות הגשה",
      parent_item_id: null,
      column_id: "status",
      value: { label: { text: "בוצע", is_done: true } },
    },
  });
  const ev = parseStatusChangeLog(log, "status");
  check("event מזוהה נכון", !!ev && ev.itemId === "111" && ev.taskName === "הכנת תוכניות הגשה" && ev.isDone === true && ev.labelText === "בוצע");
}

logger.info("── F. PROJECT_STAGE — done label 'הושלם' ──");
{
  const log = fakeLog({
    dataObj: {
      pulse_id: 222,
      pulse_name: "בדיקת תוכנית קומה",
      parent_item_id: 999,
      column_id: "color85__1",
      value: { label: { text: "הושלם", is_done: true } },
    },
  });
  const ev = parseStatusChangeLog(log, "color85__1");
  check("event מזוהה נכון כולל parentItemId", !!ev && ev.itemId === "222" && ev.parentItemId === "999" && ev.isDone === true);
}

logger.info("── סינון: event לא-רלוונטי → null ──");
{
  const wrongEvent = fakeLog({ event: "move_pulse_from_group", dataObj: { pulse_id: 1, column_id: "status", value: {} } });
  check("event שאינו update_column_value → null", parseStatusChangeLog(wrongEvent, "status") === null);

  const wrongColumn = fakeLog({ dataObj: { pulse_id: 1, pulse_name: "x", column_id: "priority", value: { label: { text: "בוצע", is_done: true } } } });
  check("שינוי בעמודה אחרת (לא סטטוס) → null — זה בדיוק Edge Case C: 'נערך היום' בעמודה לא-רלוונטית לא נתפס", parseStatusChangeLog(wrongColumn, "status") === null);
}

// ─────────────────────────────────────────────────────────────────────────────
// D. lastEventPerItem — dedup, האחרון קובע
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── D. כמה שינויי סטטוס לאותו item באותו יום → האחרון קובע ──");
{
  const events: StatusChangeEvent[] = [
    { itemId: "5", taskName: "x", parentItemId: null, atMs: 1000, isDone: false, labelText: "לביצוע" },
    { itemId: "5", taskName: "x", parentItemId: null, atMs: 3000, isDone: true, labelText: "בוצע" },
    { itemId: "5", taskName: "x", parentItemId: null, atMs: 2000, isDone: false, labelText: "בעבודה" }, // לא בסדר כרונולוגי בקלט — עדיין לא אמור לנצח
  ];
  const last = lastEventPerItem(events);
  check("נשאר item אחד בלבד", last.size === 1);
  check("השינוי עם ה-atMs הגבוה ביותר (3000) הוא זה שנשמר", last.get("5")?.atMs === 3000 && last.get("5")?.isDone === true);
}

// ─────────────────────────────────────────────────────────────────────────────
// B. DONE ואז נפתחה מחדש היום → לא מופיעה
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── B. DONE ואז נפתחה מחדש היום → לא ברשימת המועמדים ──");
{
  const events: StatusChangeEvent[] = [
    { itemId: "6", taskName: "x", parentItemId: null, atMs: 1000, isDone: true, labelText: "בוצע" },
    { itemId: "6", taskName: "x", parentItemId: null, atMs: 2000, isDone: false, labelText: "בעבודה" }, // נפתח מחדש, מאוחר יותר
  ];
  const candidates = pickDoneCandidates(lastEventPerItem(events).values(), "בוצע");
  check("הפריט לא ברשימת המועמדים — האחרון הוא 'נפתח מחדש'", candidates.length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Q. Pagination — לא מאבד events מעבר ל-500
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── Q. Pagination — 500+137 events בשני עמודים, לא נאבד כלום ──");
{
  const page1 = Array.from({ length: 500 }, (_, i) =>
    fakeLog({ dataObj: { pulse_id: i, pulse_name: `t${i}`, column_id: "status", value: { label: { text: "בוצע", is_done: true } } } }),
  );
  const page2 = Array.from({ length: 137 }, (_, i) =>
    fakeLog({ dataObj: { pulse_id: 1000 + i, pulse_name: `t${1000 + i}`, column_id: "status", value: { label: { text: "בוצע", is_done: true } } } }),
  );
  const pagesRequested: number[] = [];
  const events = await fetchStatusChangeEvents("1550734526", "status", "2026-01-01T00:00:00Z", "2026-01-01T23:59:59Z", {
    requestPage: async (_b, _c, _f, _t, _limit, page) => {
      pagesRequested.push(page);
      if (page === 1) return page1;
      if (page === 2) return page2;
      return [];
    },
  });
  check("כל 637 האירועים נאספו (לא נאבד כלום)", events.length === 637, String(events.length));
  check("נדרשו בדיוק 2 עמודים (עמוד 2 חזר עם פחות מ-limit → נעצר, לא ביקש עמוד 3)", pagesRequested.length === 2, JSON.stringify(pagesRequested));
}

// ─────────────────────────────────────────────────────────────────────────────
// A + I + C + H. fetchCompletedToday — זרימה מלאה עם Monday מדומה
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── A. completed today רגיל — general, מאומת, מיוחס לפי עמודת אחראי ──");
{
  const now = DateTime.now().setZone(env.TIMEZONE);
  const items = await fetchCompletedToday(now, {
    fetchGeneralEvents: async () => [
      { itemId: "301", taskName: "הכנת תוכניות הגשה", parentItemId: null, atMs: Date.now(), isDone: true, labelText: "בוצע" },
    ],
    fetchStageEvents: async () => [],
    verifyGeneralStillDone: async (ids) => {
      const map = new Map<string, VerifiedGeneralItem>();
      if (ids.includes("301")) map.set("301", { status: "בוצע", assignees: "דוב שפירא", project: "" });
      return map;
    },
  });
  check("פריט אחד הוחזר", items.length === 1, JSON.stringify(items));
  check("שם המשימה מ-pulse_name", items[0]?.taskName === "הכנת תוכניות הגשה");
  check(
    "I: האחראי מגיע מעמודת ה-person (verify) — לא מ-activity_log.user_id (ל-event הזה כלל אין user_id בשימוש)",
    items[0]?.assignees === "דוב שפירא",
  );
}

logger.info("── עדכון מקביל: מועמד ל-DONE שבפועל כבר לא DONE ברגע האימות → לא נכלל (race/מרוץ) ──");
{
  const now = DateTime.now().setZone(env.TIMEZONE);
  const items = await fetchCompletedToday(now, {
    fetchGeneralEvents: async () => [
      { itemId: "302", taskName: "x", parentItemId: null, atMs: Date.now(), isDone: true, labelText: "בוצע" },
    ],
    fetchStageEvents: async () => [],
    verifyGeneralStillDone: async () => new Map([["302", { status: "בעבודה", assignees: "דוב שפירא", project: "" }]]), // כבר נפתח מחדש
  });
  check("הפריט לא נכלל — האימות ה-batched חוסם false positive", items.length === 0);
}

logger.info("── C. אין שום event על עמודת הסטטוס היום → לא מופיעה (גם אם 'בוצע' מלפני היום) ──");
{
  const now = DateTime.now().setZone(env.TIMEZONE);
  const items = await fetchCompletedToday(now, { fetchGeneralEvents: async () => [], fetchStageEvents: async () => [] });
  check("רשימה ריקה — שום event לא נראה, שום ניחוש", items.length === 0);
}

logger.info("── F (המשך): project_stage מלא — context של שלב/פרויקט מגיע מ-parent_item_id ──");
{
  const now = DateTime.now().setZone(env.TIMEZONE);
  const items = await fetchCompletedToday(now, {
    fetchGeneralEvents: async () => [],
    fetchStageEvents: async () => [
      { itemId: "401", taskName: "בדיקת תוכנית קומה", parentItemId: "500", atMs: Date.now(), isDone: true, labelText: "הושלם" },
    ],
    verifyStageStillDone: async () => {
      const map = new Map<string, VerifiedStageItem>();
      map.set("401", { status: "הושלם", assignees: "יוכי", parentItemId: "500" });
      return map;
    },
    resolveProjectContext: async () => new Map([["500", { stageName: "שלב 2", project: "בלומינג" }]]),
  });
  check("פריט project_stage הוחזר עם context מלא", items.length === 1 && items[0]?.project === "בלומינג" && items[0]?.stageName === "שלב 2");
}

logger.info("── H. גבול Asia/Jerusalem נכון — לא UTC ──");
{
  // 2026-09-17 20:00 שעון ישראל (UTC+3) → תחילת היום המקומי = 2026-09-17T00:00 → UTC 2026-09-16T21:00:00Z
  const now = DateTime.fromObject({ year: 2026, month: 9, day: 17, hour: 20, minute: 0 }, { zone: "Asia/Jerusalem" });
  let capturedFrom = "";
  let capturedTo = "";
  await fetchCompletedToday(now, {
    fetchGeneralEvents: async (from, to) => {
      capturedFrom = from;
      capturedTo = to;
      return [];
    },
    fetchStageEvents: async () => [],
  });
  check("from = תחילת היום ב-Asia/Jerusalem, מומר ל-UTC (לא 00:00 UTC)", capturedFrom === "2026-09-16T21:00:00.000Z", capturedFrom);
  check("to = 'עכשיו' ב-UTC", capturedTo === now.toUTC().toISO(), capturedTo);
}

// ─────────────────────────────────────────────────────────────────────────────
// J. עדיין בעבודה — מקובץ לפי עובד
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── J. groupInProgressByPerson — מקובץ לפי עובד, רק status==='בעבודה' ──");
{
  const dov = { key: "dov", name: "דוב שפירא", role: "project_manager", mondayUserId: "62982081", email: null, whatsappJid: null } as const;
  const yochi = { key: "yochi", name: "יוכי", role: "admin", mondayUserId: "71724151", email: null, whatsappJid: null } as const;
  const mkTask = (name: string, status: string, context = "משימת משרד"): DashboardTask =>
    ({
      source: "general",
      itemId: name,
      name,
      url: "",
      context,
      status,
      assignees: "",
      flags: { overdue: false, daysOverdue: 0, dueToday: false, dueThisWeek: false, stuck: false, critical: false, waitingExternal: false, blocking: [] },
    }) as DashboardTask;

  const office: OfficeState = {
    ...emptyOffice,
    perPerson: [
      { member: dov as any, tasks: [mkTask("תוכנית חשמל", "בעבודה", "בלומינג"), mkTask("סיימתי כבר", "בוצע"), mkTask("לביצוע עתידי", "לביצוע")] },
      { member: yochi as any, tasks: [mkTask("בדיקת היתר", "בעבודה")] },
    ],
  };
  const grouped = groupInProgressByPerson(office);
  check("רק 2 עובדים עם 'בעבודה' בפועל", grouped.size === 2);
  check("דוב: רק המשימה שבאמת 'בעבודה', עם context", grouped.get("דוב שפירא")?.length === 1 && grouped.get("דוב שפירא")![0] === "תוכנית חשמל (בלומינג)");
  check("יוכי: משימת משרד בלי context מיותר", grouped.get("יוכי")?.[0] === "בדיקת היתר");
}

// ─────────────────────────────────────────────────────────────────────────────
// N. renderEodSummaryText — sections ריקים מושמטים, fallback מדויק
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── N. sections ריקים מושמטים ──");
{
  const now = DateTime.now().setZone(env.TIMEZONE);
  const allEmpty = renderEodSummaryText({
    now,
    completedByPerson: new Map(),
    inProgressByPerson: new Map(),
    exceptions: [],
    deferralsAndCommitments: [],
    pendingApprovals: [],
    decidedApprovalsNote: null,
  });
  check("הכל ריק → הודעת ה-fallback המדויקת", allEmpty === "📋 סיכום סוף יום\n\nסיכום היום: לא נרשמה פעילות או חריגה הדורשת סיכום.", allEmpty);

  const onlyCompleted = renderEodSummaryText({
    now,
    completedByPerson: new Map([["דוב שפירא", ["הכנת תוכניות הגשה"]]]),
    inProgressByPerson: new Map(),
    exceptions: [],
    deferralsAndCommitments: [],
    pendingApprovals: [],
    decidedApprovalsNote: null,
  });
  check("רק 'הסתיים היום' קיים — שאר הכותרות לא מופיעות בכלל", onlyCompleted.includes("✅ הסתיים היום") && !onlyCompleted.includes("🔄") && !onlyCompleted.includes("⚠️") && !onlyCompleted.includes("⏰") && !onlyCompleted.includes("🔔"));
}

// ─────────────────────────────────────────────────────────────────────────────
// K, L, M — DB מקומי אמיתי: scopeChange, missed-commitment dedup, pending approval
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── K + L + M. buildEndOfDaySummary עם DB מקומי אמיתי (Monday מדומה — ריק) ──");
{
  const now = DateTime.now().setZone(env.TIMEZONE);

  // מזהים ייחודיים כדי לא להתנגש עם ממצאים/אישורים אמיתיים שכבר קיימים ב-DB המקומי המשותף
  // (הבדיקות האלה רצות מול ה-sqlite האמיתי של הפרויקט, לפי מוסכמת test-eod-engine.ts).
  const TAG = "__EODSUM_TEST__";

  // K: דחייה עם scopeChange=true
  const itemIdDefer = "__eodsum_defer__";
  const findingKeyDefer = `overdue:${itemIdDefer}`;
  upsertFinding({
    findingKey: findingKeyDefer,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: `באיחור 2 ימים: תוכנית חשמל ${TAG}`,
    detail: "בדיקה",
    itemId: itemIdDefer,
    itemSource: "general",
    now: now.toISO()!,
  });
  db.prepare(
    `INSERT INTO finding_events (finding_key, event, payload_json) VALUES (?, 'snoozed', ?)`,
  ).run(findingKeyDefer, JSON.stringify({ byUser: "dov", snoozeUntil: now.plus({ days: 3 }).toISODate(), scopeChange: true }));

  // L: missed commitment — finding + notification עם context.missedCommitment=true, אותו findingKey
  const itemIdMissed = "__eodsum_missed__";
  const findingKeyMissed = `overdue:${itemIdMissed}`;
  upsertFinding({
    findingKey: findingKeyMissed,
    kind: "overdue_stale",
    severity: "high",
    who: "יוכי",
    headline: `באיחור: בדיקת תוכנית קומה ${TAG}`,
    detail: "בדיקה",
    itemId: itemIdMissed,
    itemSource: "general",
    now: now.toISO()!,
  });
  addNotification("moti", "awaiting_decision", "יוכי לא סיים היום", findingKeyMissed, {
    itemId: itemIdMissed,
    itemSource: "general",
    context: { missedCommitment: true, employeeName: "יוכי", taskName: `בדיקת תוכנית קומה ${TAG}` },
  });

  // M: pending approval
  const itemIdApproval = "__eodsum_approval__";
  createApproval({
    kind: "deferral",
    requestedBy: "dov",
    managerUserKey: "moti",
    itemId: itemIdApproval,
    itemSource: "general",
    taskName: `חזית צפונית ${TAG}`,
    payload: { requestedNewDueDate: now.plus({ days: 5 }).toISODate() },
  });

  const result = await buildEndOfDaySummary({
    fetchCompletedToday: async () => [],
    getOfficeState: async () => emptyOffice,
  });

  check("K: הדחייה מופיעה עם 'שינוי היקף'", result.text.includes("שינוי היקף") && result.text.includes(`תוכנית חשמל ${TAG}`), result.text);
  check("L: ה-missed commitment מופיע פעם אחת תחת 'דחיות והתחייבויות'", (result.text.match(new RegExp(`בדיקת תוכנית קומה ${TAG}`, "g")) ?? []).length === 1, result.text);
  check("L: לא מופיע שוב תחת 'דורש תשומת לב' (dedup לפי findingKey)", (() => {
    const exceptionsSection = result.text.split("⚠️ דורש תשומת לב")[1]?.split("⏰")[0] ?? "";
    return !exceptionsSection.includes(`בדיקת תוכנית קומה ${TAG}`);
  })());
  check("M: האישור הממתין מופיע תחת 'ממתין לאישור מוטי'", result.text.includes("🔔 ממתין לאישור מוטי") && result.text.includes(`חזית צפונית ${TAG}`), result.text);

  // דוגמה מלאה — לצירוף לדוח הסיום (item 3 בבקשת המשתמש)
  logger.info(`\n--- דוגמת EOD Summary מלאה (מ-test K/L/M) ---\n${result.text}\n--- סוף הדוגמה ---`);
}

// ─────────────────────────────────────────────────────────────────────────────
// E, F — visibleForReports מחובר ל-EOD summary: snoozed פעיל לא מוצג, וחוזר אחרי שה-snooze פג.
//
// נבדק ישירות על buildFindingExceptionLines (הפונקציה המדויקת שבונה את סעיף "⚠️" בתוך
// buildEndOfDaySummary) עם fixture מבודד — לא דרך הפלט המלא/המקוצץ (cap=8), כי ה-DB המקומי
// המשותף כבר מכיל עשרות ממצאים אמיתיים בחומרה גבוהה שהיו דוחקים את פריט הבדיקה מחוץ לתצוגה
// המקוצצת בלי שום קשר לתקינות הסינון עצמו. K/L/M וה-fixture הסוגר למטה כבר מוכיחים שהנתיב המלא
// (buildEndOfDaySummary → buildFindingExceptionLines) מחובר נכון.
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── E. finding עם snooze פעיל → buildFindingExceptionLines מסנן אותו ──");
{
  const now = DateTime.now().setZone(env.TIMEZONE);
  const itemId = "__eodsum_snoozed_active__";
  const findingKey = `overdue:${itemId}`;
  const created = upsertFinding({
    findingKey,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: "באיחור 4 ימים: תוכנית מים",
    detail: "בדיקה",
    itemId,
    itemSource: "general",
    now: now.toISO()!,
  });
  db.prepare(`INSERT INTO finding_events (finding_key, event, payload_json) VALUES (?, 'snoozed', ?)`).run(
    findingKey,
    JSON.stringify({ byUser: "dov", snoozeUntil: now.plus({ days: 3 }).toISODate() }), // snooze עתידי — עדיין בתוקף
  );

  const lines = buildFindingExceptionLines([created], new Set(), now);
  check("E: ממצא עם snooze פעיל לא מופיע ב-'⚠️ דורש תשומת לב'", lines.length === 0, JSON.stringify(lines));
}

logger.info("── F. אותו finding אחרי שה-snooze פג → buildFindingExceptionLines מציג אותו, בלי פעולה ידנית ──");
{
  const now = DateTime.now().setZone(env.TIMEZONE);
  const itemId = "__eodsum_snoozed_expired__";
  const findingKey = `overdue:${itemId}`;
  const created = upsertFinding({
    findingKey,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: "באיחור 6 ימים: תוכנית מים",
    detail: "בדיקה",
    itemId,
    itemSource: "general",
    now: now.toISO()!,
  });
  db.prepare(`INSERT INTO finding_events (finding_key, event, payload_json) VALUES (?, 'snoozed', ?)`).run(
    findingKey,
    JSON.stringify({ byUser: "dov", snoozeUntil: now.minus({ days: 2 }).toISODate() }), // snooze כבר פג
  );

  const lines = buildFindingExceptionLines([created], new Set(), now);
  check(
    "F: אחרי שה-snoozeUntil עבר — הממצא חוזר להופיע ב-'⚠️ דורש תשומת לב', בלי שום פעולה ידנית",
    lines.length === 1 && lines[0]!.includes("תוכנית מים"),
    JSON.stringify(lines),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// בדיקת סגירה (אישור לפני commit) — fixture מקומי מלא: 2 עובדים ב"הסתיים היום",
// 2 עובדים ב"עדיין בעבודה" (3 משימות), missed commitment, deferral עם scopeChange, pending approval.
// Monday מדומה לחלוטין (fetchCompletedToday + getOfficeState מוזרקים) — DB מקומי אמיתי לשאר.
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── בדיקת סגירה: fixture מלא, כל 5 הסעיפים יחד ──");
{
  const now = DateTime.now().setZone(env.TIMEZONE);
  const CTAG = "__EODSUM_CLOSING__";

  const mkDashTask = (name: string, status: string): DashboardTask =>
    ({
      source: "general",
      itemId: `${name}`,
      name,
      url: "",
      context: "משימת משרד",
      status,
      assignees: "",
      flags: { overdue: false, daysOverdue: 0, dueToday: false, dueThisWeek: false, stuck: false, critical: false, waitingExternal: false, blocking: [] },
    }) as DashboardTask;

  const dovMember = { key: "dov", name: "דוב שפירא", role: "project_manager", mondayUserId: "62982081", email: null, whatsappJid: null } as const;
  const yochiMember = { key: "yochi", name: "יוכי", role: "admin", mondayUserId: "71724151", email: null, whatsappJid: null } as const;

  const fixtureOffice: OfficeState = {
    ...emptyOffice,
    perPerson: [
      {
        member: dovMember as any,
        tasks: [mkDashTask(`תוכנית חשמל ${CTAG}`, "בעבודה"), mkDashTask(`חזית צפונית ${CTAG}`, "בעבודה")],
      },
      { member: yochiMember as any, tasks: [mkDashTask(`בדיקת היתר ${CTAG}`, "בעבודה")] },
    ],
  };

  // completed today — activity-log user_id שונה בכוונה מהאחראי בפועל (62912552=מוטי), כדי להוכיח
  // ש-attribution בא מעמודת ה-person (assignees) שכבר מוטמעת ב-CompletedTodayItem, לא מ-activity user_id.
  const fixtureCompleted = [
    { source: "general" as const, itemId: "c1", taskName: `הכנת תוכניות הגשה ${CTAG}`, assignees: "דוב שפירא" },
    { source: "general" as const, itemId: "c2", taskName: `תיקון חזיתות ${CTAG}`, assignees: "דוב שפירא" },
    { source: "general" as const, itemId: "c3", taskName: `בדיקת תוכנית קומה ${CTAG}`, assignees: "יוכי" },
  ];

  // missed commitment — רוחמה
  const itemIdMissed2 = "__eodsum_closing_missed__";
  const findingKeyMissed2 = `overdue:${itemIdMissed2}`;
  upsertFinding({
    findingKey: findingKeyMissed2,
    kind: "overdue_stale",
    severity: "high",
    who: "רוחמה מינצר",
    headline: `באיחור: הגשת מכרז ${CTAG}`,
    detail: "בדיקה",
    itemId: itemIdMissed2,
    itemSource: "general",
    now: now.toISO()!,
  });
  addNotification("moti", "awaiting_decision", "רוחמה לא סיימה היום", findingKeyMissed2, {
    itemId: itemIdMissed2,
    itemSource: "general",
    context: { missedCommitment: true, employeeName: "רוחמה מינצר", taskName: `הגשת מכרז ${CTAG}` },
  });

  // deferral עם scopeChange=true — דוב
  const itemIdDefer2 = "__eodsum_closing_defer__";
  const findingKeyDefer2 = `overdue:${itemIdDefer2}`;
  upsertFinding({
    findingKey: findingKeyDefer2,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: `באיחור 3 ימים: עריכת תכניות ${CTAG}`,
    detail: "בדיקה",
    itemId: itemIdDefer2,
    itemSource: "general",
    now: now.toISO()!,
  });
  db.prepare(`INSERT INTO finding_events (finding_key, event, payload_json) VALUES (?, 'snoozed', ?)`).run(
    findingKeyDefer2,
    JSON.stringify({ byUser: "dov", snoozeUntil: now.plus({ days: 4 }).toISODate(), scopeChange: true }),
  );

  // pending approval — דוב
  const itemIdApproval2 = "__eodsum_closing_approval__";
  createApproval({
    kind: "deferral",
    requestedBy: "dov",
    managerUserKey: "moti",
    itemId: itemIdApproval2,
    itemSource: "general",
    taskName: `פרגולה ${CTAG}`,
    payload: { requestedNewDueDate: now.plus({ days: 6 }).toISODate() },
  });

  const closing = await buildEndOfDaySummary({
    fetchCompletedToday: async () => fixtureCompleted,
    getOfficeState: async () => fixtureOffice,
  });

  logger.info(`\n=== OUTPUT מלא של ה-builder (fixture סגירה) ===\n${closing.text}\n=== סוף OUTPUT ===`);

  // ---- אימותים מפורשים לפי הדרישה ----
  check("✅ הסתיים היום: מכיל את שני העובדים", closing.text.includes("דוב שפירא:") && closing.text.includes("יוכי:"));
  check(
    "attribution: 'הכנת תוכניות הגשה'+'תיקון חזיתות' תחת דוב שפירא, לא לפי activity user_id (לא נשלח כלל ב-fixture)",
    (() => {
      const block = closing.text.split("✅ הסתיים היום")[1]?.split("🔄")[0] ?? "";
      const dovLines = block.split("דוב שפירא:")[1]?.split(/\n\n|יוכי:/)[0] ?? "";
      return dovLines.includes(`הכנת תוכניות הגשה ${CTAG}`) && dovLines.includes(`תיקון חזיתות ${CTAG}`);
    })(),
    closing.text,
  );
  check(
    "attribution: 'בדיקת תוכנית קומה' תחת יוכי",
    (closing.text.split("✅ הסתיים היום")[1]?.split("🔄")[0] ?? "").includes(`בדיקת תוכנית קומה ${CTAG}`),
  );

  check("🔄 עדיין בעבודה: מכיל את שני העובדים", closing.text.includes("תוכנית חשמל") && closing.text.includes("בדיקת היתר"));
  const inProgressBlock = closing.text.split("🔄 עדיין בעבודה")[1]?.split("⚠️")[0] ?? "";
  check("in-progress: 3 המשימות מופיעות (2 אצל דוב, 1 אצל יוכי)", (inProgressBlock.match(new RegExp(CTAG, "g")) ?? []).length >= 3, inProgressBlock);

  // בדיקת "אין אותה משימה פעמיים באותו section" — כללית, על כל הפלט: לכל שורת בולט, לא מופיעה
  // פעמיים בתוך אותו בלוק section.
  const sectionBlocks = closing.text.split(/\n\n(?=[✅🔄⚠️⏰🔔])/);
  let dupFound = false;
  for (const block of sectionBlocks) {
    const bullets = block.split("\n").filter((l) => l.trim().startsWith("•"));
    const seen = new Set(bullets);
    if (seen.size !== bullets.length) dupFound = true;
  }
  check("אין אותה שורת בולט פעמיים באותו section", !dupFound);

  // "אין יותר מ-section אחד עבור אותו סוג מידע" — כל כותרת מופיעה לכל היותר פעם אחת
  for (const header of ["✅ הסתיים היום", "🔄 עדיין בעבודה", "⚠️ דורש תשומת לב", "⏰ דחיות והתחייבויות", "🔔 ממתין לאישור מוטי"]) {
    const count = closing.text.split(header).length - 1;
    check(`כותרת "${header}" מופיעה לכל היותר פעם אחת`, count <= 1, `count=${count}`);
  }

  check("⏰ דחיות והתחייבויות: מכיל גם deferral (scopeChange) וגם missed commitment", closing.text.includes("שינוי היקף") && closing.text.includes(`הגשת מכרז ${CTAG}`));
  check("🔔 ממתין לאישור מוטי: מכיל את האישור החדש", closing.text.includes(`פרגולה ${CTAG}`));

  check("הפלט לא ארוך מדי (סיכום ניהולי, לא dump) — מתחת ל-3000 תווים", closing.text.length < 3000, String(closing.text.length));
}

// ─────────────────────────────────────────────────────────────────────────────
// O, P — job_runs: dedup + catch-up (אותו מנגנון גנרי כמו daily_cycle/weekly_report — לא נבנה חדש)
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── O. job_runs מונע ריצה כפולה — אותו מנגנון גנרי בדיוק ──");
{
  const today = DateTime.now().setZone(env.TIMEZONE).toISODate()!;
  check("לפני ריצה — 0 ריצות היום", jobRunCountOn("eod_summary_test", today) === 0);
  const id = startJobRun("eod_summary_test", "schedule");
  finishJobRun(id, true);
  check(
    "אחרי ריצה מוצלחת — jobRunCountOn===1 (זה בדיוק התנאי ש-catchUp() ב-scheduler.ts בודק לפני שהוא מדלג על ריצה נוספת היום)",
    jobRunCountOn("eod_summary_test", today) === 1,
  );
  check("lastJobRun משקף ok=1, finished_at קיים (לא 'תקוע')", lastJobRun("eod_summary_test")?.ok === 1 && !!lastJobRun("eod_summary_test")?.finishedAt);
}

logger.info("── P. ריצה תקועה (קריסה) — סימני 'תקוע' זמינים לזיהוי, לא מסומן ok ──");
{
  const today = DateTime.now().setZone(env.TIMEZONE).toISODate()!;
  db.exec(`DELETE FROM job_runs WHERE job = 'eod_summary_test'`);
  const id = startJobRun("eod_summary_test", "schedule");
  // מדמים קריסה: לא קוראים ל-finishJobRun בכלל, ומזייפים started_at לפני 40 דקות.
  db.prepare(`UPDATE job_runs SET started_at = datetime('now', '-40 minutes') WHERE id = ?`).run(id);
  const last = lastJobRun("eod_summary_test");
  check("ריצה תקועה: ok===null, אין finished_at — בדיוק הסימן ש-catchUp() מזהה כ'תקוע' ומריץ שוב", last?.ok === null && !last?.finishedAt);
  check("עדיין נספרת כ'רצה היום' (jobRunCountOn) — ההגנה מפני כפילות היא ברמת 'תקוע', לא ברמת ספירה", jobRunCountOn("eod_summary_test", today) === 1);
}

cleanup();

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות סיכום סוף היום עברו ✅ (אפס קריאות Monday אמיתיות)");
