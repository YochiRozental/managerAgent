/**
 * תצוגת HH:MM של זמן עבודה מצטבר (formatHHMM) — מהמילישניות המלאות, עיגול לדקה, ללא איפוס מעל 24 שעות.
 */

import { describe, expect, it } from "vitest";
import { formatHHMM, hoursFromMs } from "../../src/ops/taskTimerHours.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("formatHHMM", () => {
  it("דוגמאות מהדרישה", () => {
    expect(formatHHMM(17 * MIN)).toBe("00:17");
    expect(formatHHMM(90 * MIN)).toBe("01:30");
    expect(formatHHMM(12 * HOUR + 40 * MIN)).toBe("12:40");
  });

  it("אפס ופחות מחצי דקה → 00:00; 30 שניות ומעלה → דקה", () => {
    expect(formatHHMM(0)).toBe("00:00");
    expect(formatHHMM(29_999)).toBe("00:00");
    expect(formatHHMM(30_000)).toBe("00:01");
    expect(formatHHMM(90_624)).toBe("00:02"); // payme בפועל: 90.6 שניות
    expect(formatHHMM(59 * MIN + 29_999)).toBe("00:59");
    expect(formatHHMM(59 * MIN + 30_000)).toBe("01:00"); // גלישה לשעה
  });

  it("מעל 24 שעות — מספר השעות הכולל, בלי איפוס", () => {
    expect(formatHHMM(24 * HOUR)).toBe("24:00");
    expect(formatHHMM(25 * HOUR)).toBe("25:00");
    expect(formatHHMM(30 * HOUR + 5 * MIN)).toBe("30:05");
    expect(formatHHMM(100 * HOUR + 5 * MIN)).toBe("100:05");
    expect(formatHHMM(1234 * HOUR + 59 * MIN)).toBe("1234:59");
  });

  it("ערכים לא תקינים לא מפילים ולא מפיקים טקסט שגוי", () => {
    expect(formatHHMM(-5 * MIN)).toBe("00:00");
    expect(formatHHMM(Number.NaN)).toBe("00:00");
    expect(formatHHMM(Number.POSITIVE_INFINITY)).toBe("00:00");
  });

  it("העיגול מהמילישניות המלאות — מדויק יותר מהערך העשרוני (2 ספרות) שמוצג בעמודת המספר", () => {
    // 17.5 דקות: הערך העשרוני 0.29 ש' (=17.4 דק') היה נותן 00:17; מהמילישניות: 17.5 → 18
    expect(hoursFromMs(17.5 * MIN)).toBe(0.29);
    expect(formatHHMM(17.5 * MIN)).toBe("00:18");
  });
});
