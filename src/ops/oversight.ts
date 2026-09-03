/**
 * תצוגת הבקרה של מוטי (שלב 1) — "מה קורה בכל המשרד ואיפה כל אחד אוחז".
 *
 * מוטי מקבל שני מצבים בחלונית:
 *   1. "היום שלי" — בדיוק כמו כל עובד (התזכורות על המשימות שלו).       → getEmployeeDashboard
 *   2. "בקרה" — כל הצוות: עומס לכל אדם + פרויקטים שדורשים תשומת לב.     → getOversightReport (כאן)
 *
 * דורש הרשאת view:all_work (מוטי, ובזמן פיתוח גם יוכי).
 * גרסה ראשונה — נטענת לפי דרישה ונשמרת ב-cache קצר כי היא כבדה (סורקת את המשימות של כל הצוות).
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { TEAM_DIRECTORY, userCan, type IdentifiedUser } from "../identity/index.js";
import {
  fetchActiveProjects,
  fetchUserOpsTasks,
  getReverseDependencyMap,
  type DependentRef,
} from "../integrations/monday/opsRead.js";
import { enrichTasks, type DashboardTask } from "./dashboard.js";

export interface PersonWorkload {
  key: string;
  name: string;
  role: string;
  counts: { open: number; overdue: number; stuck: number; blocking: number; dueToday: number };
  worst: { name: string; context: string; dueDate?: string; daysOverdue: number; status: string }[];
}

export interface ProjectRow {
  name: string;
  owner: string;
  status: string;
  deliveryDate?: string;
  tasks: { open: number; overdue: number; stuck: number };
  flags: string[];
}

export interface OversightReport {
  generatedAt: string;
  totals: { openTasks: number; overdue: number; stuck: number; projectsFlagged: number };
  people: PersonWorkload[];
  projects: ProjectRow[];
}

let cache: { at: number; report: OversightReport } | null = null;
const TTL_MS = 3 * 60_000;

/** מריץ משימות בטור עם השהיה קטנה — עדיף איטי מאשר להתנגש בתקרת המורכבות של Monday. */
async function mapSerial<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}

export async function getOversightReport(user: IdentifiedUser): Promise<OversightReport> {
  if (!userCan(user, "view:all_work")) {
    throw new Error("אין למשתמש הרשאה לתצוגת הבקרה של כל המשרד");
  }
  if (cache && Date.now() - cache.at < TTL_MS) return cache.report;

  const now = DateTime.now().setZone(env.TIMEZONE);
  const members = TEAM_DIRECTORY.filter((m) => m.mondayUserId);

  const reverseDeps = await getReverseDependencyMap().catch(() => new Map<string, DependentRef[]>());

  const perPerson = await mapSerial(members, async (m) => {
    const tasks = await fetchUserOpsTasks(m.mondayUserId!);
    const enriched = enrichTasks(tasks, now, reverseDeps);
    return { member: m, enriched };
  });

  // עומס לכל אדם
  const people: PersonWorkload[] = perPerson.map(({ member, enriched }) => {
    const overdue = enriched.filter((t) => t.flags.overdue);
    return {
      key: member.key,
      name: member.name,
      role: member.role,
      counts: {
        open: enriched.length,
        overdue: overdue.length,
        stuck: enriched.filter((t) => t.flags.stuck).length,
        blocking: enriched.filter((t) => t.flags.blocking.length > 0).length,
        dueToday: enriched.filter((t) => t.flags.dueToday).length,
      },
      worst: [...overdue]
        .sort((a, b) => b.flags.daysOverdue - a.flags.daysOverdue)
        .slice(0, 3)
        .map((t) => ({
          name: t.name,
          context: t.stageName ? `${t.context} › ${t.stageName}` : t.context,
          dueDate: t.dueDate,
          daysOverdue: t.flags.daysOverdue,
          status: t.status,
        })),
    };
  });

  // צבירת מצב משימות פר-פרויקט (לפי שם הפרויקט שמופיע במשימה)
  const byProject = new Map<string, { open: number; overdue: number; stuck: number }>();
  for (const { enriched } of perPerson) {
    for (const t of enriched) {
      if (t.source !== "project_stage") continue;
      const key = t.context;
      const agg = byProject.get(key) ?? { open: 0, overdue: 0, stuck: 0 };
      agg.open++;
      if (t.flags.overdue) agg.overdue++;
      if (t.flags.stuck) agg.stuck++;
      byProject.set(key, agg);
    }
  }

  const today = now.startOf("day");
  const activeProjects = await fetchActiveProjects();

  const projects: ProjectRow[] = [];
  for (const p of activeProjects) {
    const t = byProject.get(p.name) ?? { open: 0, overdue: 0, stuck: 0 };
    const flags: string[] = [];
    if (p.status === "תקוע") flags.push("פרויקט תקוע");
    if (p.status === "מוקפא") flags.push("מוקפא");
    const delivery = p.deliveryDate
      ? DateTime.fromISO(p.deliveryDate, { zone: env.TIMEZONE }).startOf("day")
      : null;
    if (delivery && delivery < today && p.status !== "לקראת מסירה") flags.push("איחור מסירה");
    if (t.stuck > 0) flags.push(`${t.stuck} משימות תקועות`);
    if (t.overdue > 0) flags.push(`${t.overdue} משימות באיחור`);
    if (!p.owner) flags.push("בלי אחראי");

    if (flags.length === 0) continue;
    projects.push({
      name: p.name,
      owner: p.owner || "—",
      status: p.status || "—",
      deliveryDate: p.deliveryDate,
      tasks: t,
      flags,
    });
  }

  projects.sort((a, b) => {
    const sev = (r: ProjectRow) =>
      (r.flags.some((f) => f.includes("תקוע")) ? 0 : 1) * 100 - r.tasks.overdue - r.tasks.stuck;
    return sev(a) - sev(b);
  });

  const report: OversightReport = {
    generatedAt: now.toISO() ?? "",
    totals: {
      openTasks: people.reduce((s, p) => s + p.counts.open, 0),
      overdue: people.reduce((s, p) => s + p.counts.overdue, 0),
      stuck: people.reduce((s, p) => s + p.counts.stuck, 0),
      projectsFlagged: projects.length,
    },
    people,
    projects,
  };

  cache = { at: Date.now(), report };
  return report;
}
