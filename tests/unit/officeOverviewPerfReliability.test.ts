/**
 * computeOfficeOverviewPerfRecords (chat.ts) — פונקציה טהורה שמחליטה אם מדידת ה-cache הגלובלית
 * (OfficeStateDiagnostics/ReverseDependencyMapDiagnostics/UserTasksFetchStep) ניתנת לשיוך בבטחה
 * לקריאת office_overview הנוכחית, או שמישהו אחר (בקשה מקבילה אחרת/המתזמן/getEmployeeDashboard)
 * נגע ב-cache באותו חלון — ואז יש לסמן "unreliable" במקום להציג מספר שעלול להיות שגוי כמדויק
 * (ר' docstring מעל הפונקציה).
 *
 * אין Monday/AI/DB כאן בכלל — רק אובייקטי diagnostics מדומים, בדיקת לוגיקה טהורה.
 */
import { describe, expect, it } from "vitest";
import {
  computeOfficeOverviewPerfRecords,
  EXPECTED_OFFICE_STATE_CALLS,
  type OfficeOverviewDiagnosticSnapshot,
} from "../../src/ops/chat.js";
import type { OfficeStateDiagnostics } from "../../src/ops/officeState.js";
import type { ReverseDependencyMapDiagnostics, UserTasksFetchStep } from "../../src/integrations/monday/opsRead.js";

function office(
  hits: number,
  joined: number,
  fetched: number,
  lastFetchValue: NonNullable<OfficeStateDiagnostics["lastFetch"]> | null = null,
): OfficeStateDiagnostics {
  return { hits, joinedInFlight: joined, fetched, lastFetch: lastFetchValue };
}
function rd(hits: number, joined: number, fetched: number, lastFetchMs: number | null = null): ReverseDependencyMapDiagnostics {
  return { hits, joinedInFlight: joined, fetched, lastFetchMs };
}
function lastFetch(
  reverseDepsMs: number,
  activeProjectsMs: number,
  userTasksMs: number,
  generation: number,
  memberCount: number,
): NonNullable<OfficeStateDiagnostics["lastFetch"]> {
  return { reverseDepsMs, activeProjectsMs, userTasksMs, totalMs: reverseDepsMs + userTasksMs, generation, memberCount };
}
function step(teamIndex: number, source: "general" | "project_stage", pages: number, items: number, durationMs: number): UserTasksFetchStep {
  return { teamIndex, source, pages, items, durationMs };
}

describe("computeOfficeOverviewPerfRecords — בסיס", () => {
  it("EXPECTED_OFFICE_STATE_CALLS הוא 2 (runControlScan+getOversightReport)", () => {
    expect(EXPECTED_OFFICE_STATE_CALLS).toBe(2);
  });

  it("שני hits (cache חם לשני הקוראים) — delta=2, אמין, בלי fetch breakdown ובלי user_tasks_fetch", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(2, 0, 0),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(0, 0, 0),
      userTasksSteps: [],
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toEqual([
      { name: "office_state_cache:hits=2,joined=0,fetched=0", durationMs: 0, ok: true },
      { name: "reverse_dep_map_cache:hits=0,joined=0,fetched=0", durationMs: 0, ok: true },
    ]);
  });

  it("fetch אחד + join אחד (cache קר, single-flight עבד) — delta=2, אמין, עם fetch breakdown מלא + user_tasks_fetch פר-חבר/מקור", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(0, 1, 1, lastFetch(18500, 420, 3200, 7, 2)),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(0, 0, 1, 18100),
      userTasksSteps: [step(0, "general", 1, 12, 1500), step(0, "project_stage", 1, 3, 1700), step(1, "general", 2, 310, 2900), step(1, "project_stage", 1, 8, 300)],
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toEqual([
      { name: "office_state_cache:hits=0,joined=1,fetched=1", durationMs: 0, ok: true },
      { name: "office_state_fetch:reverse_deps_wait", durationMs: 18500, ok: true },
      { name: "office_state_fetch:active_projects", durationMs: 420, ok: true },
      { name: "office_state_fetch:user_tasks", durationMs: 3200, ok: true },
      { name: "user_tasks_fetch:idx=0,source=general,pages=1,items=12", durationMs: 1500, ok: true },
      { name: "user_tasks_fetch:idx=0,source=project_stage,pages=1,items=3", durationMs: 1700, ok: true },
      { name: "user_tasks_fetch:idx=1,source=general,pages=2,items=310", durationMs: 2900, ok: true },
      { name: "user_tasks_fetch:idx=1,source=project_stage,pages=1,items=8", durationMs: 300, ok: true },
      { name: "reverse_dep_map_cache:hits=0,joined=0,fetched=1", durationMs: 18100, ok: true },
    ]);
  });
});

describe("computeOfficeOverviewPerfRecords — זיהוי pagination (audit 2026-10-15)", () => {
  it("מספר עמודים>1 נראה בפירוק — idx=1,general עם pages=2 מעיד על pagination אצל אותו חבר", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(0, 1, 1, lastFetch(100, 50, 13000, 3, 1)),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(0, 0, 1, 90),
      userTasksSteps: [step(0, "general", 3, 620, 9500), step(0, "project_stage", 1, 4, 300)],
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    const generalStep = recs.find((r) => r.name.includes("source=general"));
    expect(generalStep).toEqual({ name: "user_tasks_fetch:idx=0,source=general,pages=3,items=620", durationMs: 9500, ok: true });
  });

  it("מספר שלבים לא תואם לציפייה (memberCount×2) — unreliable, לא פירוק חלקי כאילו מלא", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(0, 1, 1, lastFetch(100, 50, 300, 2, 2)), // memberCount=2 → צפוי 4 שלבים
      beforeRd: rd(0, 0, 0),
      afterRd: rd(0, 0, 1, 90),
      userTasksSteps: [step(0, "general", 1, 10, 100), step(0, "project_stage", 1, 2, 50), step(1, "general", 1, 5, 80)], // רק 3, לא 4
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toContainEqual({ name: "user_tasks_fetch:unreliable(count=3,expected=4)", durationMs: 0, ok: true });
    expect(recs.some((r) => r.name.startsWith("user_tasks_fetch:idx="))).toBe(false); // לא פירוק חלקי
  });

  it("officeState עצמו לא אמין — לא מגיעים בכלל לבדיקת user_tasks_fetch", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(2, 0, 1, lastFetch(999, 999, 999, 1, 2)),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(0, 0, 1, 999),
      userTasksSteps: [step(0, "general", 1, 1, 1), step(0, "project_stage", 1, 1, 1), step(1, "general", 1, 1, 1), step(1, "project_stage", 1, 1, 1)],
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toEqual([{ name: "office_state_cache:unreliable(total=3,expected=2)", durationMs: 0, ok: true }]);
  });
});

describe("computeOfficeOverviewPerfRecords — זיהוי זיהום (audit)", () => {
  it("delta גבוה מהצפוי (3 במקום 2) — בקשה/מתזמן אחר נגע ב-getOfficeState במקביל → unreliable, בלי lastFetch", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(2, 0, 1, lastFetch(999, 999, 999, 1, 1)),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(0, 0, 1, 999),
      userTasksSteps: [],
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toEqual([{ name: "office_state_cache:unreliable(total=3,expected=2)", durationMs: 0, ok: true }]);
  });

  it("delta נמוך מהצפוי (1 במקום 2) — גם זה מסומן unreliable (לא רק 'גבוה מהצפוי')", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(1, 0, 0),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(0, 0, 0),
      userTasksSteps: [],
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toEqual([{ name: "office_state_cache:unreliable(total=1,expected=2)", durationMs: 0, ok: true }]);
  });

  it("officeState אמין (2) אבל reverse_dep_map זוהם (getEmployeeDashboard מקביל קרא לו גם) → office מדווח, rd מסומן unreliable", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(0, 1, 1, lastFetch(100, 50, 200, 2, 1)),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(1, 0, 1, 90), // ציפייה: fetched=1 בלבד (officeFetched=1), בפועל total=2 — קורא עצמאי התערב
      userTasksSteps: [step(0, "general", 1, 1, 100), step(0, "project_stage", 1, 1, 100)],
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toEqual([
      { name: "office_state_cache:hits=0,joined=1,fetched=1", durationMs: 0, ok: true },
      { name: "office_state_fetch:reverse_deps_wait", durationMs: 100, ok: true },
      { name: "office_state_fetch:active_projects", durationMs: 50, ok: true },
      { name: "office_state_fetch:user_tasks", durationMs: 200, ok: true },
      { name: "user_tasks_fetch:idx=0,source=general,pages=1,items=1", durationMs: 100, ok: true },
      { name: "user_tasks_fetch:idx=0,source=project_stage,pages=1,items=1", durationMs: 100, ok: true },
      { name: "reverse_dep_map_cache:unreliable(total=2,expected=1)", durationMs: 0, ok: true },
    ]);
  });

  it("שני office_overview מקבילים (שני משתמשים) — כל אחד רואה delta=4 (2+2), שניהם מסמנים unreliable", () => {
    // מדמה מה שקריאה אחת "תראה" אם קריאה מקבילה שנייה תרמה גם היא 2 — לא ניתן לדעת מי גרם למה.
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(2, 2, 0),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(0, 0, 0),
      userTasksSteps: [],
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toEqual([{ name: "office_state_cache:unreliable(total=4,expected=2)", durationMs: 0, ok: true }]);
  });
});

describe("computeOfficeOverviewPerfRecords — הגנות קצה", () => {
  it("officeFetched>0 אבל lastFetch חסר (הגנתי, לא אמור לקרות) — לא קורס, לא דוחף fetch breakdown/user_tasks_fetch", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(1, 0, 1, null),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(0, 0, 1, 50),
      userTasksSteps: [step(0, "general", 1, 1, 1)], // לא אמור להגיע כלל לשימוש — lastFetch חסר
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toEqual([
      { name: "office_state_cache:hits=1,joined=0,fetched=1", durationMs: 0, ok: true },
      { name: "reverse_dep_map_cache:hits=0,joined=0,fetched=1", durationMs: 50, ok: true },
    ]);
  });

  it("rdFetched=0 — durationMs מדווח כ-0, לא lastFetchMs ישן/לא-קשור", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(2, 0, 0),
      beforeRd: rd(1, 0, 1), // lastFetchMs ישן קיים מ"קודם"
      afterRd: rd(1, 0, 1, 12345), // אין delta (hits+1-1=0 וכו') — reliable, אבל fetched delta=0
      userTasksSteps: [],
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    const rdRecord = recs.find((r) => r.name.startsWith("reverse_dep_map_cache:hits="));
    expect(rdRecord?.durationMs).toBe(0); // לא 12345 — זה lastFetchMs של משהו אחר, לא שלנו
  });
});
