/**
 * שלב "התראות ותזכורות" (2026-10-19) — buildReminderText מזריק את תאריך היום הפתוח לגוף
 * התזכורת, כדי שתזכורות על ימים שונים (עובד ששכח לסגור שעון כמה ימים ברצף) יראו שונות זו מזו
 * בחלונית במקום להיראות כמו הודעה משוכפלת. "שעון הנוכחות שלך עדיין פעיל" נשארת תת-מחרוזת רצופה
 * בכוונה — tests/integration/attendance.test.ts בודק אותה; הבדיקה הזו מגנה על אותה הנחה.
 */

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { buildReminderText } from "../../src/ops/attendanceReminderScheduler.js";

describe("buildReminderText — תאריך מוזרק בלי לשבור את ההנחה הקיימת", () => {
  it("כולל את תת-המחרוזת הקיימת שבדיקת attendance.test.ts בודקת", () => {
    expect(buildReminderText("2030-03-10")).toContain("שעון הנוכחות שלך עדיין פעיל");
  });

  it("כולל את התאריך בפורמט dd/MM", () => {
    expect(buildReminderText("2030-03-10")).toContain("10/03");
    expect(buildReminderText("2030-12-01")).toContain("01/12");
  });

  it("שני ימים פתוחים שונים מייצרים גוף הודעה שונה (לא נראים כמו אותה הודעה משוכפלת)", () => {
    const day1 = buildReminderText("2030-03-10");
    const day2 = buildReminderText("2030-03-11");
    expect(day1).not.toBe(day2);
  });
});
