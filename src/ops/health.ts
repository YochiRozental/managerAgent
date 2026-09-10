/**
 * מצב בריאות המערכת — תמונה מהירה וסינכרונית (בלי קריאות רשת) ל-GET /health.
 *
 * "תקין" = כל התהליכים הנדרשים פועמים, הסבב היומי של היום רץ בהצלחה, יש גיבוי טרי,
 * ולא הייתה תקלה לא-מטופלת לאחרונה. אחרת → "degraded" עם רשימת סיבות בעברית.
 *
 * מקורות: טבלת heartbeats, טבלת job_runs, תיקיית הגיבויים, ודגל בזיכרון שמנוע התקלות מדליק.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { lastBackupDate } from "./backup.js";
import {
  lastJobRun,
  lastSuccessfulJobRun,
  listHeartbeats,
} from "../db/repositories/systemHealth.js";

const HEARTBEAT_STALE_SEC = 180; // פעימה כל 60ש' — 3 החמצות = בעיה
const BACKUP_STALE_DAYS = 2;
const RECENT_INCIDENT_MIN = 15;
const DAILY_HOUR = Number(process.env.CONTROL_SCAN_HOUR ?? 7);

/** תהליכים שאמורים לפעום תמיד. */
const REQUIRED_PROCESSES = ["ops-window", "whatsapp-agent"] as const;

interface Incident {
  at: string;
  kind: string;
  message: string;
}
let lastIncident: Incident | null = null;

/** נקרא ממנהלי התקלות ב-server/index.ts. נשמר בזיכרון בלבד — נעלם בריסטרט (וזה בסדר). */
export function noteIncident(kind: string, message: string): void {
  lastIncident = { at: new Date().toISOString(), kind, message: message.slice(0, 300) };
}

export interface HealthReport {
  status: "ok" | "degraded";
  now: string;
  uptimeSec: number;
  reasons: string[];
  processes: { name: string; alive: boolean; lastBeat: string | null; ageSec: number | null }[];
  jobs: {
    name: string;
    lastRun: string | null;
    lastOk: string | null;
    lastResult: "ok" | "fail" | "running" | "never";
  }[];
  backup: { last: string | null; stale: boolean };
  lastIncident: Incident | null;
}

/** timestamps מ-SQLite הם "YYYY-MM-DD HH:MM:SS" ב-UTC (datetime('now')). */
function parseDbTime(s: string): DateTime {
  const dt = DateTime.fromSQL(s, { zone: "utc" });
  return dt.isValid ? dt : DateTime.fromISO(s, { zone: "utc" });
}

function ageSeconds(s: string, now: DateTime): number {
  return Math.round(now.diff(parseDbTime(s)).as("seconds"));
}

export function getHealth(): HealthReport {
  const now = DateTime.now().setZone(env.TIMEZONE);
  const reasons: string[] = [];

  // --- תהליכים ---
  const beats = new Map(listHeartbeats().map((b) => [b.process, b.beatAt]));
  const processes = REQUIRED_PROCESSES.map((name) => {
    const beat = beats.get(name) ?? null;
    const age = beat ? ageSeconds(beat, now) : null;
    const alive = age !== null && age <= HEARTBEAT_STALE_SEC;
    if (!alive) reasons.push(beat ? `התהליך ${name} לא פעם ${age}ש'` : `התהליך ${name} מעולם לא פעם`);
    return { name, alive, lastBeat: beat, ageSec: age };
  });

  // --- עבודות מתוזמנות ---
  // הגיבוי לא כאן — יש לו שדה נפרד (backup) שנשען על תאריך הקובץ, לא על job_runs.
  const jobDefs: { key: string; label: string; expectedToday: boolean }[] = [
    { key: "daily_cycle", label: "סבב יומי", expectedToday: now.weekday !== 5 && now.weekday !== 6 },
    { key: "weekly_report", label: "דוח שבועי", expectedToday: now.weekday === 7 },
  ];
  const jobs = jobDefs.map((j) => {
    const last = lastJobRun(j.key);
    const lastOk = lastSuccessfulJobRun(j.key);
    const lastResult: "ok" | "fail" | "running" | "never" = !last
      ? "never"
      : last.ok === 1
        ? "ok"
        : last.ok === 0
          ? "fail"
          : "running";

    // נחשב מאחר רק אחרי שהשעה המתוזמנת + שעתיים חלפה, כדי לא לצעוק על שרת שרק עלה בבוקר.
    const pastWindow = now.hour >= DAILY_HOUR + 2;
    // ריצה שנמצאת כרגע בתהליך (התחילה לאחרונה) — לא "מאחר", היא פשוט עוד לא סיימה.
    const runningNow =
      lastResult === "running" &&
      !!last &&
      now.diff(parseDbTime(last.startedAt)).as("minutes") < 20;
    // חלון חסד אחרי עליית התהליך — ה-catch-up צריך זמן לרוץ.
    const startupGrace = process.uptime() < 12 * 60;
    if (j.expectedToday && pastWindow && !runningNow && !startupGrace) {
      const okToday = lastOk && parseDbTime(lastOk.startedAt).setZone(env.TIMEZONE).hasSame(now, "day");
      if (!okToday) reasons.push(`${j.label} של היום עדיין לא רץ בהצלחה`);
    }
    return { name: j.label, lastRun: last?.startedAt ?? null, lastOk: lastOk?.startedAt ?? null, lastResult };
  });

  // --- גיבוי ---
  const backupLast = lastBackupDate();
  const backupStale =
    !backupLast || DateTime.fromISO(backupLast).diff(now.startOf("day")).as("days") < -BACKUP_STALE_DAYS;
  if (backupStale) reasons.push(backupLast ? `הגיבוי האחרון מ-${backupLast}` : "אין גיבוי DB כלל");

  // --- תקלה לא-מטופלת לאחרונה ---
  if (lastIncident) {
    const mins = (Date.now() - Date.parse(lastIncident.at)) / 60000;
    if (mins <= RECENT_INCIDENT_MIN) reasons.push(`תקלה לא-מטופלת לפני ${Math.round(mins)} דק' (${lastIncident.kind})`);
  }

  return {
    status: reasons.length === 0 ? "ok" : "degraded",
    now: now.toISO()!,
    uptimeSec: Math.round(process.uptime()),
    reasons,
    processes,
    jobs,
    backup: { last: backupLast, stale: backupStale },
    lastIncident,
  };
}
