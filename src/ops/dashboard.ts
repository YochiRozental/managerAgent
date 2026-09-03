/**
 * שלוש התצוגות של חלונית העובד (שלב 1) — נבנות מתוך רשימת המשימות של המשתמש.
 *
 * ההגדרות כאן הן גרסה ראשונה ומכוונות לכיוונון אחרי הרצה (CLAUDE.md סעיף 7). כל תצוגה
 * היא פונקציה טהורה שמקבלת את המשימות, את "היום" ואת מפת התלויות ההפוכה.
 *
 *  • היום שלי        — מה לעשות היום: באיחור / להיום / השבוע / כבר בעבודה. בלי מה שתקוע אצל גורם חיצוני.
 *  • דורש תשומת לב    — רשימת ההתראות: תקוע, באיחור כבד, קריטי פתוח, או חוסם משימה אחרת.
 *  • מחכים ממני       — הכדור אצלי, וטרם התחלתי — במיוחד כשמשימה אחרת תלויה בזו.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { userCan, type IdentifiedUser } from "../identity/index.js";
import {
  fetchUserOpsTasks,
  getReverseDependencyMap,
  type DependentRef,
  type OpsTask,
} from "../integrations/monday/opsRead.js";

/** סטטוסים שמשמעותם "הכדור אצל גורם חיצוני" — לא באיחור שלי. */
const WAITING_EXTERNAL_STATUS = new Set([
  "ממתין ללקוח",
  "מתתין ליועץ/ספק/אחר",
  "בטיפול ועדה",
  "ממתין להתייחסות",
  "חסר מידע",
  "העברתי לקונטריל",
]);
const EXTERNAL_PARTY = new Set(["וועדה", "הלקוח", "קבלן//יועץ/ספק/צד ג'"]);

const STUCK = "תקוע";
const IN_PROGRESS = "בעבודה";
const TODO = "לביצוע";
const UNDEFINED_STATUS = new Set(["", "טרם הוגדר"]);

export interface TaskFlags {
  overdue: boolean;
  daysOverdue: number;
  dueToday: boolean;
  dueThisWeek: boolean;
  stuck: boolean;
  critical: boolean;
  waitingExternal: boolean;
  /** משימות פתוחות שתלויות במשימה הזו (כלומר — מחכות שהיא תסתיים) */
  blocking: DependentRef[];
}

export interface DashboardTask extends OpsTask {
  flags: TaskFlags;
}

export interface EmployeeDashboard {
  user: { key: string; name: string; role: string };
  generatedAt: string;
  counts: { myDay: number; needsAttention: number; waitingOnMe: number; totalOpen: number };
  myDay: DashboardTask[];
  needsAttention: DashboardTask[];
  waitingOnMe: DashboardTask[];
}

function computeFlags(task: OpsTask, today: DateTime, reverseDeps: Map<string, DependentRef[]>): TaskFlags {
  const due = task.dueDate ? DateTime.fromISO(task.dueDate, { zone: env.TIMEZONE }).startOf("day") : null;
  const daysOverdue = due && due < today ? Math.floor(today.diff(due, "days").days) : 0;
  const critical = (task.priority ?? "").includes("קריטי");
  const waitingExternal =
    WAITING_EXTERNAL_STATUS.has(task.status) ||
    (task.responsibleParty ? EXTERNAL_PARTY.has(task.responsibleParty) : false);
  const blocking = reverseDeps.get(task.itemId) ?? [];

  return {
    overdue: daysOverdue > 0,
    daysOverdue,
    dueToday: !!due && +due === +today,
    dueThisWeek: !!due && due >= today && due <= today.plus({ days: 7 }),
    stuck: task.status === STUCK,
    critical,
    waitingExternal,
    blocking,
  };
}

/** מוסיף לכל משימה את הדגלים המחושבים (איחור/תקוע/קריטי/חוסם וכו'). */
export function enrichTasks(
  tasks: OpsTask[],
  now: DateTime = DateTime.now().setZone(env.TIMEZONE),
  reverseDeps: Map<string, DependentRef[]> = new Map(),
): DashboardTask[] {
  const today = now.startOf("day");
  return tasks.map((t) => ({ ...t, flags: computeFlags(t, today, reverseDeps) }));
}

/** ממיין: באיחור (הכי ותיק קודם) → להיום → השאר לפי תאריך, ריק בסוף. */
function sortForDisplay(a: DashboardTask, b: DashboardTask): number {
  const rank = (t: DashboardTask) => (t.flags.overdue ? 0 : t.flags.dueToday ? 1 : t.dueDate ? 2 : 3);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99");
}

export function buildDashboardViews(
  tasks: OpsTask[],
  now: DateTime = DateTime.now().setZone(env.TIMEZONE),
  reverseDeps: Map<string, DependentRef[]> = new Map(),
): Pick<EmployeeDashboard, "myDay" | "needsAttention" | "waitingOnMe"> {
  const enriched = enrichTasks(tasks, now, reverseDeps);

  const myDay = enriched
    .filter((t) => {
      if (t.flags.waitingExternal && !t.flags.overdue) return false;
      return t.flags.overdue || t.flags.dueToday || t.flags.dueThisWeek || t.status === IN_PROGRESS;
    })
    .sort(sortForDisplay);

  const needsAttention = enriched
    .filter((t) => {
      if (t.flags.stuck) return true;
      if (t.flags.overdue && t.flags.daysOverdue >= 3) return true;
      if (t.flags.critical && (t.flags.overdue || t.flags.dueToday || !t.dueDate)) return true;
      if (t.flags.blocking.length > 0 && (t.flags.overdue || t.flags.dueToday)) return true;
      if (UNDEFINED_STATUS.has(t.status) && !t.flags.waitingExternal && t.dueDate) return true;
      return false;
    })
    .sort((a, b) => {
      const sev = (t: DashboardTask) => (t.flags.stuck ? 0 : t.flags.critical ? 1 : t.flags.blocking.length ? 2 : 3);
      return sev(a) - sev(b) || sortForDisplay(a, b);
    });

  const waitingOnMe = enriched
    .filter((t) => {
      if (t.flags.waitingExternal) return false;
      const ballWithOffice = !t.responsibleParty || t.responsibleParty === "המשרד";
      const notStarted = t.status === TODO || t.flags.stuck || UNDEFINED_STATUS.has(t.status);
      if (!ballWithOffice || !notStarted) return false;
      // משימה אחרת תלויה בזו → מישהו ממש מחכה. אחרת — רק אם יש דדליין או שהיא תקועה.
      return t.flags.blocking.length > 0 || !!t.dueDate || t.flags.stuck;
    })
    .sort((a, b) => {
      const wa = a.flags.blocking.length > 0 ? 0 : 1;
      const wb = b.flags.blocking.length > 0 ? 0 : 1;
      return wa - wb || sortForDisplay(a, b);
    });

  return { myDay, needsAttention, waitingOnMe };
}

/**
 * התצוגה המלאה למשתמש מזוהה. דורש הרשאת view:own_work ו-mondayUserId.
 * גולדי (כספים, בלי חשבון Monday) — אין לה מקור משימות כזה כרגע, מוחזר ריק.
 */
export async function getEmployeeDashboard(user: IdentifiedUser): Promise<EmployeeDashboard> {
  if (!userCan(user, "view:own_work")) {
    throw new Error("אין למשתמש הרשאה לראות את העבודה שלו");
  }

  const now = DateTime.now().setZone(env.TIMEZONE);
  const base: EmployeeDashboard = {
    user: { key: user.key, name: user.name, role: user.role },
    generatedAt: now.toISO() ?? "",
    counts: { myDay: 0, needsAttention: 0, waitingOnMe: 0, totalOpen: 0 },
    myDay: [],
    needsAttention: [],
    waitingOnMe: [],
  };

  if (!user.mondayUserId) return base;

  const [tasks, reverseDeps] = await Promise.all([
    fetchUserOpsTasks(user.mondayUserId),
    getReverseDependencyMap().catch(() => new Map<string, DependentRef[]>()),
  ]);
  const views = buildDashboardViews(tasks, now, reverseDeps);

  return {
    ...base,
    counts: {
      myDay: views.myDay.length,
      needsAttention: views.needsAttention.length,
      waitingOnMe: views.waitingOnMe.length,
      totalOpen: tasks.length,
    },
    ...views,
  };
}
