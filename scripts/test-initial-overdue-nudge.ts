/**
 * Rule 1 — פנייה ראשונית ביום הגילוי (audit/design 2026-09-16/17, מאושר). בדיקות ל:
 *   - runInitialOverdueNudgePass (escalation.ts) — מי מקבל nudge מיידי ומי לא, idempotency.
 *   - scheduleInitialNudgeFollowup (followups.ts) — תזמון 3 שעות / גלגול ליום העסקים הבא.
 *   - processInitialNudgeReminder/processInitialNudgeEod (דרך runDueFollowups) — תגובת עובד
 *     סוגרת את שני השלבים, task שנסגר ב-Monday נסגר בשקט.
 * DB מקומי אמיתי, אפס Monday אמיתי (getTaskStatusLabel מוזרק).
 *
 *   npm run test:initial-overdue-nudge
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { db } from "../src/db/db.js";
import { upsertFinding, listActiveFindings, type StoredFinding } from "../src/db/repositories/controlFindings.js";
import { addNotification, hasUnseenNotificationForKind, listUnseenNudges } from "../src/db/repositories/notifications.js";
import { recordFindingEvent } from "../src/db/repositories/findingEvents.js";
import { completeActiveFollowupsForItem, type StoredFollowup } from "../src/db/repositories/controlFollowups.js";
import { buildInitialOverdueNudgeText, escalationNotifContext, runInitialOverdueNudgePass } from "../src/ops/escalation.js";
import { scheduleInitialNudgeFollowup, runDueFollowups, type FollowupRunnerDeps } from "../src/ops/followups.js";
import type { OpsTaskSource } from "../src/integrations/monday/opsRead.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const MARK = "__init_nudge_test__";
const DOV = "דוב שפירא"; // חבר צוות אמיתי, resolveUsersByAssigneeText מוצא אותו ישירות לפי שם

function cleanup(): void {
  db.exec(`DELETE FROM control_followups WHERE item_id LIKE '${MARK}%'`);
  db.exec(`DELETE FROM notifications WHERE finding_key LIKE '${MARK}%'`);
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '${MARK}%'`);
  db.exec(`DELETE FROM control_findings WHERE finding_key LIKE '${MARK}%'`);
}
cleanup();

const now = () => DateTime.now().setZone("Asia/Jerusalem");
const nowIso = () => now().toISO()!;

function findingByKey(findingKey: string): StoredFinding | undefined {
  return listActiveFindings().find((f) => f.findingKey === findingKey);
}

function followupRow(itemId: string, kind: string): { id: number; status: string; due_at: string } | undefined {
  return db
    .prepare(`SELECT id, status, due_at FROM control_followups WHERE item_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`)
    .get(itemId, kind) as { id: number; status: string; due_at: string } | undefined;
}

function seed(overrides: Partial<Parameters<typeof upsertFinding>[0]> & { findingKey: string; itemId: string }): StoredFinding {
  return upsertFinding({
    kind: "overdue_stale",
    severity: "high",
    who: DOV,
    project: "בדיקת פנייה ראשונית",
    headline: `באיחור 3 ימים: משימת בדיקה ${overrides.findingKey}`,
    detail: "פרטים",
    itemSource: "general",
    dueDate: DateTime.now().minus({ days: 3 }).toISODate()!,
    now: nowIso(),
    ...overrides,
  });
}

async function main(): Promise<void> {
  // ---- 1. finding חדש eligible → nudge מיידי + level 1 ----
  const fk1 = `${MARK}:new-eligible`;
  seed({ findingKey: fk1, itemId: "it-1" });
  runInitialOverdueNudgePass(now());

  const unseen1 = listUnseenNudges("dov").filter((n) => n.findingKey === fk1 && n.kind === "nudge");
  check("1. nudge נוצר לדוב", unseen1.length === 1, `קיבל: ${unseen1.length}`);
  check("1. nudge נושא itemId+itemSource", unseen1[0]?.itemId === "it-1" && unseen1[0]?.itemSource === "general");
  check(
    "1. nudge נושא taskName ב-context",
    !!(unseen1[0]?.context as { taskName?: string } | null)?.taskName,
  );
  check("1. escalationLevel קודם ל-1", findingByKey(fk1)?.escalationLevel === 1);
  const fu1 = followupRow("it-1", "initial_nudge_reminder");
  check("1. initial_nudge_reminder תוזמן", !!fu1 && fu1.status === "pending");

  // ---- 2. finding קיים (level 0, מעולם לא קיבל nudge) → מקבל nudge ----
  // מדמה בדיוק את overdue:3225641440: upsertFinding כבר רץ פעם (finding "קיים"), ורק עכשיו
  // מריצים את runInitialOverdueNudgePass (כאילו זה deployment שרץ אחרי שה-finding כבר היה שם).
  const fk2 = `${MARK}:pre-existing`;
  seed({ findingKey: fk2, itemId: "it-2", now: DateTime.now().minus({ hours: 2 }).toISO()! }); // "existing" — נוצר קודם
  check("2. לפני ה-pass: escalationLevel=0 ולא נשלחה שום פנייה", findingByKey(fk2)?.escalationLevel === 0 && !hasUnseenNotificationForKind("dov", fk2, "nudge"));
  runInitialOverdueNudgePass(now());
  check("2. אחרי ה-pass: nudge נשלח", hasUnseenNotificationForKind("dov", fk2, "nudge"));
  check("2. אחרי ה-pass: escalationLevel=1", findingByKey(fk2)?.escalationLevel === 1);

  // ---- 3. ריצה כפולה → אין nudge כפול ----
  const before3 = listUnseenNudges("dov").filter((n) => n.findingKey === fk1).length;
  runInitialOverdueNudgePass(now()); // ריצה שנייה על כל ה-findings, כולל fk1/fk2 שכבר טופלו
  const after3 = listUnseenNudges("dov").filter((n) => n.findingKey === fk1).length;
  check("3. ריצה כפולה לא יוצרת nudge שני", before3 === 1 && after3 === 1, `לפני=${before3} אחרי=${after3}`);
  check("3. escalationLevel נשאר 1 (לא עולה שוב)", findingByKey(fk1)?.escalationLevel === 1);

  // ---- 3b. dedup ברמת DB — לא רק escalationLevel (דרישה מפורשת): מדמים קריסה בדיוק בין
  // addNotification ל-setEscalation (ה-nudge כבר קיים ב-DB, אבל escalationLevel עדיין 0, כאילו
  // התהליך מת שם). "restart" = הרצה נוספת של ה-pass. חייב לא ליצור נודג' שני, ורק להשלים את הסימון.
  const fk3b = `${MARK}:crash-window`;
  const finding3b = seed({ findingKey: fk3b, itemId: "it-3b" });
  addNotification("dov", "nudge", buildInitialOverdueNudgeText(finding3b), fk3b, escalationNotifContext(finding3b));
  check(
    "3b. הכנה: אחרי 'קריסה' מדומה — נודג' כבר קיים אבל escalationLevel עדיין 0",
    hasUnseenNotificationForKind("dov", fk3b, "nudge") && findingByKey(fk3b)?.escalationLevel === 0,
  );

  runInitialOverdueNudgePass(now()); // "restart" — ה-pass רץ שוב על אותו finding

  const afterCrash3b = listUnseenNudges("dov").filter((n) => n.findingKey === fk3b);
  check("3b. אחרי restart: עדיין נודג' יחיד (לא כפול)", afterCrash3b.length === 1, `קיבל: ${afterCrash3b.length}`);
  check("3b. אחרי restart: escalationLevel הושלם ל-1", findingByKey(fk3b)?.escalationLevel === 1);

  // ---- 4. assignee לא מזוהה → אין nudge ואין level advancement ----
  const fk4 = `${MARK}:no-assignee`;
  seed({ findingKey: fk4, itemId: "it-4", who: "שם שלא קיים בשום ספר צוות" });
  runInitialOverdueNudgePass(now());
  const allUnseen4 = ["moti", "dov", "eitan", "ruchama", "yochi"].flatMap((u) =>
    listUnseenNudges(u).filter((n) => n.findingKey === fk4),
  );
  check("4. אין נודג' לאף אחד כש-assignee לא מזוהה", allUnseen4.length === 0, `קיבל: ${allUnseen4.length}`);
  check("4. escalationLevel נשאר 0 — eligible לניסיון הבא", findingByKey(fk4)?.escalationLevel === 0);

  // ---- 5. finding בלי item identity → לא מטופל ----
  const fk5 = `${MARK}:no-identity`;
  seed({ findingKey: fk5, itemId: undefined as unknown as string, itemSource: undefined });
  runInitialOverdueNudgePass(now());
  check("5. אין nudge כש-itemId/itemSource חסרים", !hasUnseenNotificationForKind("dov", fk5, "nudge"));
  check("5. escalationLevel נשאר 0", findingByKey(fk5)?.escalationLevel === 0);

  // ---- 6. stuck → לא מטופל (מחוץ לסקופ) ----
  const fk6 = `${MARK}:stuck-out-of-scope`;
  seed({ findingKey: fk6, itemId: "it-6", kind: "stuck", headline: "תקוע: משהו" });
  runInitialOverdueNudgePass(now());
  check("6. stuck לא מקבל פנייה ראשונית", !hasUnseenNotificationForKind("dov", fk6, "nudge"));
  check("6. escalationLevel נשאר 0", findingByKey(fk6)?.escalationLevel === 0);

  // ---- 7. resolved_by_reply / snoozed → לא מטופל ----
  const fk7a = `${MARK}:resolved`;
  seed({ findingKey: fk7a, itemId: "it-7a" });
  recordFindingEvent(fk7a, "resolved_by_reply", { action: "test" });
  runInitialOverdueNudgePass(now());
  check("7a. resolved_by_reply → אין nudge", !hasUnseenNotificationForKind("dov", fk7a, "nudge"));

  const fk7b = `${MARK}:snoozed`;
  seed({ findingKey: fk7b, itemId: "it-7b" });
  recordFindingEvent(fk7b, "snoozed", { snoozeUntil: DateTime.now().plus({ days: 3 }).toISODate() });
  runInitialOverdueNudgePass(now());
  check("7b. snoozed → אין nudge", !hasUnseenNotificationForKind("dov", fk7b, "nudge"));

  // ---- 8. critical (blocking_stale, כבר "מטופל" ע"י מסלול ה-escalation הרגיל) → אין כפילות ----
  const fk8 = `${MARK}:critical-blocking`;
  seed({ findingKey: fk8, itemId: "it-8", kind: "blocking_stale", severity: "critical", headline: "באיחור 5 ימים וחוסם 2: X" });
  runInitialOverdueNudgePass(now());
  check(
    "8. critical (target=3 מיד) — ה-pass החדש לא שולח בעצמו, משאיר למסלול ההסלמה הרגיל",
    !hasUnseenNotificationForKind("dov", fk8, "nudge") && findingByKey(fk8)?.escalationLevel === 0,
  );

  // ==== scheduleInitialNudgeFollowup — תזמון ====

  // ---- 9. מוקדם ביום → reminder אחרי 3 שעות ----
  const sent9 = DateTime.fromISO("2026-09-16T07:00:00", { zone: "Asia/Jerusalem" }); // יום ד'
  const fu9 = scheduleInitialNudgeFollowup(
    { itemId: `${MARK}-9`, itemSource: "general" as OpsTaskSource, findingKey: `${MARK}:t9`, userKey: "dov", taskName: "משימת בדיקה 9" },
    sent9,
  );
  const due9 = DateTime.fromISO(fu9.dueAt, { zone: "utc" }).setZone("Asia/Jerusalem");
  check("9. reminder באותו יום, 3 שעות אחרי", due9.toFormat("yyyy-MM-dd HH:mm") === "2026-09-16 10:00", due9.toISO()!);

  // ---- 10. מאוחר ביום → reminder ביום העסקים הבא, 08:30+3h ----
  const sent10 = DateTime.fromISO("2026-09-16T15:22:00", { zone: "Asia/Jerusalem" }); // יום ד', מאוחר
  const fu10 = scheduleInitialNudgeFollowup(
    { itemId: `${MARK}-10`, itemSource: "general" as OpsTaskSource, findingKey: `${MARK}:t10`, userKey: "dov", taskName: "משימת בדיקה 10" },
    sent10,
  );
  const due10 = DateTime.fromISO(fu10.dueAt, { zone: "utc" }).setZone("Asia/Jerusalem");
  check("10. reminder ביום העסקים הבא ב-11:30", due10.toFormat("yyyy-MM-dd HH:mm") === "2026-09-17 11:30", due10.toISO()!);

  // ---- 11. יום ה' מאוחר → reminder ביום א' (מדלג שישי/שבת) ----
  const sent11 = DateTime.fromISO("2026-09-10T15:22:00", { zone: "Asia/Jerusalem" }); // יום ה' (מאומת: test-loop.ts)
  const fu11 = scheduleInitialNudgeFollowup(
    { itemId: `${MARK}-11`, itemSource: "general" as OpsTaskSource, findingKey: `${MARK}:t11`, userKey: "dov", taskName: "משימת בדיקה 11" },
    sent11,
  );
  const due11 = DateTime.fromISO(fu11.dueAt, { zone: "utc" }).setZone("Asia/Jerusalem");
  check("11. יום ה' מאוחר → reminder ביום א' ב-11:30 (מדלג שישי/שבת)", due11.toFormat("yyyy-MM-dd HH:mm") === "2026-09-13 11:30", due11.toISO()!);
  check("11. 2026-09-13 הוא באמת יום ראשון", due11.weekday === 7);

  // ==== runDueFollowups — תגובת עובד / task סגור ====

  const fakeDeps = (label: string | null): FollowupRunnerDeps => ({
    getTaskStatusLabel: async () => label,
  });

  // ---- 12a. תגובת עובד מבטלת את שלב ה-reminder לפני שנדלק ----
  const fk12a = `${MARK}:responded-before-reminder`;
  const itemId12a = `${MARK}-12a`;
  const nudgeSentAt12a = DateTime.now().minus({ hours: 4 }); // כבר 4 שעות — ה-reminder "צריך" להיות due
  const fu12a = scheduleInitialNudgeFollowup(
    { itemId: itemId12a, itemSource: "general" as OpsTaskSource, findingKey: fk12a, userKey: "dov", taskName: "משימה 12a" },
    nudgeSentAt12a,
  );
  // עובד עונה (בדיוק מה ש-reply_* tools עושים): מתעד תגובה + סוגר follow-ups פעילים על הפריט.
  recordFindingEvent(fk12a, "employee_responded", { byUser: "dov", note: "סיימתי" });
  const result12a = await runDueFollowups(DateTime.now(), fakeDeps(null));
  const processed12a = result12a.processed.find((p) => p.id === fu12a.id);
  check("12a. reminder לא נשלח — הושלם בשקט כי כבר ענו", processed12a?.outcome === "completed_already_responded", JSON.stringify(processed12a));
  const eod12a = followupRow(itemId12a, "initial_nudge_eod");
  check("12a. לא נוצר initial_nudge_eod בעקבות תגובה", !eod12a);

  // ---- 12b. תגובת עובד סוגרת גם initial_nudge_eod שכבר ממתין ----
  const fk12b = `${MARK}:responded-before-eod`;
  const itemId12b = `${MARK}-12b`;
  // מדמים EOD כבר מתוזמן (כאילו ה-reminder כבר נשלח קודם) — נוצר ישירות, לא דרך processInitialNudgeReminder.
  db.prepare(
    `INSERT INTO control_followups (finding_key, item_id, item_source, user_key, kind, due_at, payload_json)
     VALUES (?, ?, 'general', 'dov', 'initial_nudge_eod', ?, '{}')`,
  ).run(fk12b, itemId12b, DateTime.now().plus({ hours: 1 }).toUTC().toISO());
  recordFindingEvent(fk12b, "employee_responded", { byUser: "dov", note: "עוד קצת" });
  completeActiveFollowupsForItem(itemId12b, "general"); // בדיוק מה ש-loopReply.ts קורא אחרי תשובה
  const eod12b = followupRow(itemId12b, "initial_nudge_eod");
  check("12b. initial_nudge_eod ממתין הושלם ע\"י תגובת עובד", eod12b?.status === "completed", JSON.stringify(eod12b));

  // ---- 13. task שכבר נסגר ב-Monday לפני processing → followup נסגר בשקט ----
  const fk13 = `${MARK}:closed-in-monday`;
  const itemId13 = `${MARK}-13`;
  const fu13 = scheduleInitialNudgeFollowup(
    { itemId: itemId13, itemSource: "general" as OpsTaskSource, findingKey: fk13, userKey: "dov", taskName: "משימה 13" },
    DateTime.now().minus({ hours: 4 }),
  );
  const result13 = await runDueFollowups(DateTime.now(), fakeDeps("בוצע")); // DONE_LABEL.general === "בוצע"
  const processed13 = result13.processed.find((p) => p.id === fu13.id);
  check("13. task שנסגר ב-Monday → followup נסגר בשקט, בלי תזכורת", processed13?.outcome === "completed_done", JSON.stringify(processed13));
  const eod13 = followupRow(itemId13, "initial_nudge_eod");
  check("13. לא נוצר initial_nudge_eod עבור task שכבר בוצע", !eod13);

  cleanup();

  if (failed > 0) {
    logger.error(`\n${failed} בדיקות נכשלו`);
    process.exit(1);
  }
  logger.info("\n✅ כל הבדיקות עברו");
}

main().catch((err) => {
  cleanup();
  logger.error(err, "test-initial-overdue-nudge failed");
  process.exit(1);
});
