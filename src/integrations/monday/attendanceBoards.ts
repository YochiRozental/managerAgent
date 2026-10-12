/**
 * מודול נוכחות — תצורת לוחות Monday (שלב ד, הכנה בלבד — ר' דוח המימוש לתוכנית השינוי המדויקת).
 *
 * boardId הוא היחיד שידוע וקבוע מראש (הלוחות האישיים הקיימים, מהחקירה בשלב א — לא נוצרו כאן).
 * group/columns **לא** מקודדים כ-ID קשיח: הם עדיין לא קיימים בפועל, ויוצרו (אם יאושר) ע"י מוטי/
 * יוכי ישירות ב-Monday, לא ע"י קוד. לכן attendanceMondayClient.ts מאתר אותם *דינמית לפי כותרת*
 * (ATTENDANCE_GROUP_TITLE/ATTENDANCE_COLUMN_TITLES) — בדיוק כמו ש-opsWrite.ts/itemWrite.ts כבר
 * עושים (detectPeopleColumn/findOrCreateStageGroupId) — ולא יכול בעצמו ליצור את הקבוצה (רק שלבים
 * ב-opsWrite.ts יוצרים group; כאן בכוונה אין create_group כלל).
 */

/** לוח הנוכחות האישי של כל עובד (מהחקירה בשלב א, 2026-10-11) — לא נוצר/משתנה כאן. */
export const ATTENDANCE_BOARD_BY_USER_KEY: Readonly<Record<string, string>> = {
  moti: "1591192862",
  dov: "1590588602",
  eitan: "1590693754",
  ruchama: "1590693795",
  goldi: "1590693919",
  yochi: "1805215192",
};

export function getAttendanceBoardId(userKey: string): string | null {
  return ATTENDANCE_BOARD_BY_USER_KEY[userKey] ?? null;
}

/** שם הקבוצה שתבקשת ליצור (סעיף 1 בהחלטות) — לא נוצר כאן, רק מאותר. */
export const ATTENDANCE_GROUP_TITLE = "דיווחי נוכחות יומיים (סוכן)";

/**
 * כותרות העמודות המדויקות שיש ליצור (ר' דוח המימוש לטבלה המלאה כולל סוג/API-writable). המפתחות
 * (workDate/firstIn/...) הם המזהים הפנימיים שלנו; הערכים הם הכותרת העברית *המדויקת* שחובה
 * להשתמש בה ביצירה בפועל ב-Monday — attendanceMondayClient.ts מאתר עמודות לפי הכותרת הזו, לא
 * לפי סדר/מיקום.
 */
export const ATTENDANCE_COLUMN_TITLES = {
  workDate: "תאריך עבודה",
  firstIn: "כניסה ראשונה",
  lastOut: "יציאה אחרונה",
  breakMinutes: "דקות הפסקה",
  netHours: "שעות נטו",
  status: "סטטוס דיווח",
  segmentCount: "מספר מקטעים",
  source: "מקור דיווח",
  syncId: "מזהה סנכרון",
} as const;

export type AttendanceColumnKey = keyof typeof ATTENDANCE_COLUMN_TITLES;

/** מזהה סנכרון ייחודי לכל (עובד,תאריך) — נכתב לעמודת "מזהה סנכרון" ומשמש לאיתור-לפני-יצירה. */
export function buildAttendanceSyncId(userKey: string, workDate: string): string {
  return `att:${userKey}:${workDate}`;
}
