/**
 * מצב המשרד — שכבת האיסוף המשותפת לתצוגת הבקרה (oversight) ולמנוע הבקרה (controlScan).
 *
 * כבד: מושך את המשימות הפתוחות של כל חברי הצוות + הפרויקטים הפעילים + מפת התלויות. לכן נשמר
 * ב-cache קצר. שני הצרכנים למעלה הם רק טרנספורמציות זולות מעל המידע הזה.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { TEAM_DIRECTORY, type TeamMember } from "../identity/index.js";
import {
  fetchActiveProjects,
  fetchUserOpsTasks,
  getReverseDependencyMap,
  type DependentRef,
  type ProjectMeta,
} from "../integrations/monday/opsRead.js";
import { enrichTasks, type DashboardTask } from "./dashboard.js";

export interface OfficeState {
  now: DateTime;
  generatedAt: string;
  /** משימות פתוחות פר-חבר צוות (עם דגלים) */
  perPerson: { member: TeamMember; tasks: DashboardTask[] }[];
  /** כל המשימות הפתוחות בצוות, ללא כפילויות (משימה משותפת מופיעה פעם אחת) */
  allTasks: DashboardTask[];
  projects: ProjectMeta[];
  reverseDeps: Map<string, DependentRef[]>;
}

let cache: { at: number; generation: number; state: OfficeState } | null = null;
const TTL_MS = 3 * 60_000;
/**
 * שליפה פעילה (single-flight) — בקשות מקבילות שמגיעות כש-cache קר מצטרפות לאותה שליפה אחת
 * במקום לכפול את קריאות ה-Monday (getReverseDependencyMap + fetchActiveProjects + 6 חברי צוות).
 * force=true לא מצטרף אליה ולא נרשם בה בכוונה — ר' getOfficeState.
 */
let inFlight: Promise<OfficeState> | null = null;
/**
 * מונה מונוטוני לקביעת "מי התחיל מאוחר יותר" בין שליפות חופפות — Date.now() לא מספיק (רזולוציה
 * של אלפית שנייה; שתי קריאות סינכרוניות ברצף, כמו getOfficeState()+getOfficeState(true) בלי await
 * ביניהן, יכולות לקבל timestamp זהה). ++ סינכרוני מובטח להיות שונה בכל קריאה, בלי תלות בשעון.
 */
let nextGeneration = 0;

/** מקבילות מוגבלת — מהיר יותר מטור, בלי להטיס את תקרת המורכבות של Monday (mondayRequest עושה retry). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

async function fetchOfficeState(): Promise<OfficeState> {
  const now = DateTime.now().setZone(env.TIMEZONE);
  const members = TEAM_DIRECTORY.filter((m) => m.mondayUserId);

  const [reverseDeps, projects] = await Promise.all([
    getReverseDependencyMap().catch(() => new Map<string, DependentRef[]>()),
    fetchActiveProjects().catch(() => [] as ProjectMeta[]),
  ]);

  const perPerson = await mapPool(members, 3, async (m) => {
    const tasks = await fetchUserOpsTasks(m.mondayUserId!);
    return { member: m, tasks: enrichTasks(tasks, now, reverseDeps) };
  });

  const seen = new Set<string>();
  const allTasks: DashboardTask[] = [];
  for (const { tasks } of perPerson) {
    for (const t of tasks) {
      if (seen.has(t.itemId)) continue;
      seen.add(t.itemId);
      allTasks.push(t);
    }
  }

  return {
    now,
    generatedAt: now.toISO() ?? "",
    perPerson,
    allTasks,
    projects,
    reverseDeps,
  };
}

export async function getOfficeState(force = false): Promise<OfficeState> {
  if (!force) {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.state;
    if (inFlight) return inFlight;
  }

  const generation = ++nextGeneration; // סינכרוני — לא יכול להתנגש גם כש-Date.now() זהה בין שתי קריאות
  const promise: Promise<OfficeState> = fetchOfficeState().then(
    (state) => {
      // משווים לפי מי התחיל מאוחר יותר (generation) — שליפה שהתחילה לפני cache.generation (למשל
      // force מקביל שכבר הספיק לכתוב) לא דורסת תוצאה שהתחילה מאוחר יותר ולכן עדכנית ממנה.
      if (!cache || generation >= cache.generation) {
        cache = { at: Date.now(), generation, state };
      }
      if (!force && inFlight === promise) inFlight = null;
      return state;
    },
    (err) => {
      if (!force && inFlight === promise) inFlight = null;
      throw err;
    },
  );

  if (!force) inFlight = promise;
  return promise;
}
