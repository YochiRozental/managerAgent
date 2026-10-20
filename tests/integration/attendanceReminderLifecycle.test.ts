/**
 * "מחזור חיים של התראות נוכחות + הפרדת לשוניות" (audit 2026-10-19) — ממצאים מאומתים בפרודקשן
 * (גרסה 77d0794): עד כה שום דבר לא חיבר בין סגירת/אימות יום נוכחות לבין ההתראה שהזכירה אותו —
 * תזכורת 286 (13/10, יוכי) נשארה "פעילה" לנצח אף שהסוכן אישר (קריאה בלבד, attendance_day_status)
 * שהיום כבר סגור. 292 (14/10) סומנה "נקראה" ב-19/10 — ללא שום מנגנון אוטומטי קיים בקוד שעושה
 * זאת (ר' attendance.ts/agentTools.ts לפני התיקון הזה: markNotificationSeenById/markNotifications
 * Seen נקראים *רק* מלחיצות UI, src/server/ui.html) — כלומר זה חייב היה להיות סימון ידני מפורש
 * דרך הממשק, לא "נסגר אוטומטית" כפי שאפשר היה לשער.
 *
 * הבדיקות כאן מכסות: (2) סגירה אוטומטית כש-יום נסגר בפועל (reportDayClose/recomputeAndPersistDay);
 * (3) סגירה כש-הסוכן רק *מאמת* שיום כבר סגור (attendance_day_status, בלי אירוע חדש); (4) שום
 * נתיב לא סוגר על בסיס טענה חופשית בצ'אט — closeAttendanceReminderNotifications תמיד דורש
 * workDate שמקורו באימות DB אמיתי; (5) התראות ישנות (context.workDate חסר) נסגרות רק בהתאמה
 * ודאית, ונשארות פתוחות כש-אין התאמה חד-משמעית; (6) בידוד בין משתמשים, idempotency, ואפס השפעה
 * על קינדים אחרים; (1) אין חפיפה בין "פעיל" ל"היסטוריה" (listUnseenNotifications מול
 * listNotificationsPage).
 *
 * DB זמני מבודד (tests/setup/isolate.ts) — לא נוגע בנתוני אמת. תאריכים פיקטיביים ב-2032.
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { describe, expect, it, beforeEach } from "vitest";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/db.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import {
  checkAttendanceDayStart,
  reportDayClose,
  setAttendanceReminderTime,
  closeAttendanceReminderNotifications,
} from "../../src/ops/attendance.js";
import { buildMessageIdempotencySeed } from "../../src/ops/attendanceEngine.js";
import { runAttendanceReminderTick } from "../../src/ops/attendanceReminderScheduler.js";
import { buildAgentTools } from "../../src/ops/agentTools.js";
import {
  addNotification,
  listUnseenNotifications,
  listNotificationsPage,
  markNotificationSeenById,
} from "../../src/db/repositories/notifications.js";

const yochi = resolveUserByKey("yochi")!;
const dov = resolveUserByKey("dov")!;
const TEST_USERS = ["yochi", "dov"];

function cleanup(): void {
  const placeholders = TEST_USERS.map(() => "?").join(",");
  db.prepare(`DELETE FROM attendance_events WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM attendance_days WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM attendance_reminder_prefs WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM notifications WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
}
beforeEach(() => cleanup());

const at = (day: string, hhmm: string) => DateTime.fromISO(`${day}T${hhmm}:00`, { zone: env.TIMEZONE });
let seedCounter = 0;
const seed = () => buildMessageIdempotencySeed({ scopeId: `lifecycle-${seedCounter++}`, turnOrdinal: 0 });

function openReminder(userKey: string) {
  return listUnseenNotifications(userKey).find((n) => n.kind === "attendance_reminder");
}

describe("2. סגירה אוטומטית כש-יום נוכחות נסגר בפועל", () => {
  it("reportDayClose סוגר את תזכורת הנוכחות המתאימה לאותו user+workDate", async () => {
    const day = "2032-01-10";
    setAttendanceReminderTime(yochi, 10, 0);
    checkAttendanceDayStart(yochi, at(day, "08:00"));
    await runAttendanceReminderTick(at(day, "10:00"));
    expect(openReminder(yochi.key)?.context).toEqual({ workDate: day });

    reportDayClose(yochi, at(day, "17:00"), seed());

    expect(openReminder(yochi.key)).toBeUndefined();
    const row = db.prepare(`SELECT seen_at FROM notifications WHERE user_key=? AND kind='attendance_reminder'`).get(yochi.key) as {
      seen_at: string | null;
    };
    expect(row.seen_at).not.toBeNull();
  });

  it("לא סוגר תזכורת של יום אחר (workDate שונה) באותו משתמש", async () => {
    const dayOld = "2032-01-11";
    const dayToday = "2032-01-12";
    setAttendanceReminderTime(yochi, 9, 0);

    // יום ישן עם תזכורת פעילה, לא נסגר.
    checkAttendanceDayStart(yochi, at(dayOld, "08:00"));
    await runAttendanceReminderTick(at(dayOld, "09:00"));
    db.prepare(`UPDATE attendance_days SET status='pending_completion' WHERE user_key=? AND work_date=?`).run(yochi.key, dayOld);

    // יום חדש נפתח ונסגר.
    checkAttendanceDayStart(yochi, at(dayToday, "08:00"));
    reportDayClose(yochi, at(dayToday, "17:00"), seed());

    const stillOpen = listUnseenNotifications(yochi.key).filter((n) => n.kind === "attendance_reminder");
    expect(stillOpen).toHaveLength(1);
    expect((stillOpen[0]!.context as { workDate?: string } | null)?.workDate).toBe(dayOld);
  });

  it("לא נוגע בהתראה של משתמש אחר, גם אם מקרית אותו workDate", async () => {
    const day = "2032-01-13";
    setAttendanceReminderTime(yochi, 9, 0);
    setAttendanceReminderTime(dov, 9, 0);
    checkAttendanceDayStart(yochi, at(day, "08:00"));
    checkAttendanceDayStart(dov, at(day, "08:00"));
    await runAttendanceReminderTick(at(day, "09:00"));
    expect(openReminder(yochi.key)).toBeDefined();
    expect(openReminder(dov.key)).toBeDefined();

    reportDayClose(yochi, at(day, "17:00"), seed());

    expect(openReminder(yochi.key)).toBeUndefined(); // נסגרה
    expect(openReminder(dov.key)).toBeDefined(); // דוב לא נגע בו
  });
});

describe("3. סגירה כש-הסוכן רק מאמת שיום כבר סגור (attendance_day_status, בלי אירוע חדש)", () => {
  it("תרחיש 286 המדויק: יום סגור בפועל, ההתראה 'נשכחה' פתוחה (כמו לפני התיקון) — קריאת סטטוס בלבד סוגרת אותה", async () => {
    const day = "2032-01-14";
    setAttendanceReminderTime(yochi, 10, 0);
    checkAttendanceDayStart(yochi, at(day, "08:00"));
    await runAttendanceReminderTick(at(day, "10:00"));
    reportDayClose(yochi, at(day, "17:00"), seed());
    // reportDayClose כבר סגר אותה (בדיקה 2) — מדמים כאן בכוונה את המצב *לפני* התיקון: התראה
    // ישנה שנשארה פתוחה למרות שהיום כבר סגור (reminder_sent_at עדיין תקין ל-findWorkDateForReminder).
    db.prepare(`UPDATE notifications SET seen_at = NULL WHERE user_key=? AND kind='attendance_reminder'`).run(yochi.key);
    expect(openReminder(yochi.key)).toBeDefined();

    const tools = buildAgentTools({ attendanceEnabledForUser: () => true });
    const tool = tools.find((t) => t.name === "attendance_day_status")!;
    const result = (await tool.execute({ workDate: day }, { user: yochi })) as { status: string };

    expect(result.status).toBe("closed"); // הקריאה עצמה עדיין נכונה ולא כתבה שום נתון נוכחות
    expect(openReminder(yochi.key)).toBeUndefined(); // אבל ההתראה נסגרה כתופעת-לוואי
  });

  it("יום עדיין פתוח — הקריאה לא סוגרת כלום", async () => {
    const day = "2032-01-15";
    setAttendanceReminderTime(yochi, 9, 0);
    checkAttendanceDayStart(yochi, at(day, "08:00"));
    await runAttendanceReminderTick(at(day, "09:00"));

    const tools = buildAgentTools({ attendanceEnabledForUser: () => true });
    const tool = tools.find((t) => t.name === "attendance_day_status")!;
    const result = (await tool.execute({ workDate: day }, { user: yochi })) as { status: string };

    expect(result.status).not.toBe("closed");
    expect(openReminder(yochi.key)).toBeDefined(); // עדיין פתוחה — בצדק
  });
});

describe("4. אין סגירה על בסיס טענה חופשית — רק לפי workDate מאומת מ-DB", () => {
  it("closeAttendanceReminderNotifications עם workDate שאינו תואם לשום תזכורת פתוחה — אפס השפעה", async () => {
    const day = "2032-01-16";
    setAttendanceReminderTime(yochi, 9, 0);
    checkAttendanceDayStart(yochi, at(day, "08:00"));
    await runAttendanceReminderTick(at(day, "09:00"));

    const closedCount = closeAttendanceReminderNotifications(yochi.key, "2032-09-01"); // תאריך שלא קשור לשום תזכורת
    expect(closedCount).toBe(0);
    expect(openReminder(yochi.key)).toBeDefined(); // לא נסגרה — "טענה" לא מגובה בנתון אמיתי
  });
});

describe("5. התראות ישנות (context.workDate חסר) — רק בהתאמה ודאית, אחרת נשארות פתוחות", () => {
  it("התראה ישנה עם reminder_sent_at תואם — נסגרת כש-היום נסגר", async () => {
    const day = "2032-01-17";
    setAttendanceReminderTime(yochi, 9, 0);
    checkAttendanceDayStart(yochi, at(day, "08:00"));
    await runAttendanceReminderTick(at(day, "09:00"));
    // הופכים אותה ל"ישנה" — מוחקים את context_json אבל משאירים created_at כמו שהוא (= reminder_sent_at).
    db.prepare(`UPDATE notifications SET context_json = NULL WHERE user_key=? AND kind='attendance_reminder'`).run(yochi.key);
    expect(openReminder(yochi.key)?.context).toBeNull();

    reportDayClose(yochi, at(day, "17:00"), seed());

    expect(openReminder(yochi.key)).toBeUndefined();
  });

  it("התראה 'ישנה' בלי שום שורת attendance_days תואמת (reminder_sent_at לא נמצא) — נשארת פתוחה, לא מנוחשת", () => {
    const id = addNotification(yochi.key, "attendance_reminder", "שים לב, שעון הנוכחות שלך עדיין פעיל.");
    // אין שום attendance_days row עם reminder_sent_at שווה ל-created_at של ההתראה הזו — findWorkDateForReminder יחזיר null.
    const closedCount = closeAttendanceReminderNotifications(yochi.key, "2032-01-18");
    expect(closedCount).toBe(0);
    const row = db.prepare(`SELECT seen_at FROM notifications WHERE id=?`).get(id) as { seen_at: string | null };
    expect(row.seen_at).toBeNull();
  });
});

describe("6. בידוד, idempotency, ואפס השפעה על קינדים לא-קשורים", () => {
  it("idempotent — קריאה שנייה לא סוגרת שוב / לא זורקת", async () => {
    const day = "2032-01-19";
    setAttendanceReminderTime(yochi, 9, 0);
    checkAttendanceDayStart(yochi, at(day, "08:00"));
    await runAttendanceReminderTick(at(day, "09:00"));

    const first = closeAttendanceReminderNotifications(yochi.key, day);
    expect(first).toBe(1);
    const second = closeAttendanceReminderNotifications(yochi.key, day);
    expect(second).toBe(0); // כבר seen_at — לא "נסגרת" שוב, לא שגיאה
  });

  it("לא נוגע בהתראות מסוג אחר של אותו משתמש", async () => {
    const day = "2032-01-20";
    setAttendanceReminderTime(yochi, 9, 0);
    checkAttendanceDayStart(yochi, at(day, "08:00"));
    await runAttendanceReminderTick(at(day, "09:00"));
    const otherId = addNotification(yochi.key, "task_assigned", "משימה לא קשורה");

    closeAttendanceReminderNotifications(yochi.key, day);

    const otherRow = db.prepare(`SELECT seen_at FROM notifications WHERE id=?`).get(otherId) as { seen_at: string | null };
    expect(otherRow.seen_at).toBeNull(); // לא נגעו בה
  });
});

describe("1. אין חפיפה בין 'פעיל' (listUnseenNotifications) ל'היסטוריה' (listNotificationsPage)", () => {
  it("אחרי סגירה אוטומטית — ההתראה עוברת ל'היסטוריה' בלבד, נעלמת מ'פעיל' לגמרי", async () => {
    const day = "2032-01-21";
    setAttendanceReminderTime(yochi, 9, 0);
    checkAttendanceDayStart(yochi, at(day, "08:00"));
    await runAttendanceReminderTick(at(day, "09:00"));
    const id = openReminder(yochi.key)!.id;

    reportDayClose(yochi, at(day, "17:00"), seed());

    const active = listUnseenNotifications(yochi.key).map((n) => n.id);
    const history = listNotificationsPage(yochi.key, 20).map((n) => n.id);
    expect(active).not.toContain(id);
    expect(history).toContain(id);
    expect(active.filter((x) => history.includes(x))).toEqual([]); // אין אף התראה בשתי הרשימות גם יחד
  });

  it("סימון ידני (markNotificationSeenById) גם הוא עובר ל'היסטוריה' בלבד — לא רק הסגירה האוטומטית", () => {
    const id = addNotification(yochi.key, "task_assigned", "משימה");
    expect(listUnseenNotifications(yochi.key).map((n) => n.id)).toContain(id);
    expect(listNotificationsPage(yochi.key, 20).map((n) => n.id)).not.toContain(id);

    markNotificationSeenById(yochi.key, id);

    expect(listUnseenNotifications(yochi.key).map((n) => n.id)).not.toContain(id);
    expect(listNotificationsPage(yochi.key, 20).map((n) => n.id)).toContain(id);
  });
});
