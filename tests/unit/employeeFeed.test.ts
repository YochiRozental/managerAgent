/**
 * בדיקת getEmployeeFeed/dueInfo/formatEmployeeFeedText/employeeFeedCounts (src/ops/employeeFeed.ts)
 * — לוגיקה מקומית, בלי Monday חי (כל חמשת ה-fetchOwned* מוזרקים דרך deps, ר' EmployeeFeedDeps).
 * הועבר אחד-לאחד מ-scripts/test-employee-feed.ts (הוסר). רץ ב-npm test.
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
  formatEmployeeFeedBriefing,
  greetingFor,
  employeeFeedCounts,
  type EmployeeFeedDeps,
  type EmployeeFeed,
} from "../../src/ops/employeeFeed.js";
import type { OwnedDeal, OwnedLead } from "../../src/integrations/monday/crmRead.js";
import type { OpsTask } from "../../src/integrations/monday/opsRead.js";
import { logger } from "../../src/utils/logger.js";
import { assert } from "../helpers/check.js";


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
  assert((text.match(/אין פריטים כרגע/g) ?? []).length === 5, "כל 5 הקטגוריות הריקות מציגות הודעה עדינה ('אין פריטים כרגע')");
  assert(/\*\*[^*]*\(0\)\*\*/.test(text), "כותרת קטגוריה ריקה מודגשת (**...**) וכוללת ספירה (0)");

  // סדר הכותרות קבוע: לידים לפני עסקאות חדשות לפני עסקאות לטיפול לפני משימות לפני משימות פרויקט
  const idx = CATEGORY_LABELS.map((l) => text.indexOf(l));
  const sorted = [...idx].sort((a, b) => a - b);
  assert(JSON.stringify(idx) === JSON.stringify(sorted), "חמש הכותרות מופיעות בדיוק באותו סדר שהוגדר");
}

// כותרת כוללת אייקון + ספירה אמיתית, ותומכת בעטיפת-הדגשה מותאמת לערוץ (ברירת מחדל vs. WhatsApp)
{
  const feed = await run({
    fetchOwnedNewLeads: async () => [mkLead({ itemId: "l1" }), mkLead({ itemId: "l2" })],
  });
  const webText = formatEmployeeFeedText(feed);
  assert(webText.includes("**🆕 לידים חדשים (2)**"), "ברירת מחדל (חלונית): כותרת מודגשת בכפולת-כוכבית עם אייקון וספירה נכונה (2)");
  const waText = formatEmployeeFeedText(feed, { bold: (s) => `*${s}*` });
  assert(waText.includes("*🆕 לידים חדשים (2)*") && !waText.includes("**"), "WhatsApp: עטיפת הדגשה בכוכבית בודדת, בלי כוכבית כפולה");
}

// ───────────────────────── קישורים לפריט המקורי ב-Monday ─────────────────────────
logger.info("— קישורים (Markdown בחלונית, URL גולמי ב-WhatsApp) —");

// חלונית (ברירת מחדל): שם הפריט עטוף כ-[שם](url) — לכל אחת מחמש הקטגוריות
{
  const feed = await run({
    fetchOwnedNewLeads: async () => [mkLead({ itemId: "l1", name: "ליד כהן", url: "https://x/leads/l1" })],
    fetchOwnedNewDeals: async () => [mkDeal({ itemId: "d1", name: "עסקת לוי", url: "https://x/deals/d1" })],
    fetchOwnedInProgressDeals: async () => [mkDeal({ itemId: "d2", name: "עסקה לטיפול", reminderDate: "2026-10-01", url: "https://x/deals/d2" })],
    fetchOwnedNewGeneralTasks: async () => [mkTask({ itemId: "t1", name: "לשלוח חוזה", dueDate: "2026-10-08", url: "https://x/tasks/t1" })],
    fetchProjectStageTasks: async () => [
      mkTask({ itemId: "s1", source: "project_stage", name: "תכנית חשמל", context: "פרויקט בלומינג", stageName: "שלב 3", dueDate: "2026-10-08", url: "https://x/subitems/s1" }),
    ],
  });
  const text = formatEmployeeFeedText(feed);
  assert(text.includes("[ליד כהן](https://x/leads/l1)"), "ליד חדש: שם עטוף כ-[שם](url)");
  assert(text.includes("[עסקת לוי](https://x/deals/d1)"), "עסקה חדשה: שם עטוף כ-[שם](url)");
  assert(text.includes("[עסקה לטיפול](https://x/deals/d2) — באיחור 7 ימים"), "עסקה לטיפול: קישור ואז מפריד תאריך, לא לפני");
  assert(text.includes("[לשלוח חוזה](https://x/tasks/t1) — להיום"), "משימה רגילה: קישור ואז תאריך");
  assert(text.includes("[תכנית חשמל (פרויקט בלומינג › שלב 3)](https://x/subitems/s1) — להיום"), "משימת פרויקט: הקישור עוטף את שם+הקשר (פרויקט›שלב), מצביע לתת-המשימה (s1), לא לשלב");
}

// בלי URL תקין (ריק) → טקסט רגיל, לא ממציאים קישור
{
  const feed = await run({
    fetchOwnedNewLeads: async () => [mkLead({ itemId: "l2", name: "ליד בלי קישור", url: "" })],
  });
  const text = formatEmployeeFeedText(feed);
  assert(text.includes("• ליד בלי קישור") && !text.includes("["), "URL ריק → שם כטקסט רגיל, בלי תחביר קישור בכלל");
}

// WhatsApp (plainLinks) — בלי Markdown; ה-URL הגולמי בשורה נפרדת מתחת לשם, כדי ש-WhatsApp יזהה אותו
{
  const feed = await run({
    fetchOwnedNewGeneralTasks: async () => [mkTask({ itemId: "t2", name: "לשלוח חוזה", dueDate: "2026-10-08", url: "https://x/tasks/t2" })],
  });
  const waText = formatEmployeeFeedText(feed, { plainLinks: true });
  assert(!waText.includes("["), "WhatsApp: אין תחביר Markdown-link בכלל");
  assert(waText.includes("• לשלוח חוזה — להיום\n  https://x/tasks/t2"), "WhatsApp: שם+תאריך בשורה אחת, ה-URL הגולמי בשורה נפרדת מתחתיו");
}

// אין כפילות קישור על אותו פריט, וכותרות הקטגוריה (bold) לא מקבלות קישור בכלל
{
  const feed = await run({
    fetchOwnedNewLeads: async () => [mkLead({ itemId: "l3", name: "ליד יחיד", url: "https://x/leads/l3" })],
  });
  const text = formatEmployeeFeedText(feed);
  const occurrences = (text.match(/https:\/\/x\/leads\/l3/g) ?? []).length;
  assert(occurrences === 1, "אין כפילות — ה-URL מופיע פעם אחת בלבד לכל פריט");
  const headerLines = text.split("\n").filter((l) => l.startsWith("**"));
  assert(headerLines.length === 5 && headerLines.every((l) => !l.includes("](")), "כותרות הקטגוריה (מודגשות) אינן עטופות בתחביר קישור");
}

// התאמה ל-regex הפענוח בצד הלקוח (src/server/ui.html's bubble()) — אותו ביטוי בדיוק, בלי Monday/דפדפן
{
  const linkRegex = /\[([^[\]]+)\]\((https:\/\/[^\s()<>]+)\)/g;
  const sample = "לפני • [לשלוח חוזה](https://gottlieb-league.monday.com/boards/1/pulses/2) — להיום אחרי";
  const matches = [...sample.matchAll(linkRegex)];
  assert(matches.length === 1 && matches[0]![1] === "לשלוח חוזה" && matches[0]![2] === "https://gottlieb-league.monday.com/boards/1/pulses/2", "regex הלקוח תופס שם+URL נכון מתוך שורת פריט אמיתית");
  assert(!linkRegex.test("[לא קישור](http://not-https)"), "regex הלקוח לא תופס http:// (רק https://) — מגן מפני downgrade/javascript: וכו'");
}

// formatEmployeeFeedBriefing — ברכה+כותרת ראשית מעל חמש הקטגוריות, תצוגה אחת בלבד
{
  const feed = await run({});
  const morning = DateTime.fromISO("2026-10-13T08:00:00", { zone: "Asia/Jerusalem" });
  const text = formatEmployeeFeedBriefing("דוב שפירא", feed, morning);
  assert(text.startsWith("בוקר טוב, דוב שפירא ☀️\nסדר העבודה שלך להיום"), "הכותרת הראשית: ברכה+שם ואז 'סדר העבודה שלך להיום'");
  for (const label of CATEGORY_LABELS) assert(text.includes(label), `הבריפינג המלא כולל גם את "${label}"`);
}

// greetingFor — ברכה לפי שעה, אותה לוגיקה גם לחלונית וגם ל-WhatsApp (לא כפולה בין שני המקומות)
{
  assert(greetingFor(DateTime.fromISO("2026-10-13T09:00:00")) === "בוקר טוב", "09:00 → בוקר טוב");
  assert(greetingFor(DateTime.fromISO("2026-10-13T14:00:00")) === "צהריים טובים", "14:00 → צהריים טובים");
  assert(greetingFor(DateTime.fromISO("2026-10-13T20:00:00")) === "ערב טוב", "20:00 → ערב טוב");
}

// רגרסיה ממוקדת: תאריך עתיק (430 יום) מסומן "באיחור", לעולם לא "להיום" — לא מסמנים ישן כ"היום" (CLAUDE.md edge case)
{
  const veryOldDue = TODAY.minus({ days: 430 }).toISODate()!;
  const feed = await run({
    fetchOwnedNewGeneralTasks: async () => [mkTask({ itemId: "ancient", name: "משימה עתיקה", dueDate: veryOldDue })],
  });
  const t = items<OpsTask & { overdue: boolean; dueToday: boolean; daysOverdue: number }>(feed.tasks)[0]!;
  assert(t.overdue === true && t.daysOverdue === 430, "תאריך לפני 430 יום → overdue=true, daysOverdue=430");
  assert(t.dueToday === false, "תאריך עתיק לעולם לא dueToday=true");
  const text = formatEmployeeFeedText(feed);
  assert(text.includes("באיחור 430 ימים") && !text.includes("משימה עתיקה — להיום"), "בתצוגה: מסומן 'באיחור 430 ימים', לא 'להיום'");
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
