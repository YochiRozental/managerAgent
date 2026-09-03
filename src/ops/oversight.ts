/**
 * תצוגת הבקרה של מוטי — "מה קורה בכל המשרד ואיפה כל אחד אוחז".
 *
 * מוטי מקבל שני מצבים בחלונית:
 *   1. הצ'אט — כמו כל עובד.
 *   2. "בקרה" — כל הצוות: הממצאים היזומים (controlScan) + עומס לכל אדם + פרויקטים דורשי תשומת לב.
 *
 * דורש הרשאת view:all_work (מוטי, ובזמן פיתוח גם יוכי). מחושב מעל getOfficeState (cache 3 דק').
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { userCan, type IdentifiedUser } from "../identity/index.js";
import { getOfficeState } from "./officeState.js";

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

export async function getOversightReport(user: IdentifiedUser): Promise<OversightReport> {
  if (!userCan(user, "view:all_work")) {
    throw new Error("אין למשתמש הרשאה לתצוגת הבקרה של כל המשרד");
  }

  const { now, generatedAt, perPerson, projects: activeProjects } = await getOfficeState();
  const today = now.startOf("day");

  const people: PersonWorkload[] = perPerson.map(({ member, tasks }) => {
    const overdue = tasks.filter((t) => t.flags.overdue);
    return {
      key: member.key,
      name: member.name,
      role: member.role,
      counts: {
        open: tasks.length,
        overdue: overdue.length,
        stuck: tasks.filter((t) => t.flags.stuck).length,
        blocking: tasks.filter((t) => t.flags.blocking.length > 0).length,
        dueToday: tasks.filter((t) => t.flags.dueToday).length,
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
  for (const { tasks } of perPerson) {
    for (const t of tasks) {
      if (t.source !== "project_stage") continue;
      const agg = byProject.get(t.context) ?? { open: 0, overdue: 0, stuck: 0 };
      agg.open++;
      if (t.flags.overdue) agg.overdue++;
      if (t.flags.stuck) agg.stuck++;
      byProject.set(t.context, agg);
    }
  }

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

  return {
    generatedAt,
    totals: {
      openTasks: people.reduce((s, p) => s + p.counts.open, 0),
      overdue: people.reduce((s, p) => s + p.counts.overdue, 0),
      stuck: people.reduce((s, p) => s + p.counts.stuck, 0),
      projectsFlagged: projects.length,
    },
    people,
    projects,
  };
}
