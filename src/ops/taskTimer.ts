/**
 * מדידת זמן עבודה על משימות (Task Timer) — שכבת ה-IO: כללי התחלה/עצירה/החלפה/המשך, דוחות, תזכורת
 * וסריקת תחזוקה. הלוגיקה הטהורה ב-taskTimerEngine.ts, ה-DB ב-db/repositories/taskTimers.ts.
 *
 * עקרונות (ר' גם schema.sql):
 *  • טיימר פעיל אחד לעובד — נאכף באינדקס חלקי ב-DB (לא רק בקוד), וההתחלה בטרנזקציה.
 *  • הזמן האפקטיבי נגזר בקריאה: חיתוך המקטע עם מקטעי העבודה של יום הנוכחות (בלי הפסקות, עד שעת הסגירה
 *    המדווחת). הנוכחות עצמה לא משתנה — מקבלים ממנה קריאה בלבד (getEffectiveAttendance).
 *  • הפסקה לא עוצרת את המקטע: החיתוך מוציא אותה, וחזרה מהפסקה "מחדשת" את הספירה מעצמה. הטיימר לא
 *    מתחדש אם היום נסגר (אין מקטע עבודה אחרי הסגירה).
 *  • החלפה למשימה אחרת רק אחרי אישור מפורש של העובד בהודעה נפרדת (isExplicitConfirmation) — נבדק כאן,
 *    לא ע"י המודל.
 *  • כל המשתמשים אישיים: userKey מגיע תמיד מהמשתמש המזוהה, אין פרמטר "עבור מי".
 */

import { DateTime } from "luxon";
import { env, taskTimerPilotUserKeys } from "../config/env.js";
import { runInTransaction } from "../db/db.js";
import { userCan, type IdentifiedUser } from "../identity/index.js";
import { logger } from "../utils/logger.js";
import { attendanceEnabledForUser, getEffectiveAttendance } from "./attendance.js";
import { computeDaySummary, workDateFor } from "./attendanceEngine.js";
import { isExplicitConfirmation } from "./bulkUpdate.js";
import {
  effectiveMs,
  formatDuration,
  msToMinutes,
  workIntervals,
  workDateForInstant,
  type Interval,
} from "./taskTimerEngine.js";
import {
  clearPendingSwitch,
  endSegment,
  getActiveSegment,
  getLastStoppedSegment,
  getSegmentByEndKey,
  getSegmentByIdempotencyKey,
  getTimerState,
  insertSegment,
  listOpenSegments,
  listSegmentsForDate,
  listSegmentsInRange,
  setLastReminderAt,
  setPendingSwitch,
  type TimerEndReason,
  type TimerSegment,
} from "../db/repositories/taskTimers.js";

export const SWITCH_CONFIRM_TTL_MINUTES = 10;
export const REMINDER_THROTTLE_MINUTES = 10;
const OFFICE_CONTEXT = "משימת משרד";
const LONG_RUNNING_WARN_HOURS = 12;

export interface TimerTaskRef {
  itemId: string;
  itemSource: string;
  taskName: string;
  projectId: string | null;
  projectName: string | null;
}

export interface TimerResult {
  ok: boolean;
  message: string;
  /** true ⇔ ממתין לאישור העובד להחלפה — ההודעה היא השאלה עצמה. */
  needsConfirmation?: boolean;
}

/** שם פרויקט להצגה/שמירה: "משימת משרד" (משימה כללית בלי פרויקט) → null. */
export function projectNameFromContext(context: string | undefined | null): string | null {
  const c = (context ?? "").trim();
  return c && c !== OFFICE_CONTEXT ? c : null;
}

// ── שער ההפעלה ────────────────────────────────────────────────────────────────

/** true ⇔ הדגל פעיל, המשתמש ברשימת הפיילוט, יש לו report:hours, *והנוכחות פעילה עבורו* (אחרת אין זמן אפקטיבי). */
export function isTaskTimerEnabledForUser(user: IdentifiedUser): boolean {
  return env.TASK_TIMER_ENABLED && taskTimerPilotUserKeys.includes(user.key) && userCan(user, "report:hours") && attendanceEnabledForUser(user);
}

// ── עזרים ─────────────────────────────────────────────────────────────────────

const localNow = (now: DateTime) => now.setZone(env.TIMEZONE);
const toIso = (now: DateTime) => now.toUTC().toISO()!;
const hhmm = (iso: string) => DateTime.fromISO(iso).setZone(env.TIMEZONE).toFormat("HH:mm");

function taskLabel(name: string, project: string | null): string {
  return project ? `'${name}' בפרויקט '${project}'` : `'${name}'`;
}

/** מקטעי העבודה של יום נוכחות (מטמון פר-קריאה). */
function makeIntervalsResolver(userKey: string, asOfIso: string): (workDate: string) => Interval[] {
  const cache = new Map<string, Interval[]>();
  return (workDate) => {
    let v = cache.get(workDate);
    if (!v) {
      v = workIntervals(getEffectiveAttendance(userKey, workDate).events, asOfIso);
      cache.set(workDate, v);
    }
    return v;
  };
}

function segmentMinutes(seg: TimerSegment, intervalsFor: (d: string) => Interval[], asOfIso: string): number {
  return msToMinutes(effectiveMs(seg, intervalsFor(seg.workDate), asOfIso));
}

// ── התאמה למצב הנוכחות: טיימר שנשאר פתוח על יום סגור / יום קודם ───────────────

/**
 * מיישרת טיימר פעיל למציאות הנוכחות. נקראת בתחילת כל פעולה, ובסריקה.
 *  • היום שלו נסגר → נסגר בשעת הסגירה המדווחת (לא בשעת העיבוד).
 *  • היום שלו כבר לא היום ולא נסגר (עובד שכח לסגור) → stale באורך אפס, עד שהיום יושלם; סגירה רטרואקטיבית
 *    שתגיע אחר כך תשחזר אותו (alignTimersToDayClose).
 * מחזירה את המקטע שנסגר, או null.
 */
export function reconcileActiveTimer(userKey: string, now: DateTime): TimerSegment | null {
  const active = getActiveSegment(userKey);
  if (!active) return null;
  const att = getEffectiveAttendance(userKey, active.workDate);
  const lastOutAt = computeDaySummary(att.events).lastOutAt;
  if (att.status === "closed" && lastOutAt) {
    const endMs = Math.max(DateTime.fromISO(active.startedAt).toMillis(), DateTime.fromISO(lastOutAt).toMillis());
    endSegment(active.id, DateTime.fromMillis(endMs, { zone: "utc" }).toISO()!, "day_close", null);
    return active;
  }
  if (active.workDate < workDateFor(localNow(now))) {
    endSegment(active.id, active.startedAt, "stale", null);
    return active;
  }
  return null;
}

function attendanceBlockMessage(userKey: string, now: DateTime): string | null {
  const status = getEffectiveAttendance(userKey, workDateFor(localNow(now))).status;
  if (status === "closed") return "אין יום עבודה פתוח — אי אפשר להפעיל טיימר. פתח/י יום נוכחות קודם (או תקן/י את הנוכחות).";
  if (status === "on_break") return "אתה כרגע בהפסקה — אי אפשר להפעיל טיימר. דווח/י שחזרת, ואז אפעיל.";
  return null;
}

// ── פעולות ────────────────────────────────────────────────────────────────────

function startedMessage(t: { taskName: string; projectName: string | null }): string {
  return `מצוין! הפעלתי טיימר למשימה '${t.taskName}'${t.projectName ? ` בפרויקט '${t.projectName}'` : ""}.`;
}

/** התחלת עבודה על משימה. אם כבר פועל טיימר על משימה *אחרת* — לא מחליף; שומר החלפה ממתינה ושואל. */
export function startTimer(user: IdentifiedUser, task: TimerTaskRef, now: DateTime, messageSeed: string): TimerResult {
  const local = localNow(now);
  return runInTransaction((): TimerResult => {
    const key = `${user.key}:timer_start:${messageSeed}:${task.itemId}`;
    const existing = getSegmentByIdempotencyKey(key);
    if (existing) return { ok: true, message: startedMessage(existing) };

    reconcileActiveTimer(user.key, local);
    const blocked = attendanceBlockMessage(user.key, local);
    if (blocked) return { ok: false, message: blocked };

    const active = getActiveSegment(user.key);
    if (active) {
      if (active.itemId === task.itemId) {
        return { ok: true, message: `הטיימר למשימה '${active.taskName}' כבר פועל (מאז ${hhmm(active.startedAt)}).` };
      }
      setPendingSwitch(user.key, {
        itemId: task.itemId,
        itemSource: task.itemSource,
        taskName: task.taskName,
        projectId: task.projectId,
        projectName: task.projectName,
        expiresAt: toIso(local.plus({ minutes: SWITCH_CONFIRM_TTL_MINUTES })),
      });
      return {
        ok: false,
        needsConfirmation: true,
        message: `כרגע פועל טיימר למשימה '${active.taskName}'. האם לעצור אותו ולהתחיל טיימר למשימה החדשה?`,
      };
    }

    clearPendingSwitch(user.key);
    const seg = insertSegment({
      userKey: user.key,
      workDate: workDateFor(local),
      itemId: task.itemId,
      itemSource: task.itemSource,
      taskName: task.taskName,
      projectId: task.projectId,
      projectName: task.projectName,
      startedAt: toIso(local),
      idempotencyKey: key,
    });
    return { ok: true, message: startedMessage(seg) };
  });
}

/**
 * אישור החלפה. הכלי נקרא רק אחרי שהעובד ענה לשאלה; כאן נבדק *בקוד* שההודעה האחרונה שלו היא אישור
 * מפורש, שיש החלפה ממתינה שלא פגה, ושהיום עדיין פתוח. רק אז הקודם נעצר (switched) והחדש מופעל.
 */
export function confirmSwitch(user: IdentifiedUser, latestUserMessage: string, now: DateTime, messageSeed: string): TimerResult {
  const local = localNow(now);
  return runInTransaction((): TimerResult => {
    const startKey = `${user.key}:timer_switch_start:${messageSeed}`;
    const done = getSegmentByIdempotencyKey(startKey);
    if (done) return { ok: true, message: startedMessage(done) };

    const state = getTimerState(user.key);
    if (!state.pending || DateTime.fromISO(state.pending.expiresAt).toMillis() < local.toMillis()) {
      clearPendingSwitch(user.key);
      return { ok: false, message: "אין החלפת טיימר שממתינה לאישור (או שהבקשה פגה). אמור/י לאיזו משימה להפעיל טיימר." };
    }
    if (!isExplicitConfirmation(latestUserMessage)) {
      return { ok: false, message: "לא התקבל אישור מפורש מהעובד. אל תחליף — שאל שוב אם לעצור את הטיימר הקיים ולהתחיל את החדש." };
    }

    reconcileActiveTimer(user.key, local);
    const blocked = attendanceBlockMessage(user.key, local);
    if (blocked) return { ok: false, message: blocked };

    const nowIso = toIso(local);
    let prefix = "";
    const active = getActiveSegment(user.key);
    if (active) {
      endSegment(active.id, nowIso, "switched", `${user.key}:timer_switch:${messageSeed}`);
      const stopped = getSegmentByEndKey(`${user.key}:timer_switch:${messageSeed}`)!;
      const mins = segmentMinutes(stopped, makeIntervalsResolver(user.key, nowIso), nowIso);
      prefix = `עצרתי את הטיימר של '${active.taskName}' (${formatDuration(mins)}). `;
    }
    const p = state.pending;
    clearPendingSwitch(user.key);
    const seg = insertSegment({
      userKey: user.key,
      workDate: workDateFor(local),
      itemId: p.itemId,
      itemSource: p.itemSource,
      taskName: p.taskName,
      projectId: p.projectId,
      projectName: p.projectName,
      startedAt: nowIso,
      idempotencyKey: startKey,
    });
    return { ok: true, message: `${prefix}${startedMessage(seg)}` };
  });
}

function stoppedMessage(seg: TimerSegment, userKey: string, asOfIso: string): string {
  const intervalsFor = makeIntervalsResolver(userKey, asOfIso);
  const segMins = segmentMinutes(seg, intervalsFor, asOfIso);
  const todayTotal = listSegmentsForDate(userKey, seg.workDate)
    .filter((s) => s.itemId === seg.itemId)
    .reduce((sum, s) => sum + effectiveMs(s, intervalsFor(s.workDate), asOfIso), 0);
  return `עצרתי את הטיימר למשימה '${seg.taskName}'. המקטע האחרון: ${formatDuration(segMins)}; סה"כ היום במשימה: ${formatDuration(msToMinutes(todayTotal))}.`;
}

/** עצירת הטיימר הפעיל (עצור / סיימתי את המשימה). idempotent לפי messageSeed. */
export function stopTimer(user: IdentifiedUser, now: DateTime, reason: "stopped" | "done", messageSeed: string): TimerResult {
  const local = localNow(now);
  return runInTransaction((): TimerResult => {
    const endKey = `${user.key}:timer_stop:${messageSeed}`;
    const already = getSegmentByEndKey(endKey);
    if (already) return { ok: true, message: stoppedMessage(already, user.key, toIso(local)) };

    reconcileActiveTimer(user.key, local);
    clearPendingSwitch(user.key);
    const active = getActiveSegment(user.key);
    if (!active) return { ok: false, message: "אין כרגע טיימר פעיל." };
    const nowIso = toIso(local);
    endSegment(active.id, nowIso, reason, endKey);
    return { ok: true, message: stoppedMessage(getSegmentByEndKey(endKey)!, user.key, nowIso) };
  });
}

/**
 * hook ל"סיימתי את המשימה": אם פועל טיימר על אותו פריט — נעצר (done). best-effort, קורא ל-DB בלבד;
 * נקרא מ-updateTask אחרי שהכתיבה ל-Monday הצליחה, ולכן לעולם לא מכשיל אותה.
 */
export function stopTimerIfOnItem(userKey: string, itemId: string, now: DateTime): TimerSegment | null {
  const local = localNow(now);
  return runInTransaction(() => {
    reconcileActiveTimer(userKey, local);
    const active = getActiveSegment(userKey);
    if (!active || active.itemId !== itemId) return null;
    endSegment(active.id, toIso(local), "done", `done:${active.id}`);
    return active;
  });
}

/** חזרה למשימה האחרונה שנעצרה היום (stopped/switched). אם פועל כבר טיימר — כמו start (שאלת החלפה). */
export function resumeTimer(user: IdentifiedUser, now: DateTime, messageSeed: string): TimerResult {
  const local = localNow(now);
  reconcileActiveTimer(user.key, local);
  const active = getActiveSegment(user.key);
  if (active) return { ok: true, message: `הטיימר למשימה '${active.taskName}' כבר פועל (מאז ${hhmm(active.startedAt)}).` };
  const last = getLastStoppedSegment(user.key, workDateFor(local));
  if (!last) return { ok: false, message: "אין משימה שנעצרה היום וניתן להמשיך אותה. אמור/י על איזו משימה להפעיל טיימר." };
  return startTimer(user, last, local, messageSeed);
}

// ── דוחות (קריאה בלבד, DB בלבד) ───────────────────────────────────────────────

export function getTimerStatus(user: IdentifiedUser, now: DateTime): TimerResult {
  const local = localNow(now);
  reconcileActiveTimer(user.key, local);
  const active = getActiveSegment(user.key);
  if (!active) {
    const last = getLastStoppedSegment(user.key, workDateFor(local));
    return {
      ok: true,
      message: last ? `אין כרגע טיימר פעיל. המשימה האחרונה שעבדת עליה היום: '${last.taskName}'.` : "אין כרגע טיימר פעיל.",
    };
  }
  const nowIso = toIso(local);
  const att = getEffectiveAttendance(user.key, workDateFor(local));
  const intervalsFor = makeIntervalsResolver(user.key, nowIso);
  const todayOnTask = listSegmentsForDate(user.key, active.workDate)
    .filter((s) => s.itemId === active.itemId)
    .reduce((sum, s) => sum + effectiveMs(s, intervalsFor(s.workDate), nowIso), 0);
  const where = taskLabel(active.taskName, active.projectName);
  const pause = att.status === "on_break" ? " (כרגע בהפסקה — הספירה מושהית ותמשיך כשתחזור)" : "";
  return {
    ok: true,
    message: `אתה עובד כרגע על ${where}, מאז ${hhmm(active.startedAt)}${pause}. סה"כ היום במשימה: ${formatDuration(msToMinutes(todayOnTask))}.`,
  };
}

export type ReportScope = "today" | "project" | "task";
export type ReportRange = "today" | "week" | "month" | "all";

function rangeBounds(range: ReportRange, local: DateTime): { from: string; to: string; label: string } {
  const to = workDateFor(local);
  switch (range) {
    case "today":
      return { from: to, to, label: "היום" };
    case "week": {
      // שבוע עבודה ישראלי מתחיל ביום א׳. luxon: שני=1 … ראשון=7, לכן weekday % 7 = כמה ימים אחורה עד ראשון.
      const sunday = local.minus({ days: local.weekday % 7 }).startOf("day");
      return { from: workDateFor(sunday), to, label: "השבוע (מיום א׳)" };
    }
    case "month":
      return { from: workDateFor(local.startOf("month")), to, label: "החודש" };
    default:
      return { from: "2000-01-01", to, label: "בסך הכול" };
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[\s'"׳״.,\-–—_()]+/g, " ").trim();

function nameMatches(candidate: string | null, query: string): boolean {
  if (!candidate) return false;
  const a = norm(candidate);
  const q = norm(query);
  return q.length >= 2 && (a.includes(q) || q.includes(a));
}

interface GroupRow {
  key: string;
  title: string;
  ms: number;
}

/** "כמה עבדתי": היום (כל המשימות), או פרויקט/משימה מסוימים בטווח. תשובה מוכנה בעברית — המודל לא מחשב. */
export function getTimeReport(
  user: IdentifiedUser,
  now: DateTime,
  scope: ReportScope,
  query: string | undefined,
  range: ReportRange | undefined,
): TimerResult {
  const local = localNow(now);
  reconcileActiveTimer(user.key, local);
  const nowIso = toIso(local);
  const effRange: ReportRange = scope === "today" ? "today" : (range ?? "all");
  const { from, to, label } = rangeBounds(effRange, local);
  const intervalsFor = makeIntervalsResolver(user.key, nowIso);
  let segs = listSegmentsInRange(user.key, from, to);

  if (scope !== "today") {
    const q = (query ?? "").trim();
    if (q.length < 2) return { ok: false, message: scope === "project" ? "על איזה פרויקט לבדוק?" : "על איזו משימה לבדוק?" };
    segs = segs.filter((s) =>
      scope === "project" ? nameMatches(s.projectName, q) : s.itemId === q || nameMatches(s.taskName, q),
    );
  }

  const active = getActiveSegment(user.key);
  const byTask = new Map<string, GroupRow>();
  let totalMs = 0;
  for (const s of segs) {
    const ms = effectiveMs(s, intervalsFor(s.workDate), nowIso);
    totalMs += ms;
    const g = byTask.get(s.itemId) ?? { key: s.itemId, title: `${s.taskName}${s.projectName ? ` (${s.projectName})` : ""}`, ms: 0 };
    g.ms += ms;
    byTask.set(s.itemId, g);
  }

  if (segs.length === 0) {
    const what = scope === "today" ? "עדיין לא נמדד זמן על משימות היום" : `לא נמדד זמן עבודה על '${query}' ${label}`;
    return { ok: true, message: `${what}.` };
  }

  const lines = [...byTask.values()]
    .sort((a, b) => b.ms - a.ms)
    .map((g) => `• ${g.title} — ${formatDuration(msToMinutes(g.ms))}`);
  const head =
    scope === "today"
      ? `זמן העבודה שנמדד היום על משימות: ${formatDuration(msToMinutes(totalMs))} (נטו, בלי הפסקות).`
      : scope === "project"
        ? `זמן העבודה על פרויקט '${query}' ${label}: ${formatDuration(msToMinutes(totalMs))} (נטו, בלי הפסקות).`
        : `זמן העבודה על '${query}' ${label}: ${formatDuration(msToMinutes(totalMs))} (נטו, בלי הפסקות).`;
  const tail =
    active && segs.some((s) => s.id === active.id) ? `\nהטיימר למשימה '${active.taskName}' עדיין פועל — הזמן עד עכשיו כלול.` : "";
  return { ok: true, message: `${head}\n${lines.join("\n")}${tail}` };
}

// ── תזכורת + הקשר לפרומפט ─────────────────────────────────────────────────────

/**
 * "שים לב, עדיין פועל טיימר…" — לכל היותר פעם ב-REMINDER_THROTTLE_MINUTES, ורק כשיש טיימר פעיל.
 * הטקסט נוסף בקוד לסוף התשובה (לא ניסוח של המודל). קוראים רק אחרי שנשלפו משימות/נשאלה שאלה על משימה
 * אחרת ושום כלי טיימר לא רץ באותה הודעה. לא עוצרת ולא מפעילה כלום.
 */
export function takeActiveTimerReminder(user: IdentifiedUser, now: DateTime): string | null {
  const local = localNow(now);
  reconcileActiveTimer(user.key, local);
  const active = getActiveSegment(user.key);
  if (!active) return null;
  const last = getTimerState(user.key).lastReminderAt;
  if (last && local.toMillis() - DateTime.fromISO(last).toMillis() < REMINDER_THROTTLE_MINUTES * 60_000) return null;
  setLastReminderAt(user.key, toIso(local));
  return `שים לב, עדיין פועל טיימר למשימה '${active.taskName}'. האם לעצור אותו?`;
}

/** שורה לחלק המשתנה של הפרומפט — רק כשיש טיימר פעיל (בלי טיימר: null, הפרומפט זהה לקודם). */
export function activeTimerContextLine(userKey: string, now: DateTime): string | null {
  const local = localNow(now);
  const active = getActiveSegment(userKey);
  if (!active) return null;
  const onBreak = getEffectiveAttendance(userKey, workDateFor(local)).status === "on_break";
  return (
    `[טיימר פעיל] ${taskLabel(active.taskName, active.projectName)}, מאז ${hhmm(active.startedAt)}${onBreak ? " (העובד בהפסקה)" : ""}. ` +
    `שאלה/צפייה במשימות אחרות אינה התחלת עבודה ואינה עוצרת את הטיימר. להחלפה — timer_start בלבד ורק אחרי אישור מפורש.`
  );
}

// ── תחזוקה ────────────────────────────────────────────────────────────────────

/**
 * סריקה תקופתית: סוגרת מקטעים פתוחים על ימים סגורים/ישנים (למקרה ש-hook הסגירה לא רץ), ומתריעה ביומן
 * על טיימר שרץ זמן חריג. לא משנה שום חישוב שעות — הוא נגזר מהנוכחות.
 */
export function sweepTaskTimers(now: DateTime): { reconciled: number; longRunning: number } {
  let reconciled = 0;
  let longRunning = 0;
  for (const seg of listOpenSegments()) {
    try {
      if (reconcileActiveTimer(seg.userKey, now)) {
        reconciled++;
        continue;
      }
      const hours = (now.toMillis() - DateTime.fromISO(seg.startedAt).toMillis()) / 3_600_000;
      if (hours > LONG_RUNNING_WARN_HOURS) {
        longRunning++;
        logger.warn({ userKey: seg.userKey, segmentId: seg.id, hours: Math.round(hours) }, "טיימר משימה פעיל זמן חריג");
      }
    } catch (err) {
      logger.error({ err, userKey: seg.userKey, segmentId: seg.id }, "sweep של טיימר משימה נכשל — ינוסה שוב בסבב הבא");
    }
  }
  return { reconciled, longRunning };
}

export type { TimerEndReason };
export { workDateForInstant };
