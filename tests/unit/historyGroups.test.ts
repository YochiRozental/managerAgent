/** קיבוץ שיחות בסרגל הצד (ui.html) — גבולות שבוע א׳–ש׳ לפי Asia/Jerusalem. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync("src/server/ui.html", "utf8");
const block = html.slice(html.indexOf("/* dayBucket:start"), html.indexOf("/* dayBucket:end */"));
const { dayBucket, calDayNum } = new Function(`${block}; return { dayBucket, calDayNum };`)() as {
  dayBucket: (last: string, now: Date) => string;
  calDayNum: (d: Date) => number;
};
// זמנים בפורמט SQLite (UTC). now נתון כרגע UTC.
const at = (utc: string) => new Date(utc + "Z");

describe("dayBucket", () => {
  const now = at("2026-11-01T09:00:00"); // יום ראשון, ישראל UTC+2
  it("יום ראשון: אין 'השבוע' — שיחות מהשבוע שעבר לא מופיעות בו", () => {
    expect(dayBucket("2026-11-01 05:00:00", now)).toBe("היום");
    expect(dayBucket("2026-10-31 10:00:00", now)).toBe("אתמול"); // שבת
    expect(dayBucket("2026-10-30 10:00:00", now)).toBe("שבוע שעבר"); // שישי
    expect(dayBucket("2026-10-26 10:00:00", now)).toBe("שבוע שעבר"); // שני
    expect(dayBucket("2026-10-25 10:00:00", now)).toBe("שבוע שעבר"); // ראשון שעבר
    expect(dayBucket("2026-10-24 10:00:00", now)).toBe("קודם לכן"); // שבת לפניו
  });
  it("אמצע שבוע: השבוע מתחיל ביום ראשון", () => {
    const wed = at("2026-11-04T09:00:00");
    expect(dayBucket("2026-11-03 09:00:00", wed)).toBe("אתמול");
    expect(dayBucket("2026-11-01 09:00:00", wed)).toBe("השבוע"); // ראשון
    expect(dayBucket("2026-10-31 09:00:00", wed)).toBe("שבוע שעבר"); // שבת
    expect(dayBucket("2026-10-25 09:00:00", wed)).toBe("שבוע שעבר");
    expect(dayBucket("2026-10-24 09:00:00", wed)).toBe("קודם לכן");
  });
  it("חצות בשעון ישראל, לא UTC (22:30 UTC = כבר מחר בישראל)", () => {
    expect(dayBucket("2026-10-31 22:30:00", now)).toBe("היום"); // 00:30 ב-1.11 בישראל
    expect(dayBucket("2026-10-31 21:30:00", now)).toBe("אתמול"); // 23:30 ב-31.10
  });
  it("מעבר חודש ושנה", () => {
    const jan = at("2027-01-02T10:00:00"); // שבת
    expect(dayBucket("2027-01-01 10:00:00", jan)).toBe("אתמול");
    expect(dayBucket("2026-12-27 10:00:00", jan)).toBe("השבוע"); // ראשון 27.12
    expect(dayBucket("2026-12-26 10:00:00", jan)).toBe("שבוע שעבר");
    expect(dayBucket("2026-12-20 10:00:00", jan)).toBe("שבוע שעבר");
    expect(dayBucket("2026-12-19 10:00:00", jan)).toBe("קודם לכן");
  });
  it("שעון קיץ/חורף: מעבר ל-DST (27.3.2026) ולחזרה (25.10.2026)", () => {
    const afterSpring = at("2026-03-28T22:30:00"); // 00:30 ב-29.3 (ראשון) בישראל UTC+3
    expect(dayBucket("2026-03-27 12:00:00", afterSpring)).toBe("שבוע שעבר");
    expect(dayBucket("2026-03-28 12:00:00", afterSpring)).toBe("אתמול");
    const afterFall = at("2026-10-25T22:30:00"); // 00:30 ב-26.10 (שני), UTC+2
    expect(dayBucket("2026-10-25 12:00:00", afterFall)).toBe("אתמול");
    expect(dayBucket("2026-10-24 12:00:00", afterFall)).toBe("שבוע שעבר");
  });
  it("calDayNum: הפרש ימי-לוח נכון ביום קצר (23 שעות)", () => {
    // 00:30 ב-29.3 מול 12:00 ב-28.3 — now-24h היה נופל על 27.3 (באג 'אתמול')
    expect(calDayNum(at("2026-03-28T22:30:00")) - calDayNum(at("2026-03-28T10:00:00"))).toBe(1);
  });
});
