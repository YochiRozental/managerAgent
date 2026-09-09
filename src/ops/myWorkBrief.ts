/**
 * "העבודה שלי" עבור סוכן ה-AI — שכבת brief קומפקטית מעל התשתית הקיימת.
 *
 * זרימה:
 *   IdentifiedUser (המשתמש ששאל)
 *     → user.mondayUserId
 *     → getEmployeeDashboard(user)   [dashboard.ts — fetchUserOpsTasks + buildDashboardViews + reverse-deps]
 *     → myDay (+ השלמה מ-needsAttention / waitingOnMe אם דל)
 *     → עד 30 פריטים, שדות שימושיים בלבד
 *     → payload קומפקטי למודל
 *
 * מה *לא* עושים כאן (הכל כבר קיים ב-opsRead.ts / dashboard.ts, מקור אמת אחד):
 *   שאילתות Monday · זיהוי עמודות status · done-filter · project/stage mapping · לוגיקת תאריך/איחור/
 *   תעדוף/תקוע/ממתין.
 *
 * מה *לא* קורה כאן:
 *   - "שלי" = המשתמש שנשלח, לפי ה-mondayUserId שלו. לא לפי בעל טוקן ה-API, לא לפי ערך קסם של Monday.
 *   - אין תלות ב-MONDAY_BOARD_ID (fetchUserOpsTasks יודע מאילו לוחות למשוך).
 *   - אין mutations.
 */

import type { IdentifiedUser } from "../identity/index.js";
import type { DashboardTask, EmployeeDashboard } from "./dashboard.js";
import { getEmployeeDashboard } from "./dashboard.js";

/** תקרה קשיחה — לעולם לא יותר מזה במודל, גם אם ל-myDay יש מאות. */
export const BRIEF_HARD_CAP = 30;
/**
 * מ-waitingOnMe מצרפים רק פריטים משמעותיים באמת (קריטי / תקוע / חוסם אחרים), ולכל היותר כמה —
 * שאר ה-waitingOnMe מיוצגים ע"י summary.waitingOnMe בלבד, לא מוצפים לתוך הרשימה.
 */
const WAITING_EXTRA_MAX = 3;

export interface BriefTask {
  id: string;
  name: string;
  /** מאיזו תצוגת דשבורד הפריט הגיע */
  bucket: "today" | "attention" | "waiting";
  /** משימת משרד כללית או משימה בתוך פרויקט */
  source: "office" | "project";
  status: string;
  project?: string;
  projectId?: string;
  stage?: string;
  priority?: string;
  dueDate?: string;
  /** רק אם > 0 (מחושב בדשבורד) */
  daysOverdue?: number;
  /** רק אם true */
  dueToday?: boolean;
  stuck?: boolean;
  critical?: boolean;
  /** כמה משימות אחרות תלויות בזו (מחכות לה) */
  blockingOthers?: number;
  /** "באחריות" רק אם הכדור לא אצל המשרד (וועדה / לקוח / יועץ) */
  ballWith?: string;
  url: string;
}

export interface MyWorkBrief {
  user: string;
  generatedAt: string;
  summary: {
    /** כמה משימות פתוחות למשתמש סה"כ (raw — אחרי done-filter של opsRead, לפני סינון תצוגה) */
    totalOpen: number;
    today: number;
    needsAttention: number;
    waitingOnMe: number;
    /** כמה פריטים נכנסו בפועל ל-payload */
    inBrief: number;
  };
  tasks: BriefTask[];
  /** הערה קצרה למודל אם חתכנו / אם אין משימות להיום */
  note?: string;
}

const OFFICE_CONTEXTS = new Set(["", "משימת משרד", "פרויקט לא מקושר"]);

function toBriefTask(t: DashboardTask, bucket: BriefTask["bucket"]): BriefTask {
  const isOffice = OFFICE_CONTEXTS.has(t.context);
  return {
    id: t.itemId,
    name: t.name,
    bucket,
    source: t.source === "general" ? "office" : "project",
    status: t.status || "לא הוגדר",
    ...(isOffice ? {} : { project: t.context, ...(t.projectId ? { projectId: t.projectId } : {}) }),
    ...(t.stageName ? { stage: t.stageName } : {}),
    ...(t.priority ? { priority: t.priority } : {}),
    ...(t.dueDate ? { dueDate: t.dueDate } : {}),
    ...(t.flags.daysOverdue > 0 ? { daysOverdue: t.flags.daysOverdue } : {}),
    ...(t.flags.dueToday ? { dueToday: true } : {}),
    ...(t.flags.stuck ? { stuck: true } : {}),
    ...(t.flags.critical ? { critical: true } : {}),
    ...(t.flags.blocking.length ? { blockingOthers: t.flags.blocking.length } : {}),
    ...(t.responsibleParty && t.responsibleParty !== "המשרד" ? { ballWith: t.responsibleParty } : {}),
    url: t.url,
  };
}

/**
 * פונקציה טהורה — מקבלת dashboard מוכן (מ-getEmployeeDashboard) ובונה ממנו brief קומפקטי.
 * מופרד מ-getMyWorkBrief כדי שאפשר לבדוק בלי Monday.
 */
export function buildBrief(userName: string, dash: EmployeeDashboard, cap = BRIEF_HARD_CAP): MyWorkBrief {
  const limit = Math.min(Math.max(Math.floor(cap) || BRIEF_HARD_CAP, 1), BRIEF_HARD_CAP);
  const seen = new Set<string>();
  const tasks: BriefTask[] = [];

  const take = (list: DashboardTask[], bucket: BriefTask["bucket"]): void => {
    for (const t of list) {
      if (tasks.length >= limit) return;
      if (seen.has(t.itemId)) continue;
      seen.add(t.itemId);
      tasks.push(toBriefTask(t, bucket));
    }
  };

  // 1. הבסיס — כל myDay (עד ה-hard cap). זה מה ש"צריך לעשות היום" לפי הדשבורד.
  take(dash.myDay, "today");

  // 2. needsAttention שאינו כבר ב-myDay — חריגות אמיתיות (תקוע / באיחור כבד / קריטי / חוסם),
  //    כבר מסונן ומתועדף ע"י הדשבורד. לא "ממלאים" — פשוט לא מפילים חריגה אמיתית.
  take(dash.needsAttention, "attention");

  // 3. waitingOnMe — לא בכמות. רק פריטים שבאמת דחופים (קריטי / תקוע / מישהו חוסם עליהם),
  //    ולכל היותר WAITING_EXTRA_MAX. השאר מיוצג ע"י summary.waitingOnMe בלבד.
  const waitingExtras = dash.waitingOnMe
    .filter((t) => !seen.has(t.itemId) && (t.flags.critical || t.flags.stuck || t.flags.blocking.length > 0))
    .slice(0, WAITING_EXTRA_MAX);
  take(waitingExtras, "waiting");

  const summary: MyWorkBrief["summary"] = {
    totalOpen: dash.counts.totalOpen,
    today: dash.counts.myDay,
    needsAttention: dash.counts.needsAttention,
    waitingOnMe: dash.counts.waitingOnMe,
    inBrief: tasks.length,
  };

  const shownToday = tasks.filter((t) => t.bucket === "today").length;
  let note: string | undefined;
  if (summary.today > shownToday) {
    note = `מוצגות ${shownToday} מתוך ${summary.today} משימות להיום (הדחופות ביותר, לפי סדר הדשבורד).`;
  } else if (summary.today === 0) {
    note =
      summary.needsAttention || summary.waitingOnMe
        ? "אין משימות שמתוזמנות להיום; מוצגות משימות שדורשות תשומת לב."
        : "אין משימות פתוחות שדורשות טיפול היום.";
  }

  return { user: userName, generatedAt: dash.generatedAt, summary, tasks, ...(note ? { note } : {}) };
}

export interface MyWorkBriefDeps {
  /** להזרקה בבדיקות — ברירת מחדל getEmployeeDashboard האמיתי */
  getDashboard?: (user: IdentifiedUser) => Promise<EmployeeDashboard>;
}

/**
 * ה-brief של "מה עליי לבצע היום" עבור משתמש מזוהה.
 * זורק שגיאה ברורה אם אין mondayUserId — **לא** נופל למשתמש אחר / לבעל הטוקן.
 */
export async function getMyWorkBrief(
  user: IdentifiedUser,
  opts: { limit?: number } = {},
  deps: MyWorkBriefDeps = {},
): Promise<MyWorkBrief> {
  if (!user.mondayUserId) {
    throw new Error(
      `ל${user.name} אין חשבון Monday מקושר — אי אפשר לשלוף את העבודה האישית. ` +
        `(המערכת לא נופלת למשתמש אחר ולא לבעל טוקן ה-API.)`,
    );
  }
  const getDashboard = deps.getDashboard ?? getEmployeeDashboard;
  const dash = await getDashboard(user);
  return buildBrief(user.name, dash, opts.limit ?? BRIEF_HARD_CAP);
}
