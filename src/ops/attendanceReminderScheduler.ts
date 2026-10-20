/**
 * Ticker תזכורות נוכחות — נפרד לגמרי מ-Follow-up Engine הקיים (followups.ts/scheduler.ts), שסורק
 * כל 15 דקות בתוך חלון עבודה קבוע: תזכורת אישית יכולה להיות בכל שעה, וצריכה דיוק של דקה, לא רבע
 * שעה. כל טיק הוא שאילתת DB קלה אחת (JOIN על attendance_days+attendance_reminder_prefs) —
 * בלי Monday, בלי AI.
 *
 * רמת ההבטחה בפועל (audit שלב ד, 2026-10-11 — נבדק במפורש, לא רק מוצהר):
 *   • הרשומה הדורשת ב-DB (notifications + attendance_days.reminder_status='sent') נכתבת
 *     ב-**טרנזקציה אחת** (runInTransaction) — אם התהליך קורס *בתוך* הטרנזקציה (אחרי שה-notification
 *     נכתב, לפני שה-COMMIT הסתיים), SQLite מבטל את כל הטרנזקציה ב-recovery; reminder_status
 *     תקוע ב-'pending_send' (נכתב *לפני* הטרנזקציה, ב-claimReminder) מתאפס ל-'none' ב-startup
 *     (recoverStuckAttendanceReminders), והטיק הבא כותב מההתחלה — בלי כפילות.
 *     **מובטח: אין כפילות ברשומה הדורשת** (exactly-once עבורה, בהינתן אחריות ה-crash-safety
 *     של SQLite ל-transaction מחויב).
 *   • publishNotificationLive (דחיפה חיה ל-SSE, לחלון פתוח) נשארת **מחוץ** לטרנזקציה, בכוונה —
 *     היא לא ניתנת ל-rollback (אין "לבטל" push שכבר יצא לרשת) ולכן לא יכולה להיות חלק מהבטחה
 *     אטומית. אם התהליך קורס *בדיוק* בין COMMIT להצלחה של publish — הרשומה כבר קיימת (status
 *     'sent', לא תישלח שוב בטיק הבא), אבל ייתכן שהעובד לא קיבל את ה-push החי ברגע האמת. **זה
 *     לא אובדן**: הרשומה תופיע כהתראה לא-נראית בפעם הבאה שהחלון נטען/מתרפרש (listUnseenNotifications).
 *     לכן: **at-least-once + zero-duplicate עבור הרשומה הדורשת, best-effort (לא מובטח) עבור
 *     התזמון-בזמן-אמת של ה-push החי.** לא exactly-once במובן המוחלט (אין הבטחת-מסירה קריפטוגרפית
 *     על תשתית רשת/SSE), אבל אין תרחיש שמוליד כפילות.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { runInTransaction } from "../db/db.js";
import { isAttendanceModuleEnabled, reconcileAllOpenAttendanceReminders } from "./attendance.js";
import {
  listOpenDaysDueForReminder,
  claimReminder,
  markReminderSent,
  revertReminderClaim,
  recoverStuckAttendanceReminders,
  type StoredAttendanceDay,
} from "../db/repositories/attendanceDays.js";
import { addNotification } from "../db/repositories/notifications.js";
import { publishNotificationLive } from "./notificationBus.js";
import { logger } from "../utils/logger.js";

const TICK_MS = 60_000;

/**
 * workDate מוזרק (dd/MM בסוגריים) כדי שתזכורות על ימים שונים — אם העובד השאיר את השעון פתוח
 * כמה ימים ברצף, כל יום בלגיטימיות מייצר תזכורת חדשה משלו (ר' reminder_status CAS ב-attendanceDays.ts,
 * אין כפילות אמיתית לאותו יום) — יראו שונות זו מזו בחלונית במקום להיראות כמו הודעה משוכפלת.
 * "שעון הנוכחות שלך עדיין פעיל" נשאר תת-מחרוזת רצופה בכוונה — tests/integration/attendance.test.ts
 * בודק אותה.
 */
export function buildReminderText(workDate: string): string {
  const dateLabel = DateTime.fromISO(workDate, { zone: env.TIMEZONE }).toFormat("dd/MM");
  return (
    `שים לב, שעון הנוכחות שלך עדיין פעיל (מתאריך ${dateLabel}).\n` +
    "האם סיימת לעבוד להיום?\n" +
    "אם כן, באיזו שעה סיימת בפועל?"
  );
}

export interface SendReminderDeps {
  addNotification?: typeof addNotification;
  publishNotificationLive?: typeof publishNotificationLive;
}

/**
 * שולחת תזכורת אחת, עם ה-CAS claim לפניה. true ⇔ הרשומה הדורשת נכתבה בפועל (גם אם ה-push
 * החי נכשל/לא בוצע — ר' docstring בראש הקובץ לרמת ההבטחה המדויקת). false ⇔ מישהו אחר כבר
 * תפס/נשלח, או שהכתיבה הדורשת עצמה נכשלה (ואז claimReminder מתבטל כדי שהטיק הבא ינסה שוב).
 */
export async function sendAttendanceReminder(day: StoredAttendanceDay, deps: SendReminderDeps = {}): Promise<boolean> {
  const doAddNotification = deps.addNotification ?? addNotification;
  const doPublish = deps.publishNotificationLive ?? publishNotificationLive;

  if (!claimReminder(day.userKey, day.workDate)) return false; // מישהו אחר כבר תפס/נשלח

  const body = buildReminderText(day.workDate);
  let notifId: number;
  try {
    // atomic: notification + reminder_status='sent' יחד. קריסה באמצע → rollback מלא (SQLite),
    // reminder_status נשאר 'pending_send' (ר' claimReminder למעלה, מחוץ לטרנזקציה הזו) →
    // recoverStuckAttendanceReminders ב-startup מאפס ל-'none' → הטיק הבא כותב מההתחלה, בלי כפילות.
    notifId = runInTransaction(() => {
      // context.workDate (audit "תזכורות נוכחות נראות כפולות", 2026-10-19) — עד כה רק הדחיפה
      // החיה למטה (doPublish) נשאה את זה; הרשומה הנשמרת נשארה בלי מבנה, ואחרי טעינה מחדש
      // (GET /api/notifications) המידע פשוט נעלם. עכשיו גם הרשומה הנשמרת נושאת אותו — אותו
      // day.workDate בדיוק, לא טקסט חופשי מ-body.
      const id = doAddNotification(day.userKey, "attendance_reminder", body, undefined, {
        context: { workDate: day.workDate },
      });
      markReminderSent(day.userKey, day.workDate);
      return id;
    });
  } catch (err) {
    logger.error({ err, user: day.userKey, workDate: day.workDate }, "תזכורת נוכחות: כתיבת הרשומה נכשלה — חוזר ל-none, יינסה שוב בטיק הבא");
    revertReminderClaim(day.userKey, day.workDate);
    return false;
  }

  // best-effort בכוונה, *מחוץ* לטרנזקציה — ר' docstring. כשל כאן לא מבטל את ה-'sent' שכבר
  // נכתב (הרשומה קיימת, לא תישלח שוב) — רק מאבד את הדחיפה החיה; ההתראה עדיין תיראה בטעינה הבאה.
  try {
    doPublish({
      userKey: day.userKey,
      id: notifId,
      kind: "attendance_reminder",
      body,
      findingKey: null,
      itemId: null,
      itemSource: null,
      context: { workDate: day.workDate },
      createdAt: DateTime.now().toISO()!,
    });
  } catch (err) {
    logger.warn({ err, user: day.userKey, workDate: day.workDate }, "תזכורת נוכחות: הדחיפה החיה נכשלה — ההתראה כבר נשמרה, תיראה בטעינה הבאה");
  }

  return true;
}

let tickInProgress = false;

export async function runAttendanceReminderTick(now: DateTime = DateTime.now().setZone(env.TIMEZONE)): Promise<number> {
  if (tickInProgress) return 0; // הגנת overlap ברמת ה-scheduler — ה-CAS ב-DB נשאר שכבת הגנה נוספת
  tickInProgress = true;
  try {
    // סריקת ה-reconciliation היזומה (audit "מחזור חיים" 2026-10-20 — ר' reconcileAllOpenAttendanceReminders
    // ב-attendance.ts) רצה בכל טיק, לפני שליחת תזכורות חדשות: סוגרת כל תזכורת פתוחה ששייכת ליום
    // שכבר נסגר בפועל (למשל אחרי correction שאושרה), גם אם אף hook ריאקטיבי לא "נגע" בה מאז.
    // best-effort מכוונת — כשל כאן לא אמור לעצור שליחת תזכורות חדשות, וה-return value של הפונקציה
    // הזו (sent) ממשיך להיות רק מספר התזכורות שנשלחו בפועל, כפי שבדיקות קיימות סומכות עליו.
    try {
      reconcileAllOpenAttendanceReminders();
    } catch (err) {
      logger.warn({ err }, "תזכורות נוכחות: סריקת reconciliation נכשלה — ממשיכים לשליחת תזכורות חדשות");
    }

    const due = listOpenDaysDueForReminder(now.hour, now.minute);
    let sent = 0;
    for (const day of due) {
      if (await sendAttendanceReminder(day)) sent++;
    }
    return sent;
  } finally {
    tickInProgress = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * מפעיל את ה-ticker. בודק ATTENDANCE_MODULE_ENABLED בעצמו (הגנה כפולה — גם אם ייקרא בעתיד
 * מ-scheduler.ts ללא תנאי, לא ירוץ בפועל כש-הדגל כבוי). Idempotent — קריאה חוזרת לא כפולה.
 */
export function startAttendanceReminderSchedule(): void {
  if (timer) return;
  if (!isAttendanceModuleEnabled()) {
    logger.info("מודול נוכחות כבוי (ATTENDANCE_MODULE_ENABLED=false) — ticker התזכורות לא מופעל.");
    return;
  }
  const recovered = recoverStuckAttendanceReminders();
  if (recovered > 0) logger.warn({ recovered }, "תזכורות נוכחות: שוחזרו שורות תקועות (קריסה/ריסטרט קודם)");
  timer = setInterval(() => void runAttendanceReminderTick(), TICK_MS);
}

export function stopAttendanceReminderSchedule(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
