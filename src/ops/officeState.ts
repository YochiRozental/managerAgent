/**
 * מצב המשרד — שכבת האיסוף המשותפת לתצוגת הבקרה (oversight) ולמנוע הבקרה (controlScan).
 *
 * כבד: מושך את המשימות הפתוחות של כל חברי הצוות + הפרויקטים הפעילים + מפת התלויות. לכן נשמר
 * ב-cache קצר. שני הצרכנים למעלה הם רק טרנספורמציות זולות מעל המידע הזה.
 */

import { DateTime } from "luxon";
import { performance } from "node:perf_hooks";
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

/**
 * ניטור ביצועים פנימי (2026-10-14) — ספירות hit/joined/fetched מצטברות מאז עליית התהליך, ופירוק
 * זמן השליפה הכבדה האחרונה לשלבים (reverseDeps/activeProjects/userTasks). in-memory בלבד, בלי
 * Monday/DB/AI — נועד להיקרא אחרי Promise.all (ר' chat.ts's office_overview) ולהידחף ל-
 * chat_perf_steps דרך timedPrepStep הקיים. בכוונה *בלי* שם עובד/פרויקט/משימה — רק מספרים ומונים.
 * מצטבר יחיד פר-תהליך (לא פר-בקשה) — אם שני כלים/משתמשים קוראים ל-getOfficeState במקביל ממש
 * (נדיר בחלונית פנים-משרדית), lastFetch עלול לשקף איזו מהן התבצעה בפועל; הקורא משווה delta
 * לפני/אחרי כדי לדעת מה קרה *בחלון* הקריאה שלו, ר' docstring ב-getOfficeStateDiagnostics.
 */
export interface OfficeStateDiagnostics {
  hits: number;
  joinedInFlight: number;
  fetched: number;
  /** פירוט השליפה הכבדה האחרונה שבוצעה בפועל (null אם עדיין לא בוצעה שליפה מאז עליית התהליך) */
  lastFetch: {
    reverseDepsMs: number;
    activeProjectsMs: number;
    userTasksMs: number;
    totalMs: number;
    generation: number;
    /** כמה חברי צוות נכללו במחזור הזה — לשחזור הציפייה הנכונה בבדיקת האמינות של user_tasks (ר' chat.ts). */
    memberCount: number;
  } | null;
}
let diagHits = 0;
let diagJoined = 0;
let diagFetched = 0;
let diagLastFetch: OfficeStateDiagnostics["lastFetch"] = null;

/**
 * תמונת מצב של הניטור — לקריאה מיידית בפרודקשן בלי debug logging ובלי restart (הקורא משווה שתי
 * קריאות, לפני ואחרי פעולה, ומחשב delta — ר' chat.ts's office_overview).
 */
export function getOfficeStateDiagnostics(): OfficeStateDiagnostics {
  return { hits: diagHits, joinedInFlight: diagJoined, fetched: diagFetched, lastFetch: diagLastFetch };
}

/**
 * מקבילות מוגבלת — מהיר יותר מטור, בלי להטיס את תקרת המורכבות של Monday (mondayRequest עושה retry).
 * `fn` מקבל גם את ה-idx (מיקום במערך) — משמש ל"אינדקס צוות" במדידת user_tasks (ר' fetchOfficeState),
 * לא משנה שום לוגיקת הרצה.
 */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!, idx);
      }
    }),
  );
  return out;
}

async function fetchOfficeState(generation: number): Promise<OfficeState> {
  const fetchStart = performance.now();
  const now = DateTime.now().setZone(env.TIMEZONE);
  const members = TEAM_DIRECTORY.filter((m) => m.mondayUserId);

  // שני ה-.finally() לא חוסמים זה את זה — Promise.all עדיין מריץ אותם במקביל, רק נמדד כל אחד בנפרד.
  let reverseDepsMs = 0;
  let activeProjectsMs = 0;
  const revDepStart = performance.now();
  const activeProjStart = performance.now();
  const [reverseDeps, projects] = await Promise.all([
    getReverseDependencyMap()
      .catch(() => new Map<string, DependentRef[]>())
      .finally(() => {
        reverseDepsMs = performance.now() - revDepStart;
      }),
    fetchActiveProjects()
      .catch(() => [] as ProjectMeta[])
      .finally(() => {
        activeProjectsMs = performance.now() - activeProjStart;
      }),
  ]);

  const userTasksStart = performance.now();
  const perPerson = await mapPool(members, 5, async (m, idx) => {
    const tasks = await fetchUserOpsTasks(m.mondayUserId!, { generation, teamIndex: idx });
    return { member: m, tasks: enrichTasks(tasks, now, reverseDeps) };
  });
  const userTasksMs = performance.now() - userTasksStart;

  const seen = new Set<string>();
  const allTasks: DashboardTask[] = [];
  for (const { tasks } of perPerson) {
    for (const t of tasks) {
      if (seen.has(t.itemId)) continue;
      seen.add(t.itemId);
      allTasks.push(t);
    }
  }

  diagLastFetch = {
    reverseDepsMs,
    activeProjectsMs,
    userTasksMs,
    totalMs: performance.now() - fetchStart,
    generation,
    memberCount: members.length,
  };
  diagFetched++;

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
    if (cache && Date.now() - cache.at < TTL_MS) {
      diagHits++;
      return cache.state;
    }
    if (inFlight) {
      diagJoined++;
      return inFlight;
    }
  }

  const generation = ++nextGeneration; // סינכרוני — לא יכול להתנגש גם כש-Date.now() זהה בין שתי קריאות
  const promise: Promise<OfficeState> = fetchOfficeState(generation).then(
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
