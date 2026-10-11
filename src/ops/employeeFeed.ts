/**
 * "העבודה שלי" עבור עובד — לידים/עסקאות/משימות/משימות פרויקט, לפי דרישת מוטי (2026-10-08,
 * הורחב 2026-10-11): כל עובד רואה רק את מה שהוא אחראי עליו ב-Monday, מסונן בצד השרת (לא רק
 * בתצוגה). זה מקור האמת האחיד לחמש הקטגוריות — נצרך גם מ-ops/chat.ts (get_today_tasks/
 * get_my_pipeline, חלונית) וגם מ-ops/myWorkBrief.ts (list_my_work, WhatsApp).
 *
 *  1. לידים חדשים (קבוצת "לידים חדשים" בלבד) — בלי סינון תאריך.
 *  2. עסקאות חדשות (קבוצת "עסקאות חדשות" בלבד) — בלי סינון תאריך.
 *  3. עסקאות לטיפול (קבוצת "עסקאות בעבודה") — רק "תאריך לתזכורת" שהוא היום או עבר; בלי תאריך/עתידי לא נכנס.
 *  4. משימות רגילות (קבוצת "משימות חדשות" בלוח "משימות 📝") — רק "תאריך לביצוע" היום או עבר.
 *  5. משימות פרויקטים (תת-פריטי "מאגר משימות פרויקטים") — רק "תאריכי משימה" היום או עבר.
 *
 * שכבת ה-IO (fetchOwned* ב-crmRead.ts/opsRead.ts) כבר מסננת group+אחראי בצד השרת. הקובץ הזה
 * מצרף את חמשת המקורות, מסנן תאריך (פונקציה טהורה, נבדקת עם "היום" מוזרק, בלי Monday), ומעצב
 * טקסט אחיד. אין כפילויות אפשריות בין הקטגוריות: כל אחת מגיעה מבורד/group נפרדים ומזהי Monday
 * גלובליים.
 *
 * עמידות לכשל: כל קטגוריה נשלפת בנפרד (FeedResult) — כשל באחת לא מפיל את האחרות ולא "נעלם"
 * כרשימה ריקה; הוא מגיע ל-formatEmployeeFeedText כשורת שגיאה מפורשת (לא מומצא, לא מוסתר).
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import {
  fetchOwnedNewLeads,
  fetchOwnedNewDeals,
  fetchOwnedInProgressDeals,
  type OwnedLead,
  type OwnedDeal,
} from "../integrations/monday/crmRead.js";
import { fetchOwnedNewGeneralTasks, fetchProjectStageTasks, type OpsTask } from "../integrations/monday/opsRead.js";

export interface DueInfo {
  overdue: boolean;
  dueToday: boolean;
  daysOverdue: number;
}

export interface EmployeeFeedDeal extends OwnedDeal, DueInfo {}

export interface EmployeeFeedTask {
  itemId: string;
  name: string;
  status: string;
  dueDate?: string;
  url: string;
  /** שם הפרויקט (רק למשימת פרויקט מקושרת) */
  project?: string;
  projectId?: string;
  /** שם השלב (רק למשימת פרויקט) */
  stage?: string;
  overdue: boolean;
  dueToday: boolean;
  daysOverdue: number;
}

/** תוצאת שליפה של קטגוריה בודדת — הצלחה עם הפריטים, או כשל עם הודעת שגיאה (לא "ריק" מזויף). */
export type FeedResult<T> = { ok: true; items: T[] } | { ok: false; error: string };

export interface EmployeeFeed {
  newLeads: FeedResult<OwnedLead>;
  newDeals: FeedResult<OwnedDeal>;
  dealsNeedingAttention: FeedResult<EmployeeFeedDeal>;
  tasks: FeedResult<EmployeeFeedTask>;
  projectTasks: FeedResult<EmployeeFeedTask>;
}

/** דגלי איחור/היום לתאריך בודד, לפי "היום" (startOf day) — אין תאריך = שלושתם false/0. */
export function dueInfo(dueDate: string | undefined, today: DateTime): DueInfo {
  if (!dueDate) return { overdue: false, dueToday: false, daysOverdue: 0 };
  const due = DateTime.fromISO(dueDate, { zone: today.zone }).startOf("day");
  if (+due > +today) return { overdue: false, dueToday: false, daysOverdue: 0 };
  const daysOverdue = Math.floor(today.diff(due, "days").days);
  return { overdue: daysOverdue > 0, dueToday: daysOverdue === 0, daysOverdue };
}

/** true רק אם יש תאריך והוא היום או עבר — לא עתידי, לא ריק (הכלל החזרתי בכל ארבעת הסעיפים התלויי-תאריך). */
function isDueTodayOrPast(dueDate: string | undefined, today: DateTime): boolean {
  if (!dueDate) return false;
  return +DateTime.fromISO(dueDate, { zone: today.zone }).startOf("day") <= +today;
}

const OFFICE_CONTEXTS = new Set(["", "משימת משרד", "פרויקט לא מקושר"]);

function toFeedTask(t: OpsTask, today: DateTime): EmployeeFeedTask {
  const isOffice = OFFICE_CONTEXTS.has(t.context);
  return {
    itemId: t.itemId,
    name: t.name,
    status: t.status || "לא הוגדר",
    dueDate: t.dueDate,
    url: t.url,
    ...(isOffice ? {} : { project: t.context, ...(t.projectId ? { projectId: t.projectId } : {}) }),
    ...(t.stageName ? { stage: t.stageName } : {}),
    ...dueInfo(t.dueDate, today),
  };
}

/** עוטף שליפה בודדת: הצלחה → {ok:true,items}, כשל → {ok:false,error} (לא נזרק, לא מפיל שליפות אחרות). */
async function fetchCategory<T>(fn: () => Promise<T[]>): Promise<FeedResult<T>> {
  try {
    return { ok: true, items: await fn() };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "שליפה מ-Monday נכשלה" };
  }
}

/** ממפה/מסנן FeedResult בלי לשנות מצב שגיאה — שגיאה נשארת שגיאה, לא הופכת ל"הכל נופל". */
function mapResult<A, B>(r: FeedResult<A>, fn: (items: A[]) => B[]): FeedResult<B> {
  return r.ok ? { ok: true, items: fn(r.items) } : r;
}

export interface EmployeeFeedDeps {
  fetchOwnedNewLeads?: typeof fetchOwnedNewLeads;
  fetchOwnedNewDeals?: typeof fetchOwnedNewDeals;
  fetchOwnedInProgressDeals?: typeof fetchOwnedInProgressDeals;
  fetchOwnedNewGeneralTasks?: typeof fetchOwnedNewGeneralTasks;
  fetchProjectStageTasks?: typeof fetchProjectStageTasks;
}

/**
 * מאחד את חמשת המקורות לעובד נתון. `now` ניתן להזרקה לבדיקות; `deps` מאפשר להזריק פונקציות
 * fetch מדומות (כולל כאלה שזורקות, לבדיקת עמידות לכשל) בלי Monday חי — ר' scripts/test-employee-feed.ts.
 */
export async function getEmployeeFeed(
  mondayUserId: string,
  now: DateTime = DateTime.now().setZone(env.TIMEZONE),
  deps: EmployeeFeedDeps = {},
): Promise<EmployeeFeed> {
  const today = now.startOf("day");
  const getNewLeads = deps.fetchOwnedNewLeads ?? fetchOwnedNewLeads;
  const getNewDeals = deps.fetchOwnedNewDeals ?? fetchOwnedNewDeals;
  const getInProgressDeals = deps.fetchOwnedInProgressDeals ?? fetchOwnedInProgressDeals;
  const getNewGeneralTasks = deps.fetchOwnedNewGeneralTasks ?? fetchOwnedNewGeneralTasks;
  const getProjectStageTasks = deps.fetchProjectStageTasks ?? fetchProjectStageTasks;

  const [newLeads, newDeals, inProgressDealsR, generalTasksR, projectTasksR] = await Promise.all([
    fetchCategory(() => getNewLeads(mondayUserId)),
    fetchCategory(() => getNewDeals(mondayUserId)),
    fetchCategory(() => getInProgressDeals(mondayUserId)),
    fetchCategory(() => getNewGeneralTasks(mondayUserId)),
    fetchCategory(() => getProjectStageTasks(mondayUserId)),
  ]);

  const dealsNeedingAttention = mapResult(inProgressDealsR, (items) =>
    items.filter((d) => isDueTodayOrPast(d.reminderDate, today)).map((d) => ({ ...d, ...dueInfo(d.reminderDate, today) })),
  );
  const tasks = mapResult(generalTasksR, (items) => items.filter((t) => isDueTodayOrPast(t.dueDate, today)).map((t) => toFeedTask(t, today)));
  const projectTasks = mapResult(projectTasksR, (items) =>
    items.filter((t) => isDueTodayOrPast(t.dueDate, today)).map((t) => toFeedTask(t, today)),
  );

  return { newLeads, newDeals, dealsNeedingAttention, tasks, projectTasks };
}

/** "באיחור N ימים" / "להיום" / התאריך הגולמי / "" — אין תלות סטטוס, רק DueInfo. */
function fmtDue(d: DueInfo, dueDate?: string): string {
  if (d.overdue) return `באיחור ${d.daysOverdue} ימים`;
  if (d.dueToday) return "להיום";
  return dueDate ?? "";
}

export interface FormatFeedOpts {
  /** עטיפת הדגשה לכותרת קטגוריה — **x** בחלונית (ברירת מחדל), *x* בוואטסאפ (ר' myWorkBrief.ts). */
  bold?: (s: string) => string;
}

const defaultBold = (s: string): string => `**${s}**`;

/** דוחף כותרת מודגשת+ספירה + שורות הפריטים (או "אין פריטים כרגע" / שורת שגיאה) — תמיד מופיעה. */
function pushSection<T>(
  lines: string[],
  icon: string,
  label: string,
  result: FeedResult<T>,
  renderItem: (t: T) => string,
  bold: (s: string) => string,
): void {
  const count = result.ok ? result.items.length : 0;
  lines.push(bold(`${icon} ${label} (${count})`));
  if (!result.ok) {
    lines.push(`⚠️ שגיאת שליפה — ${result.error}`);
    return;
  }
  if (result.items.length === 0) {
    lines.push("אין פריטים כרגע.");
    return;
  }
  for (const item of result.items) lines.push(renderItem(item));
}

/**
 * טקסט "העבודה שלי" — חמש הקטגוריות, תמיד באותו סדר ועם אותן כותרות (מודגשות, עם אייקון
 * וספירה), גם כשריקות/נכשלו (דרישת מוטי, 2026-10-08/11/13). מקור עיצוב יחיד — נצרך מ-
 * get_today_tasks, get_my_pipeline (ops/chat.ts) ומ-list_my_work (ops/myWorkBrief.ts, WhatsApp).
 * בלי כותרת/ברכה — ר' formatEmployeeFeedBriefing לתדריך היומי המלא.
 */
export function formatEmployeeFeedText(feed: EmployeeFeed, opts: FormatFeedOpts = {}): string {
  const bold = opts.bold ?? defaultBold;
  const lines: string[] = [];
  pushSection(lines, "🆕", "לידים חדשים", feed.newLeads, (l) => `• ${l.name}${l.status ? ` — ${l.status}` : ""}`, bold);
  lines.push("");
  pushSection(lines, "🆕", "עסקאות חדשות", feed.newDeals, (d) => `• ${d.name}${d.stage ? ` — ${d.stage}` : ""}`, bold);
  lines.push("");
  pushSection(lines, "📌", "עסקאות לטיפול", feed.dealsNeedingAttention, (d) => `• ${d.name} — ${fmtDue(d, d.reminderDate)}`, bold);
  lines.push("");
  pushSection(lines, "📝", "משימות רגילות", feed.tasks, (t) => `• ${t.name} — ${fmtDue(t, t.dueDate)}`, bold);
  lines.push("");
  pushSection(
    lines,
    "🗂️",
    "משימות פרויקטים",
    feed.projectTasks,
    (t) => {
      const where = t.project ? (t.stage ? `${t.project} › ${t.stage}` : t.project) : (t.stage ?? "");
      return `• ${t.name}${where ? ` (${where})` : ""} — ${fmtDue(t, t.dueDate)}`;
    },
    bold,
  );
  return lines.join("\n");
}

/** "בוקר טוב" / "צהריים טובים" / "ערב טוב" לפי השעה — מקור אחד, לא כפול בין web/WhatsApp. */
export function greetingFor(now: DateTime): string {
  const hour = now.hour;
  return hour < 12 ? "בוקר טוב" : hour < 17 ? "צהריים טובים" : "ערב טוב";
}

/**
 * התדריך האישי המלא: כותרת ("<ברכה>, <שם> ☀️" + "סדר העבודה שלך להיום") ואחריה חמש הקטגוריות —
 * תצוגה אחת, בלי תדריך-פרויקטים ישן נוסף לפניה (דרישת מוטי, 2026-10-13: "Employee Feed בלבד").
 * זה כל מה שנשלח למשתמש כשהוא שואל "מה יש לי היום" — לא רק בניין-עזר לקטגוריות.
 */
export function formatEmployeeFeedBriefing(
  userName: string,
  feed: EmployeeFeed,
  now: DateTime = DateTime.now().setZone(env.TIMEZONE),
  opts: FormatFeedOpts = {},
): string {
  const greet = greetingFor(now);
  return `${greet}, ${userName} ☀️\nסדר העבודה שלך להיום\n\n${formatEmployeeFeedText(feed, opts)}`;
}

export interface EmployeeFeedCounts {
  newLeads: number;
  newDeals: number;
  dealsNeedingAttention: number;
  tasks: number;
  projectTasks: number;
  /** שמות הקטגוריות ששליפתן נכשלה — ריק אם הכול הצליח. */
  errors: string[];
}

const CATEGORY_LABELS: Record<keyof EmployeeFeed, string> = {
  newLeads: "לידים חדשים",
  newDeals: "עסקאות חדשות",
  dealsNeedingAttention: "עסקאות לטיפול",
  tasks: "משימות רגילות",
  projectTasks: "משימות פרויקטים",
};

/** ספירות לכל קטגוריה (0 אם נכשלה — לא מוצגת כ-false-empty בלי ציון) + רשימת קטגוריות שנכשלו. */
export function employeeFeedCounts(feed: EmployeeFeed): EmployeeFeedCounts {
  const errors: string[] = [];
  const count = (key: keyof EmployeeFeed): number => {
    const r = feed[key];
    if (r.ok) return r.items.length;
    errors.push(CATEGORY_LABELS[key]);
    return 0;
  };
  return {
    newLeads: count("newLeads"),
    newDeals: count("newDeals"),
    dealsNeedingAttention: count("dealsNeedingAttention"),
    tasks: count("tasks"),
    projectTasks: count("projectTasks"),
    errors,
  };
}
