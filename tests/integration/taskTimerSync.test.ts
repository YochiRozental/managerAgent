/**
 * סנכרון "זמן עבודה מצטבר" ל-Monday — בדיקות אינטגרציה מול DB מבודד ולקוח Monday מדומה בזיכרון
 * (אפס Monday אמיתי, אפס רשת). נוכחות אמיתית (ops/attendance.ts): הפסקות, סגירה ותיקונים רטרואקטיביים.
 */

import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/db.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import { buildMessageIdempotencySeed } from "../../src/ops/attendanceEngine.js";
import { checkAttendanceDayStart, reportBreakEnd, reportBreakStart, reportDayClose, requestAttendanceCorrection } from "../../src/ops/attendance.js";
import { endSegment, insertSegment, listSegmentsForDate } from "../../src/db/repositories/taskTimers.js";
import { claimItem, getSyncRow, markDirty, recoverStuckClaims } from "../../src/db/repositories/taskTimerSync.js";
import { startTimer, stopTimer, type TimerTaskRef } from "../../src/ops/taskTimer.js";
import { computeItemTotalMs, hoursFromMs } from "../../src/ops/taskTimerHours.js";
import { backfillTaskTimerSync, backoffMinutes, runTaskTimerMondaySync, SYNC_MAX_ATTEMPTS } from "../../src/ops/taskTimerSync.js";
import { markItemTimeDirty } from "../../src/ops/taskTimerSyncMark.js";
import { PermanentSyncError, type TaskTimerMondayClient } from "../../src/integrations/monday/taskTimerMondayClient.js";

const yochi = resolveUserByKey("yochi")!;
const dov = resolveUserByKey("dov")!;
const at = (day: string, hhmm: string) => DateTime.fromISO(`${day}T${hhmm}:00`, { zone: env.TIMEZONE });
const iso = (day: string, hhmm: string) => at(day, hhmm).toUTC().toISO()!;
const sid = (scope: string, id: string) => buildMessageIdempotencySeed({ scopeId: scope, channelMessageId: `${scope}-${id}` });
const task = (id: string, name: string, source: "project_stage" | "general" = "project_stage"): TimerTaskRef => ({
  itemId: id,
  itemSource: source,
  taskName: name,
  projectId: source === "project_stage" ? "p1" : null,
  projectName: source === "project_stage" ? "בלומינג" : null,
});
const openDay = (u: typeof yochi, day: string, hhmm = "09:00") => checkAttendanceDayStart(u, at(day, hhmm));

class FakeClient implements TaskTimerMondayClient {
  writes: { source: string; itemId: string; hours: number }[] = [];
  failWith: Error | null = null;
  onWrite: (() => void) | null = null;
  async writeCumulativeHours(source: string, itemId: string, hours: number) {
    if (this.failWith) throw this.failWith;
    this.onWrite?.();
    this.writes.push({ source, itemId, hours });
  }
  last(itemId: string) {
    return this.writes.filter((w) => w.itemId === itemId).at(-1);
  }
}

beforeAll(() => {
  for (const t of ["task_timer_segments", "task_timer_state", "task_timer_sync"]) db.prepare(`DELETE FROM ${t}`).run();
  for (const t of ["attendance_events", "attendance_days", "attendance_corrections"]) db.prepare(`DELETE FROM ${t} WHERE user_key IN ('yochi','dov')`).run();
});

describe("דגל כבוי (ברירת מחדל)", () => {
  it("בלי TASK_TIMER_MONDAY_SYNC_ENABLED — לא נוצרות שורות בתור, גם אחרי עצירת טיימר", () => {
    expect(env.TASK_TIMER_MONDAY_SYNC_ENABLED).toBe(false);
    const D = "2031-05-01";
    openDay(yochi, D);
    startTimer(yochi, task("900", "x"), at(D, "09:00"), sid("off", "a"));
    stopTimer(yochi, at(D, "10:00"), "stopped", sid("off", "b"));
    expect(getSyncRow("900")).toBeNull();
    markItemTimeDirty("900", "general");
    expect(getSyncRow("900")).toBeNull();
  });
});

describe("סיכום כולל, מספר עובדים וימים", () => {
  const A = task("1001", "תכניות קומה א");
  const D1 = "2031-06-02";
  const D2 = "2031-06-03";
  let client: FakeClient;

  beforeAll(() => {
    env.TASK_TIMER_MONDAY_SYNC_ENABLED = true;
    client = new FakeClient();
  });

  it("שני עובדים על אותה משימה — נכתב הסכום הכולל (לא עובד אחד)", async () => {
    openDay(yochi, D1);
    openDay(dov, D1);
    startTimer(yochi, A, at(D1, "09:00"), sid("s1", "a"));
    stopTimer(yochi, at(D1, "10:00"), "stopped", sid("s1", "b"));
    startTimer(dov, A, at(D1, "10:00"), sid("s1", "c"));
    stopTimer(dov, at(D1, "10:30"), "stopped", sid("s1", "d"));
    expect(getSyncRow("1001")?.status).toBe("dirty");
    const r = await runTaskTimerMondaySync(client, at(D1, "12:00"));
    expect(r.written).toBe(1);
    expect(client.last("1001")).toEqual({ source: "project_stage", itemId: "1001", hours: 1.5 });
    expect(getSyncRow("1001")?.status).toBe("synced");
  });

  it("חזרה לעבוד ביום אחר — מצטבר על הקודם (סכום מלא, לא דריסה בערך החדש)", async () => {
    openDay(yochi, D2);
    startTimer(yochi, A, at(D2, "09:00"), sid("s2", "a"));
    // טיימר פעיל לא נכלל עד העצירה
    expect(computeItemTotalMs("1001", iso(D2, "09:30"))).toBe(90 * 60_000);
    stopTimer(yochi, at(D2, "09:20"), "stopped", sid("s2", "b"));
    await runTaskTimerMondaySync(client, at(D2, "12:00"));
    // 90 דק' + 20 דק' = 110 דק' = 1.8333 ש' → מוצג 1.83; הדיוק המלא נשמר
    expect(client.last("1001")!.hours).toBe(1.83);
    expect(getSyncRow("1001")!.lastMs).toBe(110 * 60_000);
    expect(hoursFromMs(110 * 60_000)).toBe(1.83);
  });

  it("בלי שינוי — סבב נוסף לא קורא ל-Monday (גם אחרי סימון מחדש)", async () => {
    const before = client.writes.length;
    markDirty("1001", "project_stage");
    const r = await runTaskTimerMondaySync(client, at(D2, "13:00"));
    expect(r.skippedUnchanged).toBe(1);
    expect(client.writes.length).toBe(before);
    expect(getSyncRow("1001")?.status).toBe("synced");
  });

  it("טיימר פעיל לא מסומן ולא נכתב עד שנעצר", async () => {
    const B = task("1002", "חזיתות", "general");
    startTimer(yochi, B, at(D2, "13:00"), sid("s3", "a"));
    expect(getSyncRow("1002")).toBeNull();
    stopTimer(yochi, at(D2, "13:30"), "stopped", sid("s3", "b"));
    await runTaskTimerMondaySync(client, at(D2, "14:00"));
    expect(client.last("1002")).toEqual({ source: "general", itemId: "1002", hours: 0.5 }); // ניתוב לפי סוג המקור
  });
});

describe("תיקונים רטרואקטיביים בנוכחות", () => {
  const D = "2031-06-04";
  const B = task("2001", "שרטוט מפלס");
  const client = new FakeClient();

  it("הפסקה שדווחה בדיעבד מורידה את הסכום; תיקון שעת סגירה מקצר שוב", async () => {
    openDay(dov, D);
    startTimer(dov, B, at(D, "09:00"), sid("r1", "a"));
    stopTimer(dov, at(D, "11:00"), "stopped", sid("r1", "b"));
    await runTaskTimerMondaySync(client, at(D, "11:30"));
    expect(client.last("2001")!.hours).toBe(2);

    const bs = requestAttendanceCorrection(dov, { workDate: D, field: "break_start", newReportedForAtUtcIso: iso(D, "10:00"), insertNew: true, messageSeed: sid("r1", "c") });
    const be = requestAttendanceCorrection(dov, { workDate: D, field: "break_end", newReportedForAtUtcIso: iso(D, "10:30"), insertNew: true, messageSeed: sid("r1", "d") });
    expect(bs.ok && be.ok).toBe(true);
    expect(getSyncRow("2001")?.status).toBe("dirty"); // התיקון סימן את הפריט
    await runTaskTimerMondaySync(client, at(D, "12:00"));
    expect(client.last("2001")!.hours).toBe(1.5);

    reportDayClose(dov, at(D, "12:00"), sid("r1", "e"));
    await runTaskTimerMondaySync(client, at(D, "12:05"));
    expect(client.last("2001")!.hours).toBe(1.5); // סגירה אחרי הסוף — אין שינוי
    const fix = requestAttendanceCorrection(dov, { workDate: D, field: "day_close", newReportedForAtUtcIso: iso(D, "10:45"), messageSeed: sid("r1", "f") });
    expect(fix.ok).toBe(true);
    await runTaskTimerMondaySync(client, at(D, "12:10"));
    expect(client.last("2001")!.hours).toBe(1.25); // 09:00–10:45 פחות הפסקה של 30 דק'
  });

  it("סגירת יום עוצרת טיימר פעיל ומסמנת את הפריט לסנכרון", async () => {
    const D2 = "2031-06-05";
    const C = task("2002", "מערכות");
    openDay(dov, D2);
    startTimer(dov, C, at(D2, "09:00"), sid("r2", "a"));
    reportBreakStart(dov, at(D2, "10:00"), sid("r2", "b"));
    reportBreakEnd(dov, at(D2, "10:15"), sid("r2", "c"));
    reportDayClose(dov, at(D2, "11:00"), sid("r2", "d"));
    expect(listSegmentsForDate(dov.key, D2)[0]!.endReason).toBe("day_close");
    await runTaskTimerMondaySync(client, at(D2, "12:00"));
    expect(client.last("2002")!.hours).toBe(1.75); // 120 דק' פחות 15 דק' הפסקה
  });
});

describe("כשל תקשורת, retry ושחזור", () => {
  const D = "2031-06-06";
  const E = task("3001", "ניתוח");
  const client = new FakeClient();
  const closeOne = (id: string, a: string, b: string, k: string) => {
    startTimer(yochi, task(id, "t" + id), at(D, a), sid(k, "s"));
    stopTimer(yochi, at(D, b), "stopped", sid(k, "e"));
  };

  it("כשל זמני → failed עם backoff; ניסיון מוקדם לא רץ; ניסיון מאוחר מצליח; ללא כפילות", async () => {
    openDay(yochi, D);
    startTimer(yochi, E, at(D, "09:00"), sid("f1", "a"));
    stopTimer(yochi, at(D, "10:00"), "stopped", sid("f1", "b"));
    client.failWith = new Error("ETIMEDOUT");
    const r1 = await runTaskTimerMondaySync(client, at(D, "10:05"));
    expect(r1.failed).toBe(1);
    const row = getSyncRow("3001")!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("ETIMEDOUT");
    client.failWith = null;
    const early = await runTaskTimerMondaySync(client, at(D, "10:05"));
    expect(early.claimed).toBe(0); // עוד לא הגיע זמנו
    const r2 = await runTaskTimerMondaySync(client, at(D, "10:10"));
    expect(r2.written).toBe(1);
    expect(client.writes.filter((w) => w.itemId === "3001")).toEqual([{ source: "project_stage", itemId: "3001", hours: 1 }]);
    expect(getSyncRow("3001")).toMatchObject({ status: "synced", attempts: 0, lastError: null });
  });

  it("שגיאה קבועה → dead (בלי ניסיונות אינסופיים); שינוי חדש בפריט מחייה אותו", async () => {
    closeOne("3002", "10:30", "10:40", "f2");
    client.failWith = new PermanentSyncError("item not found");
    const r = await runTaskTimerMondaySync(client, at(D, "11:00"));
    expect(r.dead).toBe(1);
    expect(getSyncRow("3002")?.status).toBe("dead");
    expect((await runTaskTimerMondaySync(client, at(D, "23:00"))).claimed).toBe(0);
    client.failWith = null;
    startTimer(yochi, task("3002", "t3002"), at(D, "11:10"), sid("f2", "s2"));
    stopTimer(yochi, at(D, "11:20"), "stopped", sid("f2", "e2"));
    expect(getSyncRow("3002")).toMatchObject({ status: "dirty", attempts: 0 });
    await runTaskTimerMondaySync(client, at(D, "11:30"));
    expect(client.last("3002")!.hours).toBe(0.33);
  });

  it("אחרי SYNC_MAX_ATTEMPTS כשלים זמניים → dead", async () => {
    closeOne("3003", "11:40", "11:50", "f3");
    client.failWith = new Error("socket hang up");
    let now = at(D, "12:00");
    for (let i = 0; i < SYNC_MAX_ATTEMPTS; i++) {
      await runTaskTimerMondaySync(client, now);
      now = now.plus({ hours: 2 }); // מעבר ל-backoff המקסימלי
    }
    expect(getSyncRow("3003")?.status).toBe("dead");
    client.failWith = null;
  });

  it("backoff אקספוננציאלי עם תקרה", () => {
    expect([1, 2, 3, 4, 7, 20].map(backoffMinutes)).toEqual([1, 2, 4, 8, 60, 60]);
  });
});

describe("סנכרון ישן / בקשות מקבילות לא דורסים ערך חדש", () => {
  const D = "2031-06-09";
  it("שינוי שמגיע תוך כדי כתיבה → הפריט חוזר ל-dirty ונכתב שוב עם הערך החדש (לא נשאר הישן)", async () => {
    openDay(yochi, D);
    const F = task("4001", "מקביל");
    startTimer(yochi, F, at(D, "09:00"), sid("c1", "a"));
    stopTimer(yochi, at(D, "10:00"), "stopped", sid("c1", "b"));
    const client = new FakeClient();
    client.onWrite = () => {
      // "עובד אחר" סיים עבודה על אותו פריט בדיוק בזמן הכתיבה הראשונה
      const seg = insertSegment({ userKey: "dov", workDate: D, itemId: "4001", itemSource: "project_stage", taskName: "מקביל", projectId: null, projectName: null, startedAt: iso(D, "10:00"), idempotencyKey: "race-seg" });
      endSegment(seg.id, iso(D, "11:00"), "stopped", null);
      markDirty("4001", "project_stage");
      client.onWrite = null;
    };
    openDay(dov, D);
    const r1 = await runTaskTimerMondaySync(client, at(D, "12:00"));
    expect(r1.written).toBe(1);
    expect(client.writes[0]!.hours).toBe(1); // הערך הישן נכתב, אבל…
    expect(getSyncRow("4001")?.status).toBe("dirty"); // …לא מסומן כעדכני
    const r2 = await runTaskTimerMondaySync(client, at(D, "12:05"));
    expect(r2.written).toBe(1);
    expect(client.last("4001")!.hours).toBe(2);
    expect(getSyncRow("4001")?.status).toBe("synced");
  });

  it("claim אטומי: רק אחד מקבל פריט; claim תקוע משוחזר", () => {
    markDirty("4002", "general");
    const now = at(D, "12:00").toUTC().toISO()!;
    expect(claimItem("4002", "A", now)).toBe(true);
    expect(claimItem("4002", "B", now)).toBe(false);
    expect(getSyncRow("4002")?.status).toBe("syncing");
    markDirty("4002", "general"); // סימון תוך כדי claim לא מאפס את ה-claim
    expect(getSyncRow("4002")).toMatchObject({ status: "syncing", claimId: "A" });
    expect(recoverStuckClaims(at(D, "11:00").toUTC().toISO()!)).toBe(0); // עוד בתוקף
    expect(recoverStuckClaims(at(D, "13:00").toUTC().toISO()!)).toBe(1);
    expect(getSyncRow("4002")?.status).toBe("dirty");
  });

  it("סיום של claim שהוחלף (סנכרון ישן) לא משנה כלום", async () => {
    markDirty("4003", "general");
    const now = at(D, "12:00").toUTC().toISO()!;
    claimItem("4003", "OLD", now);
    recoverStuckClaims(at(D, "13:00").toUTC().toISO()!);
    claimItem("4003", "NEW", at(D, "13:01").toUTC().toISO()!);
    const { completeSync, failSync } = await import("../../src/db/repositories/taskTimerSync.js");
    expect(completeSync("4003", "OLD", 99, 1, now)).toBe(false);
    expect(failSync("4003", "OLD", "failed", "x", null)).toBe(false);
    expect(getSyncRow("4003")).toMatchObject({ status: "syncing", claimId: "NEW", lastValue: null });
  });
});

describe("backfill", () => {
  it("מסמן את כל הפריטים עם מקטעים סגורים (למקרה שהדגל היה כבוי)", () => {
    db.prepare(`DELETE FROM task_timer_sync`).run();
    const n = backfillTaskTimerSync();
    expect(n).toBeGreaterThan(5);
    expect(getSyncRow("1001")?.status).toBe("dirty");
    expect(getSyncRow("900")).not.toBeNull(); // גם מקטע שנעצר בזמן שהדגל כבוי
  });
});
