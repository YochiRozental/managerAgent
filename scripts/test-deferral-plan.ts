/**
 * בדיקות לשני הפערים מה-Audit (2026-09-14):
 *   1. היסטוריית דחיות לפי itemId+itemSource, לא לפי finding_key (deferralHistory.ts).
 *   2. planDeferralReply — 3 המצבים (executed / needs_clarification / manager_approval_required),
 *      ושה-Monday/finding_events לעולם לא נכתבים משם.
 *
 * נוגעת ב-DB האמיתי (control_findings + finding_events, כמו test-loop.ts) — לא ב-Monday.
 *
 *   npm run test:deferral-plan
 */

import "dotenv/config";
import fs from "node:fs";
import { DateTime } from "luxon";
import { db } from "../src/db/db.js";
import { upsertFinding } from "../src/db/repositories/controlFindings.js";
import { recordFindingEvent, findingEvents } from "../src/db/repositories/findingEvents.js";
import { loadDeferralHistoryForItem } from "../src/db/repositories/deferralHistory.js";
import { resolveUserByKey } from "../src/identity/index.js";
import { planDeferralReply } from "../src/ops/deferralPlan.js";
import type { LoopContext } from "../src/ops/loopReply.js";
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
const dov = resolveUserByKey("dov")!;

// מזהי בדיקה ייחודיים כדי לא להתנגש עם דאטה אמיתי, וקלים לניקוי בסוף.
const T1 = "__test_item_1__";
const T2 = "__test_item_2__";
const SRC = "general";

function cleanup(): void {
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '%${T1}%' OR finding_key LIKE '%${T2}%'`);
  db.exec(`DELETE FROM control_findings WHERE item_id IN ('${T1}', '${T2}')`);
}

cleanup(); // אם ריצה קודמת נכשלה באמצע

// ─────────────────────────────────────────────────────────────────────────────
// פער 1 — היסטוריית דחיות לפי itemId, לא לפי finding_key
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── היסטוריית דחיות לפי itemId ──");

// 1. T1 מתגלה כ-"overdue:T1" ומקבל דחייה.
upsertFinding({
  findingKey: `overdue:${T1}`,
  kind: "overdue_stale",
  severity: "high",
  who: "דוב שפירא",
  headline: "באיחור 5 ימים: בדיקת פוליסי",
  detail: "בדיקה",
  itemId: T1,
  itemSource: SRC,
  now: nowIso,
});
recordFindingEvent(`overdue:${T1}`, "snoozed", { byUser: "dov", snoozeUntil: "2026-09-16" });

// 2. אותה משימה (itemId זהה!) מתגלה מאוחר יותר כ-"stuck:T1" — finding_key שונה לגמרי.
upsertFinding({
  findingKey: `stuck:${T1}`,
  kind: "stuck",
  severity: "critical",
  who: "דוב שפירא",
  headline: "תקוע: בדיקת פוליסי",
  detail: "בדיקה",
  itemId: T1,
  itemSource: SRC,
  now: nowIso,
});

// משימה נפרדת (T2) — בלי שום דחייה.
upsertFinding({
  findingKey: `overdue:${T2}`,
  kind: "overdue_stale",
  severity: "high",
  who: "איתן ברמן",
  headline: "באיחור 2 ימים: משהו אחר",
  detail: "בדיקה",
  itemId: T2,
  itemSource: SRC,
  now: nowIso,
});

{
  // 3. הזיהוי חייב להיות לפי itemId — ההיסטוריה של T1 חייבת להימצא, גם דרך finding_key אחר.
  const histT1 = loadDeferralHistoryForItem(T1, SRC);
  check(
    "היסטוריה נשמרת לפי itemId גם כשה-finding_key השתנה (overdue→stuck)",
    histT1.length === 1 && histT1[0]!.newDueDate === "2026-09-16",
    JSON.stringify(histT1),
  );
}

{
  // 4. T2 לא מקבל בטעות את ההיסטוריה של T1.
  const histT2 = loadDeferralHistoryForItem(T2, SRC);
  check("היסטוריה לא עוברת בין itemId שונים (T2 לא רואה את הדחייה של T1)", histT2.length === 0, JSON.stringify(histT2));
}

// ─────────────────────────────────────────────────────────────────────────────
// פער 2+3 — planDeferralReply: 3 המצבים, ו-reasonJudgedPlausible
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── planDeferralReply: 3 המצבים ──");

// T1 כבר יש לו דחייה קודמת אחת (מהחלק הקודם) — אז לפי כלל 3, כל דחייה נוספת = אישור מוטי מיידי,
// לא משנה הימים/הסיבה. בשביל לבדוק את הענפים "הרגילים" (3/needs_clarification/7/10 ימים) בלי
// שהתחייבות-חדשה-שכבר-נוצלה תשתלט על התוצאה, בודקים על משימה נקייה בלי היסטוריה בכלל.
const CLEAN = "__test_item_clean__";
function cleanupClean(): void {
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '%${CLEAN}%'`);
  db.exec(`DELETE FROM control_findings WHERE item_id = '${CLEAN}'`);
}
cleanupClean();
upsertFinding({
  findingKey: `overdue:${CLEAN}`,
  kind: "overdue_stale",
  severity: "high",
  who: "דוב שפירא",
  headline: "באיחור 3 ימים: בדיקה נקייה",
  detail: "בדיקה",
  itemId: CLEAN,
  itemSource: SRC,
  now: nowIso,
});

const cleanCtx: LoopContext = {
  itemId: CLEAN,
  source: "general",
  findingKey: `overdue:${CLEAN}`,
  taskName: "בדיקה נקייה",
};

function countFindingEvents(findingKey: string): number {
  return findingEvents(findingKey).length;
}

{
  // 5 ימים, בלי שום הסבר שאפשר לשפוט לפיו → needs_clarification
  const before = countFindingEvents(cleanCtx.findingKey);
  const plan = planDeferralReply(dov, cleanCtx, {
    now,
    currentDueDateISO: now.minus({ days: 2 }).toISODate()!,
    requestedDueDateISO: now.plus({ days: 5 }).toISODate()!,
    reasonJudgedPlausible: null,
  });
  check("5 ימים בלי reason → needs_clarification", plan.status === "needs_clarification" && !!plan.question, plan.status);
  check("needs_clarification לא כתב שום finding_event", countFindingEvents(cleanCtx.findingKey) === before);
}

{
  // 5 ימים, reasonJudgedPlausible=true → executed (המדיניות מאשרת)
  const before = countFindingEvents(cleanCtx.findingKey);
  const plan = planDeferralReply(dov, cleanCtx, {
    now,
    currentDueDateISO: now.minus({ days: 2 }).toISODate()!,
    requestedDueDateISO: now.plus({ days: 5 }).toISODate()!,
    reasonText: "קיבלנו היום שינוי מהלקוח שדורש תכנון מחדש",
    reasonJudgedPlausible: true,
  });
  check("5 ימים עם reasonJudgedPlausible=true → executed", plan.status === "executed", plan.status);
  check("גם executed לא כתב שום finding_event (זה תכנון, לא ביצוע)", countFindingEvents(cleanCtx.findingKey) === before);
}

{
  // 5 ימים, reasonJudgedPlausible=false → לא מבוצע, לא רק "לברר" — ישר למוטי (סיבה כבר ניתנה ונפסלה)
  const before = countFindingEvents(cleanCtx.findingKey);
  const plan = planDeferralReply(dov, cleanCtx, {
    now,
    currentDueDateISO: now.minus({ days: 2 }).toISODate()!,
    requestedDueDateISO: now.plus({ days: 5 }).toISODate()!,
    reasonText: "ככה",
    reasonJudgedPlausible: false,
  });
  check(
    "5 ימים עם reasonJudgedPlausible=false → manager_approval_required",
    plan.status === "manager_approval_required",
    plan.status,
  );
  check("manager_approval_required לא כתב שום finding_event", countFindingEvents(cleanCtx.findingKey) === before);
}

{
  // 10 ימים, גם עם סיבה הגיונית → תקרה מוחלטת, אישור מוטי בכל מקרה
  const before = countFindingEvents(cleanCtx.findingKey);
  const plan = planDeferralReply(dov, cleanCtx, {
    now,
    currentDueDateISO: now.minus({ days: 2 }).toISODate()!,
    requestedDueDateISO: now.plus({ days: 10 }).toISODate()!,
    reasonText: "הפרויקט כולו נדחה בהחלטת הלקוח",
    reasonJudgedPlausible: true,
  });
  check(
    "10 ימים, גם עם סיבה הגיונית → manager_approval_required",
    plan.status === "manager_approval_required" && !!plan.approvalPayload,
    plan.status,
  );
  check("גם כאן — לא נכתב שום finding_event", countFindingEvents(cleanCtx.findingKey) === before);
}

{
  // ודוא שלא נעשה snooze בפועל בשום אחד מהתרחישים למעלה: 0 אירועי "snoozed" נכתבו על הפריט הנקי,
  // על אף שנקראו 4 בקשות דחייה שונות דרכו (חלקן "executed" ברמת המדיניות).
  const snoozed = findingEvents(cleanCtx.findingKey).filter((e) => e.event === "snoozed");
  check("אף אחד מתרחישי planDeferralReply לא ביצע snooze בפועל", snoozed.length === 0, String(snoozed.length));
}

// ─────────────────────────────────────────────────────────────────────────────
// הוכחה מבנית: deferralPlan.ts לא מייבא שום דבר שיכול לגעת ב-Monday/DB-כתיבה
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── בדיקה מבנית: אין דרך לגעת ב-Monday מ-deferralPlan.ts ──");

{
  // בודקים רק שורות import בפועל (לא טקסט תיעוד חופשי בקובץ — שמזכיר את השמות האלה בכוונה
  // כדי להסביר למה הם *לא* בשימוש).
  const src = fs.readFileSync(new URL("../src/ops/deferralPlan.ts", import.meta.url), "utf-8");
  const importLines = src
    .split("\n")
    .filter((l) => /^\s*import\b/.test(l))
    .join("\n");
  check("deferralPlan.ts לא מייבא מ-opsWrite.js (setTaskDueDate וכו')", !/opsWrite\.js/.test(importLines));
  check("deferralPlan.ts לא מייבא מ-actions.js (updateTask)", !/actions\.js/.test(importLines));
  check("deferralPlan.ts לא מייבא מ-findingEvents.js (אין recordFindingEvent — אין snooze/תיעוד)", !/findingEvents\.js/.test(importLines));
  check("deferralPlan.ts לא מייבא מ-notifications.js (אין addNotification — עדיין אין חיווט למוטי)", !/notifications\.js/.test(importLines));
}

cleanup();
cleanupClean();

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות ה-Deferral Plan עברו ✅");
