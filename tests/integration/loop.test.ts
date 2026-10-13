/**
 * הלולאה (finding_events, החלטת ההסלמה, נוסח הפנייה, מיפוי תוויות) — הועבר אחד-לאחד מ-
 * scripts/test-loop.ts (21 בדיקות, הסקריפט הישן הוסר).
 *
 * integration ולא unit: כותב וקורא את טבלת finding_events — כאן ב-DB הזמני המבודד בלבד
 * (tests/setup/isolate.ts). הסקריפט הישן כתב ל-data/agent.db המקומי.
 */

import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/db/db.js";
import {
  isResolvedByReply,
  lastResponseAt,
  recordFindingEvent,
  snoozedUntil,
} from "../../src/db/repositories/findingEvents.js";
import { buildNudgeText, escalationDecision } from "../../src/ops/escalation.js";
import { PARKED_LABEL, waitingLabel } from "../../src/integrations/monday/opsWrite.js";

const now = DateTime.fromISO("2026-09-10T12:00:00", { zone: "Asia/Jerusalem" }); // יום ה'
const K = "__test_loop__";

beforeAll(() => db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '${K}%'`));
afterAll(() => db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '${K}%'`));

describe("finding_events repo", () => {
  beforeAll(() => {
    recordFindingEvent(`${K}a`, "nudge_sent", { byUser: "dov" });
    recordFindingEvent(`${K}a`, "employee_responded", { byUser: "dov", note: "עוד קצת" });
    recordFindingEvent(`${K}b`, "snoozed", { snoozeUntil: "2026-09-15" });
    recordFindingEvent(`${K}c`, "resolved_by_reply", { action: "done" });
  });

  it("lastResponseAt מחזיר את התגובה", () => expect(lastResponseAt(`${K}a`)).not.toBeNull());
  it("אין snooze על a", () => expect(snoozedUntil(`${K}a`)).toBeNull());
  it("a לא נסגר", () => expect(isResolvedByReply(`${K}a`)).toBe(false));
  it("snoozedUntil מחזיר את התאריך", () => expect(snoozedUntil(`${K}b`)).toBe("2026-09-15"));
  it("c נסגר בעקבות תשובה", () => expect(isResolvedByReply(`${K}c`)).toBe(true));
});

describe("escalationDecision", () => {
  const base = { escalationLevel: 0, severity: "high" as const };
  const fresh4d = { ...base, findingKey: `${K}fresh`, firstSeen: "2026-09-04T09:00:00+03:00" }; // 4 ימי עבודה קודם
  const deps0 = { isResolvedByReply: () => false, snoozedUntil: () => null, lastResponseAt: () => null };

  it("ממצא ישן (כמה ימי עבודה) → target 3", () => {
    const d = escalationDecision(fresh4d, now, deps0);
    expect(d.skip).toBe(false);
    expect(d.target).toBe(3);
    expect(d.stale).toBeGreaterThanOrEqual(3);
  });

  it("ממצא בן יום עבודה 1 → target 1", () => {
    const d = escalationDecision({ ...base, findingKey: `${K}day1`, firstSeen: now.minus({ days: 1 }).toISO()! }, now, deps0);
    expect(d.skip).toBe(false);
    expect(d.target).toBe(1);
  });

  it("resolved_by_reply → skip", () => {
    const d = escalationDecision(
      { ...base, findingKey: `${K}x`, firstSeen: "2026-09-04T09:00:00+03:00" },
      now,
      { ...deps0, isResolvedByReply: () => true },
    );
    expect(d.skip).toBe(true);
    expect(d.skipReason).toBe("resolved_by_reply");
  });

  it("snoozed לעתיד → skip", () => {
    const d = escalationDecision(fresh4d, now, { ...deps0, snoozedUntil: () => "2026-09-15" });
    expect(d.skip).toBe(true);
    expect(d.skipReason).toBe("snoozed");
  });

  it("snoozed שעבר → לא skip", () => {
    expect(escalationDecision(fresh4d, now, { ...deps0, snoozedUntil: () => "2026-09-08" }).skip).toBe(false);
  });

  it("תגובה היום → שעון מתאפס, target 0", () => {
    const d = escalationDecision(fresh4d, now, { ...deps0, lastResponseAt: () => "2026-09-10T08:00:00+03:00" });
    expect(d.skip).toBe(false);
    expect(d.stale).toBe(0);
    expect(d.target).toBe(0);
  });

  it("critical → target 3 מייד", () => {
    const d = escalationDecision(
      { ...base, findingKey: `${K}crit`, firstSeen: "2026-09-10T08:00:00+03:00", severity: "critical" },
      now,
      deps0,
    );
    expect(d.skip).toBe(false);
    expect(d.target).toBe(3);
  });
});

describe("buildNudgeText", () => {
  const txt = buildNudgeText(
    { who: "דוב שפירא", headline: "באיחור 3 ימים: תוכנית חשמל", kind: "overdue_stale", project: "כהן" },
    "3 ימי עבודה בלי תזוזה",
  );
  it("נוסח הפנייה כולל שם פרטי", () => expect(txt.startsWith("דוב,")).toBe(true));
  it("נוסח הפנייה כולל שם המשימה", () => expect(txt).toContain("תוכנית חשמל"));
  it("נוסח הפנייה כולל את הפרויקט", () => expect(txt).toContain("כהן"));
  it("נוסח הפנייה שואל מה המצב", () => expect(txt).toContain("מה המצב?"));
});

describe("מיפוי תוויות", () => {
  it("waiting client / project → 'ממתין ללקוח'", () => expect(waitingLabel("project_stage", "client")).toBe("ממתין ללקוח"));
  it("waiting consultant / project → 'מתתין ליועץ/ספק/אחר'", () =>
    expect(waitingLabel("project_stage", "consultant")).toBe("מתתין ליועץ/ספק/אחר"));
  it("waiting client / general → 'ממתין להתייחסות'", () => expect(waitingLabel("general", "client")).toBe("ממתין להתייחסות"));
  it("parked general → 'מושהה'", () => expect(PARKED_LABEL.general).toBe("מושהה"));
  it("parked project → 'לא רלוונטי'", () => expect(PARKED_LABEL.project_stage).toBe("לא רלוונטי"));
});
