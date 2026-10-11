/**
 * בדיקת getEmployeeFeed/dueInfo/formatEmployeeFeedText/employeeFeedCounts (src/ops/employeeFeed.ts)
 * — לוגיקה מקומית, בלי Monday חי (כל חמשת ה-fetchOwned* מוזרקים דרך deps, ר' EmployeeFeedDeps).
 * מריץ: npm run test:employee-feed
 *
 * מה שנבדק (מול סעיפים 2-6 בדרישת מוטי, 2026-10-08 + 2026-10-11):
 *  - לידים חדשים ועסקאות חדשות מוצגים ללא קשר לתאריך (גם תאריך עתידי/ריק/עתיק).
 *  - עסקאות לטיפול / משימות / משימות פרויקט: רק תאריך היום-או-עבר נכנס; עתידי/ריק לא.
 *  - overdue/dueToday/daysOverdue מחושבים נכון מול "היום" המוזרק (לא תלוי בשעון המערכת).
 *  - הקשר פרויקט/שלב נשמר על משימות פרויקט; משימת משרד לא מקבלת project.
 *  - חמש הקטגוריות נשארות מופרדות (לא מתמזגות לרשימה אחת).
 *  - הפילטרים לא עושים סינון אחראי משל עצמם — זה כבר קרה בשרת (fetchOwned*) לפני שהגיעו לכאן.
 *  - כשל בשליפת קטגוריה אחת לא מפיל את האחרות, ולא "נעלם" כריק — מגיע כ-FeedResult.ok=false.
 *  - formatEmployeeFeedText: כל חמש הכותרות הקבועות מופיעות תמיד ובאותו סדר, גם ריקות/שגויות;
 *    קטגוריה ריקה → "אין פריטים לטיפול"; קטגוריה שנכשלה → שורת שגיאה מפורשת, לא מומצאת/מוסתרת.
 */
import { DateTime } from "luxon";
import {
  dueInfo,
  getEmployeeFeed,
  formatEmployeeFeedText,
  employeeFeedCounts,
  type EmployeeFeedDeps,
  type EmployeeFeed,
} from "../src/ops/employeeFeed.js";
import type { OwnedDeal, OwnedLead } from "../src/integrations/monday/crmRead.js";
import type { OpsTask } from "../src/integrations/monday/opsRead.js";
import { logger } from "../src/utils/logger.js";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) logger.info(`✅ ${msg}`);
  else {
    failures++;
    logger.error(`❌ ${msg}`);
  }
}

const TODAY = DateTime.fromISO("2026-10-08", { zone: "Asia/Jerusalem" }).startOf("day");

function mkLead(o: Partial<OwnedLead> & { itemId: string }): OwnedLead {
  return { name: `lead-${o.itemId}`, status: "ליד חדש", product: "", url: `https://x/${o.itemId}`, ...o };
}
function mkDeal(o: Partial<OwnedDeal> & { itemId: string }): OwnedDeal {
  return { name: `deal-${o.itemId}`, stage: "נוצר קשר ראשוני", url: `https://x/${o.itemId}`, ...o };
}
function mkTask(o: Partial<OpsTask> & { itemId: string }): OpsTask {
  return {
    source: "general",
    name: `task-${o.itemId}`,
    url: `https://x/${o.itemId}`,
    context: "משימת משרד",
    status: "לביצוע",
    assignees: "דוב שפירא",
    ...o,
  };
}

const CATEGORY_LABELS = ["לידים חדשים", "עסקאות חדשות", "עסקאות לטיפול", "משימות רגילות", "משימות פרויקטים"];

// ───────────────────────── dueInfo ─────────────────────────
logger.info("— dueInfo —");
{
  assert(JSON.stringify(dueInfo(undefined, TODAY)) === JSON.stringify({ overdue: false, dueToday: false, daysOverdue: 0 }), "אין תאריך → הכל false/0");
  const today = dueInfo("2026-10-08", TODAY);
  assert(today.dueToday && !today.overdue && today.daysOverdue === 0, "תאריך = היום → dueToday, לא overdue");
  const past = dueInfo("2026-10-01", TODAY);
  assert(past.overdue && !past.dueToday && past.daysOverdue === 7, "לפני 7 ימים → overdue, daysOverdue=7");
  const future = dueInfo("2026-10-09", TODAY);
  assert(!future.overdue && !future.dueToday && future.daysOverdue === 0, "תאריך עתידי → לא overdue ולא dueToday");
}

// ───────────────────────── getEmployeeFeed ─────────────────────────
logger.info("— getEmployeeFeed —");

async function run(deps: EmployeeFeedDeps) {
  return getEmployeeFeed("999", TODAY, {
    fetchOwnedNewLeads: async () => [],
    fetchOwnedNewDeals: async () => [],
    fetchOwnedInProgressDeals: async () => [],
    fetchOwnedNewGeneralTasks: async () => [],
    fetchProjectStageTasks: async () => [],
    ...deps,
  });
}

function items<T>(r: EmployeeFeed[keyof EmployeeFeed]): T[] {
  return (r as { ok: true; items: T[] }).ok ? (r as { ok: true; items: T[] }).items : [];
}

// לידים חדשים — בלי סינון תאריך, כולל תאריך עתיק/עתידי/ריק
{
  const feed = await run({
    fetchOwnedNewLeads: async () => [
      mkLead({ itemId: "l1", reminderDate: "2020-01-01" }), // עתיק
      mkLead({ itemId: "l2", reminderDate: "2099-01-01" }), // עתידי
      mkLead({ itemId: "l3" }), // בלי תאריך
    ],
  });
  assert(feed.newLeads.ok && feed.newLeads.items.length === 3, "כל 3 הלידים מוצגים — לידים חדשים לא מסוננים לפי תאריך");
}

// עסקאות חדשות — בלי סינון תאריך
{
  const feed = await run({
    fetchOwnedNewDeals: async () => [mkDeal({ itemId: "d1", reminderDate: "2099-01-01" }), mkDeal({ itemId: "d2" })],
  });
  assert(feed.newDeals.ok && feed.newDeals.items.length === 2, "שתי עסקאות חדשות מוצגות גם עם תאריך עתידי/ריק");
}

// עסקאות לטיפול — רק היום-או-עבר; עתידי/ריק לא
{
  const feed = await run({
    fetchOwnedInProgressDeals: async () => [
      mkDeal({ itemId: "p1", reminderDate: "2026-10-01" }), // עבר
      mkDeal({ itemId: "p2", reminderDate: "2026-10-08" }), // היום
      mkDeal({ itemId: "p3", reminderDate: "2026-10-09" }), // עתידי — לא נכנס
      mkDeal({ itemId: "p4" }), // בלי תאריך — לא נכנס
    ],
  });
  const ds = items<OwnedDeal & { overdue: boolean; dueToday: boolean; daysOverdue: number }>(feed.dealsNeedingAttention);
  const ids = ds.map((d) => d.itemId).sort();
  assert(JSON.stringify(ids) === JSON.stringify(["p1", "p2"]), `עסקאות לטיפול: רק p1,p2 (קיבלנו ${ids.join(",")})`);
  const p1 = ds.find((d) => d.itemId === "p1")!;
  const p2 = ds.find((d) => d.itemId === "p2")!;
  assert(p1.overdue && p1.daysOverdue === 7, "p1 (לפני 7 ימים) → overdue=true, daysOverdue=7");
  assert(p2.dueToday && !p2.overdue, "p2 (היום) → dueToday=true, לא overdue");
}

// משימות רגילות — אותו כלל תאריך, פלוס שמירת status/url
{
  const feed = await run({
    fetchOwnedNewGeneralTasks: async () => [
      mkTask({ itemId: "t1", dueDate: "2026-10-05", status: "לביצוע" }),
      mkTask({ itemId: "t2", dueDate: "2026-10-20" }), // עתידי — לא נכנס
      mkTask({ itemId: "t3" }), // בלי תאריך — לא נכנס
    ],
  });
  const ts = items<OpsTask & { overdue: boolean; daysOverdue: number; project?: string }>(feed.tasks);
  assert(ts.length === 1 && ts[0]!.itemId === "t1", "משימות רגילות: רק t1 (היום-או-עבר)");
  assert(ts[0]!.overdue && ts[0]!.daysOverdue === 3, "t1: overdue=true, daysOverdue=3");
  assert(ts[0]!.project === undefined, "משימת משרד (context='משימת משרד') — בלי project");
}

// משימות פרויקטים — אותו כלל תאריך, פלוס project/stage context
{
  const feed = await run({
    fetchProjectStageTasks: async () => [
      mkTask({
        itemId: "s1",
        source: "project_stage",
        context: "פרויקט אלפא",
        projectId: "500",
        stageName: "שלב 2",
        dueDate: "2026-10-08",
      }),
      mkTask({ itemId: "s2", source: "project_stage", context: "פרויקט בטא", dueDate: "2026-11-01" }), // עתידי
    ],
  });
  const ps = items<OpsTask & { project?: string; projectId?: string; stage?: string; dueToday: boolean }>(feed.projectTasks);
  assert(ps.length === 1 && ps[0]!.itemId === "s1", "משימות פרויקט: רק s1 (עתידי מסונן)");
  assert(ps[0]!.project === "פרויקט אלפא" && ps[0]!.projectId === "500" && ps[0]!.stage === "שלב 2", "s1: project+projectId+stage נשמרים");
  assert(ps[0]!.dueToday === true, "s1 (היום) → dueToday=true");
}

// הקטגוריות נשארות מופרדות — לא מתמזגות, גם כשיש itemId חופף בין מקורות שונים
{
  const feed = await run({
    fetchOwnedNewGeneralTasks: async () => [mkTask({ itemId: "shared", dueDate: "2026-10-08" })],
    fetchProjectStageTasks: async () => [mkTask({ itemId: "shared", source: "project_stage", context: "פ", dueDate: "2026-10-08" })],
  });
  assert(items(feed.tasks).length === 1 && items(feed.projectTasks).length === 1, "אותו itemId בשני מקורות שונים — כל קטגוריה נשארת נפרדת, לא נמחקת/מתמזגת");
}

// אין סינון אחראי עצמאי כאן — מה ש-deps מחזירים עובר כמו שהוא (הסינון כבר קרה בשרת)
{
  const feed = await run({
    fetchOwnedNewLeads: async () => [mkLead({ itemId: "any-owner" })],
  });
  assert(items(feed.newLeads).length === 1, "getEmployeeFeed לא מסנן אחראי בעצמו — סומך על fetchOwned* (סינון שרת)");
}

// ───────────────────────── עמידות לכשל ─────────────────────────
logger.info("— עמידות לכשל (כשל בקטגוריה אחת לא מפיל את האחרות) —");
{
  const feed = await run({
    fetchOwnedNewLeads: async () => {
      throw new Error("Monday timeout (simulated)");
    },
    fetchOwnedNewGeneralTasks: async () => [mkTask({ itemId: "ok1", dueDate: "2026-10-08" })],
  });
  assert(feed.newLeads.ok === false, "fetchOwnedNewLeads זרק → newLeads.ok=false (לא 'ריק' מזויף)");
  assert(!feed.newLeads.ok && feed.newLeads.error.includes("Monday timeout"), "newLeads.error מכיל את הודעת השגיאה המקורית");
  assert(feed.tasks.ok === true && items(feed.tasks).length === 1, "קטגוריה אחרת (tasks) ממשיכה לעבוד תקין למרות כשל בלידים");
}
{
  // כשל בקטגוריה תלויית-תאריך (dealsNeedingAttention) — mapResult לא דורס שגיאה בסינון
  const feed = await run({
    fetchOwnedInProgressDeals: async () => {
      throw new Error("בדיקה: כשל בעסקאות לטיפול");
    },
  });
  assert(feed.dealsNeedingAttention.ok === false, "כשל ב-fetchOwnedInProgressDeals → dealsNeedingAttention.ok=false אחרי סינון התאריך");
}

// ───────────────────────── formatEmployeeFeedText ─────────────────────────
logger.info("— formatEmployeeFeedText —");
{
  const empty = await run({});
  const text = formatEmployeeFeedText(empty);
  for (const label of CATEGORY_LABELS) assert(text.includes(label), `כל הקטגוריות ריקות: כותרת "${label}" מופיעה בכל זאת`);
  assert((text.match(/אין פריטים לטיפול/g) ?? []).length === 5, "כל 5 הקטגוריות הריקות מציגות 'אין פריטים לטיפול'");

  // סדר הכותרות קבוע: לידים לפני עסקאות חדשות לפני עסקאות לטיפול לפני משימות לפני משימות פרויקט
  const idx = CATEGORY_LABELS.map((l) => text.indexOf(l));
  const sorted = [...idx].sort((a, b) => a - b);
  assert(JSON.stringify(idx) === JSON.stringify(sorted), "חמש הכותרות מופיעות בדיוק באותו סדר שהוגדר");
}
{
  const feed = await run({
    fetchOwnedNewLeads: async () => {
      throw new Error("שליפת לידים נכשלה — בדיקה");
    },
    fetchOwnedNewGeneralTasks: async () => [mkTask({ itemId: "t1", name: "סיור באתר", dueDate: "2026-10-01" })],
  });
  const text = formatEmployeeFeedText(feed);
  assert(text.includes("⚠️") && text.includes("שליפת לידים נכשלה"), "קטגוריה שנכשלה מוצגת כשגיאה מפורשת (⚠️), לא כריקה ולא מומצאת");
  assert(text.includes("סיור באתר") && text.includes("באיחור 7 ימים"), "קטגוריית משימות תקינה מוצגת כרגיל, עם סימון איחור");
  assert(CATEGORY_LABELS.every((l) => text.includes(l)), "כל 5 הכותרות מופיעות גם כשקטגוריה אחת נכשלה");
}

// ───────────────────────── employeeFeedCounts ─────────────────────────
logger.info("— employeeFeedCounts —");
{
  const feed = await run({
    fetchOwnedNewLeads: async () => {
      throw new Error("x");
    },
    fetchOwnedNewDeals: async () => [mkDeal({ itemId: "d1" })],
  });
  const counts = employeeFeedCounts(feed);
  assert(counts.newLeads === 0, "קטגוריה שנכשלה → ספירה 0 (לא שלילי/undefined)");
  assert(counts.newDeals === 1, "קטגוריה תקינה → ספירה אמיתית");
  assert(counts.errors.includes("לידים חדשים"), "errors מציין את שם הקטגוריה שנכשלה");
  assert(counts.errors.length === 1, "רק קטגוריה אחת ברשימת ה-errors");
}

logger.info("");
if (failures > 0) {
  logger.error(`${failures} בדיקות נכשלו ❌`);
  process.exit(1);
}
logger.info("כל בדיקות ה-employee-feed עברו ✅");
