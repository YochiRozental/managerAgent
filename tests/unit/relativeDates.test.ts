/**
 * פענוח תאריכים יחסיים (src/ops/relativeDates.ts) — טהור, "עכשיו" מוזרק. כולל מעבר שבוע, שנה,
 * ואזור זמן (הלילה ב-UTC הוא כבר מחר בישראל).
 */

import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { explicitDayInText, resolveDateExpr, resolveSingleDay, shiftIsoDate } from "../../src/ops/relativeDates.js";

const TZ = "Asia/Jerusalem";
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ });
const WED = at("2026-10-21T10:00"); // יום רביעי
const r = (expr: string, now = WED) => resolveDateExpr(expr, now);
const d = (iso: string) => ({ from: iso, to: iso });

describe("ימים יחסיים", () => {
  it.each([
    ["היום", "2026-10-21"],
    ["מחר", "2026-10-22"],
    ["למחר", "2026-10-22"],
    ["מחרתיים", "2026-10-23"],
    ["אתמול", "2026-10-20"],
    ["שלשום", "2026-10-19"],
    ["tomorrow", "2026-10-22"],
    ["בעוד 3 ימים", "2026-10-24"],
    ["לפני 2 ימים", "2026-10-19"],
    ["+5", "2026-10-26"],
  ])("%s → %s", (expr, iso) => expect(r(expr)).toEqual(d(iso)));
});

describe("ימים בשבוע — תמיד המופע הבא אחרי היום", () => {
  it.each([
    ["יום ראשון הבא", "2026-10-25"],
    ["ראשון הבא", "2026-10-25"],
    ["ביום ראשון", "2026-10-25"],
    ["ראשון", "2026-10-25"],
    ["יום חמישי", "2026-10-22"],
    ["רביעי", "2026-10-28"], // היום רביעי → השבוע הבא, לא היום
    ["next sunday", "2026-10-25"],
    ["ראשון שעבר", "2026-10-18"],
    ["יום רביעי שעבר", "2026-10-14"],
  ])("%s → %s", (expr, iso) => expect(r(expr)).toEqual(d(iso)));

  it("ביום ראשון עצמו — 'יום ראשון הבא' הוא בעוד שבוע", () => {
    expect(r("יום ראשון הבא", at("2026-10-25T09:00"))).toEqual(d("2026-11-01"));
  });
});

describe("טווחים — שבוע ראשון–שבת", () => {
  it("השבוע / שבוע הבא / שבוע שעבר", () => {
    expect(r("השבוע")).toEqual({ from: "2026-10-18", to: "2026-10-24" });
    expect(r("שבוע הבא")).toEqual({ from: "2026-10-25", to: "2026-10-31" });
    expect(r("בשבוע הבא")).toEqual({ from: "2026-10-25", to: "2026-10-31" });
    expect(r("שבוע שעבר")).toEqual({ from: "2026-10-11", to: "2026-10-17" });
  });
  it("מעבר שבוע: בשבת 'השבוע' עדיין השבוע הנוכחי, 'מחר' כבר ראשון של השבוע הבא", () => {
    const sat = at("2026-10-24T12:00");
    expect(r("השבוע", sat)).toEqual({ from: "2026-10-18", to: "2026-10-24" });
    expect(r("מחר", sat)).toEqual(d("2026-10-25"));
    expect(r("השבוע", at("2026-10-25T08:00"))).toEqual({ from: "2026-10-25", to: "2026-10-31" });
  });
  it("החודש / חודש הבא", () => {
    expect(r("החודש")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(r("חודש הבא")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
  });
  it("מעבר שנה", () => {
    const dec31 = at("2026-12-31T10:00"); // חמישי
    expect(r("מחר", dec31)).toEqual(d("2027-01-01"));
    expect(r("שבוע הבא", dec31)).toEqual({ from: "2027-01-03", to: "2027-01-09" });
  });
});

describe("תאריכים מפורשים", () => {
  it.each([
    ["25/10", "2026-10-25"],
    ["1.11", "2026-11-01"],
    ["5/1/27", "2027-01-05"],
    ["2026-12-01", "2026-12-01"],
  ])("%s → %s", (expr, iso) => expect(r(expr)).toEqual(d(iso)));
  it("תאריך לא קיים → null", () => expect(r("31/02")).toBeNull());
});

describe("לא מנחשים", () => {
  it.each(["אחרי החג", "בהמשך", "מתישהו", "", "בקרוב"])("'%s' → null", (expr) => expect(r(expr)).toBeNull());
  it("resolveSingleDay דוחה טווח", () => {
    expect(resolveSingleDay("שבוע הבא", WED)).toBeNull();
    expect(resolveSingleDay("יום ראשון הבא", WED)).toBe("2026-10-25");
  });
});

describe("אזור זמן", () => {
  it("23:30 UTC של ה-21 = כבר ה-22 בישראל", () => {
    const now = DateTime.fromISO("2026-10-21T22:30:00Z").setZone(TZ);
    expect(r("היום", now)).toEqual(d("2026-10-22"));
    expect(r("מחר", now)).toEqual(d("2026-10-23"));
  });
  it("shiftIsoDate חוצה חודש", () => {
    expect(shiftIsoDate("2026-10-30", 3)).toBe("2026-11-02");
    expect(shiftIsoDate("2026-11-01", -1)).toBe("2026-10-31");
  });
});

describe("explicitDayInText — אימות התאריך שהמודל העביר מול מה שנאמר", () => {
  it.each([
    ["תעביר את כולן ליום ראשון הבא", "2026-10-25"],
    ["תעביר לראשון", "2026-10-25"],
    ["תזיז את כולן למחר", "2026-10-22"],
    ["העבר אותן ליום חמישי.", "2026-10-22"],
    ["בעוד 3 ימים", "2026-10-24"],
  ])("'%s' → %s", (t, iso) => expect(explicitDayInText(t, WED)).toBe(iso));
  it.each(["חוץ מהראשונה ברשימה", "תעביר לתאריך 25/10", "המשימה השנייה", "מחר או ביום ראשון", ""])("'%s' → null", (t) =>
    expect(explicitDayInText(t, WED)).toBeNull());
});
