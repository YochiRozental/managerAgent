/**
 * Follow-up Engine (2026-09-14, מתוקן 2026-09-15) — תשתית "אני צריך לחזור לבדוק את זה בתאריך/שעה
 * מסוימים", מחוברת כרגע רק ל-commitment_check (דחיות/התחייבויות שכבר קיימות). Monday נשאר מקור
 * האמת למשימות; control_followups הוא רק זיכרון-מעקב.
 *
 * dueAt מחושב **בתוך** יום ההתחייבות עצמו, בשעה סבירה ביחס לשעות העבודה בפועל (לא 09:00 — מוקדם
 * מדי; ר' FOLLOWUP_CONFIG) — לא אחרי שהתאריך עבר. **תמיד נשמר ומושווה ב-UTC** (ר' הערת timezone
 * למטה) — לא שעון מקומי, כדי שלא יהיה תלוי בקיץ/חורף.
 *
 * runDueFollowups עדיין **לא מחובר לשום scheduler** — callable + נבדק, מחכה להחלטה על תדירות.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import {
  claimFollowupForProcessing,
  completeActiveFollowupsForItem,
  completeFollowup,
  createFollowup,
  createOrReplaceFollowupForKind,
  listDueFollowups,
  markFollowupTriggered,
  revertFollowupToPending,
  type FollowupKind,
  type StoredFollowup,
} from "../db/repositories/controlFollowups.js";
import { addNotification, markNudgesSeenForFinding } from "../db/repositories/notifications.js";
import { lastResponseAt, recordFindingEvent } from "../db/repositories/findingEvents.js";
import { resolveUserByKey } from "../identity/index.js";
import { getTaskStatusLabel, isDoneStatusLabel, isParkedStatusLabel } from "../integrations/monday/opsWrite.js";
import type { OpsTaskSource } from "../integrations/monday/opsRead.js";
import { publishNudge } from "./nudgeBus.js";
import { logger } from "../utils/logger.js";

/** ספים גנריים, קל לכוונן (כמו POLICY_CONFIG) — לא hard-coded בתוך הלוגיקה. */
export const FOLLOWUP_CONFIG = {
  commitmentCheck: {
    /** מתי בפועל לבדוק ביום ההתחייבות — לא 09:00 (מוקדם מדי, הצוות נכנס 09:30–10:30). */
    hour: 10,
    minute: 30,
  },
  endOfDay: {
    hour: 17,
    minute: 0,
  },
  /** Rule 18 (EOD Engine 2026-09-16): כמה שעות לחכות אחרי nudge שדורש תשובה לפני תזכורת יחידה. */
  noResponseReminderHours: 3,
} as const;

/**
 * timezone (Audit 2026-09-15): "10:30 ביום ההתחייבות" מחושב תמיד לפי env.TIMEZONE (Asia/Jerusalem)
 * — luxon פותר את ה-offset הנכון (+02:00/+03:00) לפי התאריך עצמו, לא לפי "עכשיו", אז קיץ/חורף
 * מטופל נכון גם לתאריך עתידי. ה-**אחסון** ממיר תמיד ל-UTC (.toUTC()) לפני toISO(): מחרוזת עם "Z"
 * קבוע, בלי offset משתנה — כך שהשוואת מחרוזות ב-SQLite (WHERE due_at <= ?) תמיד נכונה כרונולוגית,
 * גם כשההרצה חוצה מעבר קיץ/חורף בין יצירת ה-follow-up לבדיקתו. runDueFollowups עושה אותו דבר
 * ל-now לפני ההשוואה — שני הצדדים תמיד UTC.
 */
function toStoredUtcIso(local: DateTime): string {
  return local.toUTC().toISO()!;
}

/** תאריך ההתחייבות (YYYY-MM-DD) → מתי בפועל לבדוק, ב-UTC, מחושב מהשעה המקומית של המשרד. */
export function commitmentCheckDueAt(commitmentDateISO: string): string {
  return toStoredUtcIso(
    DateTime.fromISO(commitmentDateISO, { zone: env.TIMEZONE }).set({
      hour: FOLLOWUP_CONFIG.commitmentCheck.hour,
      minute: FOLLOWUP_CONFIG.commitmentCheck.minute,
      second: 0,
      millisecond: 0,
    }),
  );
}

export interface ScheduleCommitmentCheckInput {
  itemId: string;
  itemSource: OpsTaskSource;
  findingKey?: string;
  userKey: string;
  /** YYYY-MM-DD — התאריך שהעובד/מוטי התחייבו אליו (התאריך החדש שנקבע ב-Monday). */
  commitmentDateISO: string;
  taskName?: string;
}

/**
 * נקראת מ-replyDefer (executed) ומ-approveApproval (deferral executor) — שני המקומות היחידים
 * שבאמת קובעים תאריך התחייבות חדש ב-Monday. idempotency: הזהות היא item_id+item_source+kind
 * בלבד (**לא** finding_key — יכול להשתנות, ר' controlFollowups.ts) — מבטלת/משלימה כל
 * commitment_check פעיל קודם (pending *או* triggered) לפני שיוצרת את החדש.
 */
export function scheduleCommitmentCheck(input: ScheduleCommitmentCheckInput): StoredFollowup {
  return createOrReplaceFollowupForKind("commitment_check", {
    findingKey: input.findingKey,
    itemId: input.itemId,
    itemSource: input.itemSource,
    userKey: input.userKey,
    kind: "commitment_check",
    dueAtISO: commitmentCheckDueAt(input.commitmentDateISO),
    payload: { commitmentDateISO: input.commitmentDateISO, taskName: input.taskName },
  });
}

export interface ScheduleEndOfDayCheckInput {
  itemId: string;
  itemSource: OpsTaskSource;
  findingKey?: string;
  userKey: string;
  taskName?: string;
  /**
   * תאריך היעד הנוכחי (האמיתי) של המשימה ב-Monday, כפי שידוע מרגע ההתחייבות — **לא** משתנה כאן
   * (replyFinishingToday לא נוגע בתאריך). מועבר הלאה ל-payload כדי שאם ב-17:00 המשימה עדיין פתוחה
   * ותידרש דחייה, ל-Policy Engine (replyDefer) יהיה את התאריך האמיתי — לא null, לא ניחוש (EOD
   * Engine 2026-09-16, "חיבור מידע שכבר קיים" ולא שינוי Policy Engine).
   */
  currentDueDateISO?: string | null;
}

/**
 * "אני עובד על זה ואסיים היום" (loopReply.replyFinishingToday) — **לא** משנה תאריך יעד, **לא**
 * דחייה. משלימה כל follow-up פעיל קיים על הפריט (התשובה כבר ניתנה) ופותחת end_of_day_check אחד
 * ליום הנוכחי.
 */
export function scheduleEndOfDayCheck(input: ScheduleEndOfDayCheckInput, now: DateTime): StoredFollowup {
  // כבר משלים ללא-תלות-ב-kind (כל follow-up פעיל על הפריט) — retire-by-kind נוסף מיותר כאן.
  completeActiveFollowupsForItem(input.itemId, input.itemSource);
  const dueAtISO = toStoredUtcIso(
    now.setZone(env.TIMEZONE).set({ hour: FOLLOWUP_CONFIG.endOfDay.hour, minute: FOLLOWUP_CONFIG.endOfDay.minute, second: 0, millisecond: 0 }),
  );
  return createFollowup({
    findingKey: input.findingKey,
    itemId: input.itemId,
    itemSource: input.itemSource,
    userKey: input.userKey,
    kind: "end_of_day_check",
    dueAtISO,
    payload: { commitment: "finishing_today", taskName: input.taskName, currentDueDateISO: input.currentDueDateISO ?? null },
  });
}

/** נקראת מ-replyDone (ומכל תשובה שממצה את מחזור הפנייה) — אין יותר סיבה למעקב פתוח על הפריט. */
export function completeFollowupsForItem(itemId: string, itemSource: string): number {
  return completeActiveFollowupsForItem(itemId, itemSource);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 18 (EOD Engine 2026-09-16): "לא ענה לפניית בקרה עד סוף היום".
//
//   nudge (commitment_check / end_of_day_check) נשלח → no_response_reminder בעוד
//   noResponseReminderHours (ברירת מחדל 3) → אם עדיין אין תשובה → end_of_day_no_response ב-17:00
//   → אם עדיין אין תשובה → התראה ניהולית (לא Approval) למוטי, ה-follow-up מסומן completed.
//
//   אם 3 השעות היו דוחפות את התזכורת אחרי EOD — מדלגים על שלב התזכורת וקובעים ישר
//   end_of_day_no_response ל-17:00 (אין תזכורת בלילה).
//
//   ברגע שהעובד עונה תשובה תקפה כלשהי (כל reply_* קורא ל-completeFollowupsForItem, שמשלים כל
//   follow-up פעיל על הפריט ללא תלות ב-kind) — no_response_reminder/end_of_day_no_response
//   שעדיין pending מושלמים אוטומטית, לפני שהם בכלל מגיעים לריצה הבאה. זו ההגנה המבנית העיקרית
//   נגד "הסלמה אחרי שכבר ענו" (נדרשת גם restart-safe — היא persistent ב-DB, לא זיכרון).
// ─────────────────────────────────────────────────────────────────────────────

/** מזהה את "התאריך האמיתי" לשאת הלאה מ-payload של follow-up קיים, בלי תלות ב-kind שלו. */
function extractCurrentDueDateISO(f: Pick<StoredFollowup, "payload">): string | null {
  const p = (f.payload ?? {}) as { commitmentDateISO?: string; currentDueDateISO?: string | null };
  return p.commitmentDateISO ?? p.currentDueDateISO ?? null;
}

/**
 * מזהה אם ה-follow-up המקורי כבר נשא missedCommitment=true (מ-end_of_day_check שהמשימה עדיין
 * הייתה פתוחה בו) — כדי שהדגל ישרוד גם אם התשובה מגיעה רק אחרי no_response_reminder, לא רק
 * בתשובה הישירה ל-nudge המקורי (Audit 2026-09-16, "ה-context צריך להגיע בצורה אמינה").
 */
function extractMissedCommitment(f: Pick<StoredFollowup, "payload">): boolean {
  return !!(f.payload as { missedCommitment?: boolean } | null)?.missedCommitment;
}

interface ScheduleNoResponseInput {
  itemId: string;
  itemSource: OpsTaskSource;
  findingKey?: string;
  userKey: string;
  taskName?: string;
  currentDueDateISO?: string | null;
  missedCommitment?: boolean;
}

/**
 * קרוי מיד אחרי ששליחת nudge (commitment_check / end_of_day_check) הצליחה בפועל. מחליט אם יש
 * מספיק זמן היום ל-reminder אחד לפני EOD, או שצריך לקפוץ ישר ל-end_of_day_no_response.
 */
function scheduleNoResponseFollowup(input: ScheduleNoResponseInput, nudgeSentAt: DateTime): StoredFollowup {
  const local = nudgeSentAt.setZone(env.TIMEZONE);
  const reminderAt = local.plus({ hours: FOLLOWUP_CONFIG.noResponseReminderHours });
  const todayEod = local.set({ hour: FOLLOWUP_CONFIG.endOfDay.hour, minute: FOLLOWUP_CONFIG.endOfDay.minute, second: 0, millisecond: 0 });
  const payloadBase = {
    taskName: input.taskName,
    currentDueDateISO: input.currentDueDateISO ?? null,
    nudgeSentAtISO: toStoredUtcIso(local),
    missedCommitment: !!input.missedCommitment,
  };

  if (reminderAt > todayEod) {
    // אין מספיק שעות עבודה נותרות ל-reminder לפני שהיום נגמר — ישר להסלמת סוף-יום, בלי תזכורת בלילה.
    return createOrReplaceFollowupForKind("end_of_day_no_response", {
      findingKey: input.findingKey,
      itemId: input.itemId,
      itemSource: input.itemSource,
      userKey: input.userKey,
      kind: "end_of_day_no_response",
      dueAtISO: toStoredUtcIso(todayEod),
      payload: { ...payloadBase, reminderSentAtISO: null },
    });
  }

  return createOrReplaceFollowupForKind("no_response_reminder", {
    findingKey: input.findingKey,
    itemId: input.itemId,
    itemSource: input.itemSource,
    userKey: input.userKey,
    kind: "no_response_reminder",
    dueAtISO: toStoredUtcIso(reminderAt),
    payload: payloadBase,
  });
}

/** best-effort: אף פעם לא הופך כשל-תזמון-safety-net לכשל של שליחת ה-nudge עצמו (שכבר הצליח). */
function scheduleNoResponseSafetyNetBestEffort(f: StoredFollowup, now: DateTime): void {
  if (!f.itemId || !f.itemSource) return;
  const payload = (f.payload ?? {}) as { taskName?: string };
  try {
    scheduleNoResponseFollowup(
      {
        itemId: f.itemId,
        itemSource: f.itemSource as OpsTaskSource,
        findingKey: f.findingKey ?? undefined,
        userKey: f.userKey,
        taskName: payload.taskName,
        currentDueDateISO: extractCurrentDueDateISO(f),
        missedCommitment: extractMissedCommitment(f),
      },
      now,
    );
  } catch (err) {
    logger.error({ followupId: f.id, err }, "תזמון no-response safety-net נכשל — ה-nudge עצמו נשלח בהצלחה");
  }
}

/** האם יש תגובה (finding_events) לאחר nudgeSentAtUtcIso — לא רק שעון, state אמיתי מה-DB. */
function hasRespondedSince(findingKey: string, nudgeSentAtUtcIso: string): boolean {
  const last = lastResponseAt(findingKey);
  if (!last) return false;
  const lastDt = DateTime.fromSQL(last, { zone: "utc" });
  const sinceDt = DateTime.fromISO(nudgeSentAtUtcIso, { zone: "utc" });
  return lastDt.isValid && sinceDt.isValid && lastDt >= sinceDt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

export interface FollowupRunnerDeps {
  getTaskStatusLabel?: typeof getTaskStatusLabel;
  addNotification?: typeof addNotification;
  publishNudge?: typeof publishNudge;
}

export interface FollowupRunResult {
  checked: number;
  processed: { id: number; kind: FollowupKind; outcome: string }[];
}

const HANDLED_KINDS: ReadonlySet<FollowupKind> = new Set([
  "commitment_check",
  "end_of_day_check",
  "no_response_reminder",
  "end_of_day_no_response",
] satisfies FollowupKind[]);

/**
 * שולפת follow-ups שהגיע זמנם (pending, due_at<=now ב-UTC) ומטפלת בהם לפי kind — kind שלא ב-
 * HANDLED_KINDS (כרגע: external_wait_check, manager_followup) נשאר pending בלי להיגע.
 * claimFollowupForProcessing הוא ה-CAS שמונע הפעלה כפולה (pending→processing, סינכרוני).
 *
 * Audit 2026-09-15: אם השליחה בפועל (בדיקת סטטוס ב-Monday / addNotification / publishNudge)
 * נכשלת — **לא** נשאר "processing" לצמיתות: חוזר ל-pending עם last_error, וההרצה הבאה תנסה שוב.
 * 'triggered' מסומן רק אחרי הצלחה אמיתית. קריסה תוך כדי processing עצמו משוחזרת ב-startup
 * (recoverStuckFollowups), לא כאן.
 */
export async function runDueFollowups(now: DateTime, deps: FollowupRunnerDeps = {}): Promise<FollowupRunResult> {
  const resolvedDeps: Required<FollowupRunnerDeps> = {
    getTaskStatusLabel: deps.getTaskStatusLabel ?? getTaskStatusLabel,
    addNotification: deps.addNotification ?? addNotification,
    publishNudge: deps.publishNudge ?? publishNudge,
  };

  const due = listDueFollowups(now.toUTC().toISO()!);
  const processed: FollowupRunResult["processed"] = [];

  for (const f of due) {
    if (!HANDLED_KINDS.has(f.kind)) continue; // עדיין לא ממומש — לא תופסים, לא נוגעים

    if (!claimFollowupForProcessing(f.id)) continue; // runner אחר כבר תפס — לא שולחים כפול

    try {
      const outcome = await processFollowupByKind(f, now, resolvedDeps);
      processed.push({ id: f.id, kind: f.kind, outcome });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      revertFollowupToPending(f.id, msg);
      logger.error(
        { followupId: f.id, itemId: f.itemId, kind: f.kind, error: msg },
        `${f.kind}: הבדיקה/השליחה נכשלה — חוזר ל-pending, ינוסה שוב בהרצה הבאה`,
      );
      processed.push({ id: f.id, kind: f.kind, outcome: "reverted_pending_error" });
    }
  }
  return { checked: due.length, processed };
}

function processFollowupByKind(f: StoredFollowup, now: DateTime, deps: Required<FollowupRunnerDeps>): Promise<string> {
  switch (f.kind) {
    case "commitment_check":
      return processCommitmentCheck(f, now, deps);
    case "end_of_day_check":
      return processEndOfDayCheck(f, now, deps);
    case "no_response_reminder":
      return processNoResponseReminder(f, now, deps);
    case "end_of_day_no_response":
      return processEndOfDayNoResponse(f, now, deps);
    default: {
      // לא אמור לקרות — HANDLED_KINDS כבר סינן. הגנה בלבד, לא מפיל את הסבב.
      completeFollowup(f.id);
      return Promise.resolve("completed_unhandled_kind");
    }
  }
}

async function processCommitmentCheck(
  f: StoredFollowup,
  now: DateTime,
  deps: Required<FollowupRunnerDeps>,
): Promise<string> {
  if (!f.itemId || !f.itemSource) {
    completeFollowup(f.id);
    return "completed_missing_item";
  }

  // "לפני שפונים לעובד — בדוק את מצב המשימה העדכני ב-Monday" — לא סומכים על מצב ישן שלנו.
  // אם זה זורק (Monday למטה וכו') — נתפס ב-runDueFollowups, חוזר ל-pending, לא "נבלע".
  const label = await deps.getTaskStatusLabel(f.itemSource as OpsTaskSource, f.itemId);

  if (isDoneStatusLabel(f.itemSource as OpsTaskSource, label)) {
    completeFollowup(f.id);
    return "completed_done";
  }
  if (isParkedStatusLabel(f.itemSource as OpsTaskSource, label)) {
    // "מושהה"/"לא רלוונטי" — לא הושלם, אבל גם אין טעם לשאול "איפה זה עומד" על משהו שהוקפא.
    // לא מניחים שההתחייבות קוימה (לא completed) — חוזר ל-pending כדי שסבב עתידי יבדוק שוב אם
    // המצב השתנה (המשימה חזרה לפעילות, או נסגרה בפועל). ראה audit — סמנטיקה מדויקת יותר = שלב הבא.
    revertFollowupToPending(f.id, `המשימה במצב "${label}" בזמן הבדיקה — לא נשלחה פנייה, לא סומן כהושלם`);
    return "skipped_parked";
  }

  const payload = (f.payload ?? {}) as { taskName?: string; commitmentDateISO?: string };
  const body = `התחייבת לסיים היום את המשימה "${payload.taskName ?? f.itemId}". איפה זה עומד?`;

  // דרך מנגנון ה-nudge הקיים — לא finding חדש: אותו findingKey שכבר קיים על ה-follow-up.
  // אם אחת הקריאות האלה זורקת — נתפס למעלה, חוזר ל-pending, 'triggered' לא מסומן.
  deps.addNotification(f.userKey, "nudge", body, f.findingKey ?? undefined, {
    itemId: f.itemId,
    itemSource: f.itemSource,
    // currentDueDateISO (Audit 2026-09-16): בלעדיו תשובת-דחייה על ה-nudge הזה הייתה מגיעה ל-
    // Policy Engine עם currentDueDateISO=null → wasOverdue תמיד false, גם כשבאמת פספסו התחייבות.
    context: { taskName: payload.taskName, followupId: f.id, followupKind: "commitment_check", currentDueDateISO: payload.commitmentDateISO ?? null },
  });
  if (f.findingKey) {
    deps.publishNudge({
      userKey: f.userKey,
      findingKey: f.findingKey,
      itemId: f.itemId,
      itemSource: f.itemSource,
      body,
      taskName: payload.taskName ?? null,
      project: null,
      currentDueDateISO: payload.commitmentDateISO ?? null,
      createdAt: now.toISO()!,
    });
  }

  // רק עכשיו, אחרי ששני השלבים הצליחו בפועל — מסמנים triggered.
  markFollowupTriggered(f.id);
  scheduleNoResponseSafetyNetBestEffort(f, now);
  return "nudge_sent";
}

/**
 * ה-nudge של "אסיים היום" (scenario A) — מגיע ב-17:00 (EOD). בודק קודם את המצב האמיתי ב-Monday:
 * בוצע → סוגר בשקט, לא מטריד את העובד ולא את מוטי; פתוח → שולח בדיוק את הנוסח שהתבקש ומצפה לתשובה.
 */
async function processEndOfDayCheck(f: StoredFollowup, now: DateTime, deps: Required<FollowupRunnerDeps>): Promise<string> {
  if (!f.itemId || !f.itemSource) {
    completeFollowup(f.id);
    return "completed_missing_item";
  }

  const label = await deps.getTaskStatusLabel(f.itemSource as OpsTaskSource, f.itemId);

  if (isDoneStatusLabel(f.itemSource as OpsTaskSource, label)) {
    completeFollowup(f.id);
    // "סגור/נקה את finding בהתאם למנגנון הקיים" — אותו vocabulary כמו תשובת עובד "סיימתי"
    // (resolved_by_reply), גם כשההשלמה זוהתה אוטומטית מול Monday ולא דרך תשובה מפורשת.
    if (f.findingKey) {
      try {
        recordFindingEvent(f.findingKey, "resolved_by_reply", { action: "eod_check_confirmed_done" });
        markNudgesSeenForFinding(f.userKey, f.findingKey);
      } catch (err) {
        logger.error({ followupId: f.id, err }, "סגירת finding אחרי EOD-done נכשלה — ה-follow-up עצמו כבר הושלם");
      }
    }
    return "completed_done";
  }
  if (isParkedStatusLabel(f.itemSource as OpsTaskSource, label)) {
    revertFollowupToPending(f.id, `המשימה במצב "${label}" בזמן בדיקת EOD — לא נשלחה פנייה, לא סומן כהושלם`);
    return "skipped_parked";
  }

  const payload = (f.payload ?? {}) as { taskName?: string; currentDueDateISO?: string | null };
  const taskName = payload.taskName ?? f.itemId;
  const body = `התחייבת לסיים היום את המשימה "${taskName}", והיא עדיין פתוחה. האם סיימת, או שצריך לדחות?`;

  deps.addNotification(f.userKey, "nudge", body, f.findingKey ?? undefined, {
    itemId: f.itemId,
    itemSource: f.itemSource,
    // missedCommitment=true (Rule 4, 2026-09-16): ה-3 תנאים כבר מתקיימים כאן במפורש — היה
    // end_of_day_check, המשימה עדיין פתוחה, והעובד מתבקש עכשיו לעדכן. context אמין, לא טקסט חופשי —
    // אם התשובה תהיה בקשת דחייה, replyDefer יעביר את זה ל-Policy Engine (policy.ts, Rule 4).
    context: { taskName, followupId: f.id, followupKind: "end_of_day_check", currentDueDateISO: payload.currentDueDateISO ?? null, missedCommitment: true },
  });
  if (f.findingKey) {
    deps.publishNudge({
      userKey: f.userKey,
      findingKey: f.findingKey,
      itemId: f.itemId,
      itemSource: f.itemSource,
      body,
      taskName,
      project: null,
      currentDueDateISO: payload.currentDueDateISO ?? null,
      createdAt: now.toISO()!,
    });
  }

  markFollowupTriggered(f.id);
  scheduleNoResponseSafetyNetBestEffort(f, now);
  return "nudge_sent";
}

/** Rule 18, שלב 1: תזכורת יחידה — רק אם עדיין באמת אין תשובה (state מ-DB, לא רק שעון). */
async function processNoResponseReminder(f: StoredFollowup, now: DateTime, deps: Required<FollowupRunnerDeps>): Promise<string> {
  if (!f.itemId || !f.itemSource || !f.findingKey) {
    completeFollowup(f.id);
    return "completed_missing_item";
  }

  const payload = (f.payload ?? {}) as {
    taskName?: string;
    currentDueDateISO?: string | null;
    nudgeSentAtISO?: string;
    missedCommitment?: boolean;
  };
  if (payload.nudgeSentAtISO && hasRespondedSince(f.findingKey, payload.nudgeSentAtISO)) {
    // העובד כבר ענה על ה-nudge המקורי בינתיים — אין מה להזכיר, ואין להסלים (Audit דרישה #8).
    completeFollowup(f.id);
    return "completed_already_responded";
  }

  const taskName = payload.taskName ?? f.itemId;
  const body = `תזכורת לגבי המשימה "${taskName}" — עדיין לא קיבלתי ממך עדכון.`;

  deps.addNotification(f.userKey, "nudge", body, f.findingKey, {
    itemId: f.itemId,
    itemSource: f.itemSource,
    // missedCommitment נישא הלאה מה-nudge המקורי (לא מנוחש כאן) — כדי שתשובה שמגיעה רק אחרי
    // התזכורת עדיין תזוהה נכון כ"התחייבות שהוחמצה" ולא תאבד את ה-context (audit 2026-09-16).
    context: { taskName, followupId: f.id, followupKind: "no_response_reminder", currentDueDateISO: payload.currentDueDateISO ?? null, missedCommitment: !!payload.missedCommitment },
  });
  deps.publishNudge({
    userKey: f.userKey,
    findingKey: f.findingKey,
    itemId: f.itemId,
    itemSource: f.itemSource,
    body,
    taskName,
    project: null,
    currentDueDateISO: payload.currentDueDateISO ?? null,
    createdAt: now.toISO()!,
  });

  markFollowupTriggered(f.id);

  // best-effort: תמיד לתזמן את שלב ההסלמה הבא (EOD אם עדיין אין תשובה) — כשל כאן לא מבטל את
  // התזכורת שכבר נשלחה בהצלחה.
  try {
    const local = now.setZone(env.TIMEZONE);
    const todayEod = local.set({ hour: FOLLOWUP_CONFIG.endOfDay.hour, minute: FOLLOWUP_CONFIG.endOfDay.minute, second: 0, millisecond: 0 });
    createOrReplaceFollowupForKind("end_of_day_no_response", {
      findingKey: f.findingKey,
      itemId: f.itemId,
      itemSource: f.itemSource,
      userKey: f.userKey,
      kind: "end_of_day_no_response",
      dueAtISO: toStoredUtcIso(todayEod),
      payload: { ...payload, reminderSentAtISO: toStoredUtcIso(local) },
    });
  } catch (err) {
    logger.error({ followupId: f.id, err }, "תזמון end_of_day_no_response נכשל — התזכורת עצמה נשלחה בהצלחה");
  }

  return "reminder_sent";
}

/** Rule 18, שלב 2: אין תשובה עד סוף היום — התראה ניהולית למוטי (לא Approval, אין כפתורי כן/לא). */
async function processEndOfDayNoResponse(f: StoredFollowup, now: DateTime, deps: Required<FollowupRunnerDeps>): Promise<string> {
  if (!f.itemId || !f.itemSource || !f.findingKey) {
    completeFollowup(f.id);
    return "completed_missing_item";
  }

  const payload = (f.payload ?? {}) as {
    taskName?: string;
    nudgeSentAtISO?: string;
    reminderSentAtISO?: string | null;
  };
  if (payload.nudgeSentAtISO && hasRespondedSince(f.findingKey, payload.nudgeSentAtISO)) {
    completeFollowup(f.id);
    return "completed_already_responded";
  }

  const moti = resolveUserByKey("moti");
  if (!moti) {
    // אין את מי להתריע — לא "נבלע": חוזר ל-pending (נתפס למעלה כ-throw), ינסה שוב בהרצה הבאה.
    throw new Error("אין משתמש moti מוגדר — לא ניתן ליצור התראה ניהולית על אי-מענה");
  }

  const employee = resolveUserByKey(f.userKey);
  const employeeName = employee?.name ?? f.userKey;
  const taskName = payload.taskName ?? f.itemId;
  const sentAt = payload.nudgeSentAtISO ? DateTime.fromISO(payload.nudgeSentAtISO, { zone: "utc" }).setZone(env.TIMEZONE) : null;
  const hoursPassed = sentAt ? Math.round(now.diff(sentAt, "hours").hours) : null;
  const reminderSent = !!payload.reminderSentAtISO;

  const body =
    `${employeeName} לא הגיב/ה היום לפניית הבקרה לגבי המשימה "${taskName}".` +
    (sentAt ? `\nהפנייה הראשונה נשלחה ב-${sentAt.toFormat("HH:mm")}.` : "") +
    `\nתזכורת: ${reminderSent ? "נשלחה" : "לא נשלחה"}.` +
    (hoursPassed !== null ? `\nעברו כ-${hoursPassed} שעות בלי תשובה.` : "");

  // notification רגילה — לא Approval: מוטי רק רואה, לא צריך ללחוץ כן/לא.
  deps.addNotification(moti.key, "awaiting_decision", body, f.findingKey, {
    itemId: f.itemId,
    itemSource: f.itemSource,
    context: {
      employee: f.userKey,
      employeeName,
      taskName,
      findingKey: f.findingKey,
      itemId: f.itemId,
      firstNudgeAt: payload.nudgeSentAtISO ?? null,
      reminderSent,
      hoursPassed,
    },
  });

  // רק אחרי שההתראה נוצרה בהצלחה — אחרת נתפס למעלה, חוזר ל-pending, ניתן ל-retry (דרישה #10).
  completeFollowup(f.id);
  return "escalated_no_response";
}
