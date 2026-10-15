/**
 * computeOfficeOverviewPerfRecords (chat.ts) — פונקציה טהורה שמחליטה אם מדידת ה-cache הגלובלית
 * (OfficeStateDiagnostics/ReverseDependencyMapDiagnostics) ניתנת לשיוך בבטחה לקריאת office_overview
 * הנוכחית, או שמישהו אחר (בקשה מקבילה אחרת/המתזמן/getEmployeeDashboard) נגע ב-cache באותו חלון —
 * ואז יש לסמן "unreliable" במקום להציג מספר שעלול להיות שגוי כמדויק (ר' docstring מעל הפונקציה).
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
import type { ReverseDependencyMapDiagnostics } from "../../src/integrations/monday/opsRead.js";

function office(hits: number, joined: number, fetched: number, lastFetch: OfficeStateDiagnostics["lastFetch"] = null): OfficeStateDiagnostics {
  return { hits, joinedInFlight: joined, fetched, lastFetch };
}
function rd(hits: number, joined: number, fetched: number, lastFetchMs: number | null = null): ReverseDependencyMapDiagnostics {
  return { hits, joinedInFlight: joined, fetched, lastFetchMs };
}

describe("computeOfficeOverviewPerfRecords — בסיס", () => {
  it("EXPECTED_OFFICE_STATE_CALLS הוא 2 (runControlScan+getOversightReport)", () => {
    expect(EXPECTED_OFFICE_STATE_CALLS).toBe(2);
  });

  it("שני hits (cache חם לשני הקוראים) — delta=2, אמין, בלי fetch breakdown", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(2, 0, 0),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(0, 0, 0),
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toEqual([
      { name: "office_state_cache:hits=2,joined=0,fetched=0", durationMs: 0, ok: true },
      { name: "reverse_dep_map_cache:hits=0,joined=0,fetched=0", durationMs: 0, ok: true },
    ]);
  });

  it("fetch אחד + join אחד (cache קר, single-flight עבד) — delta=2, אמין, עם fetch breakdown מלא", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(0, 1, 1, { reverseDepsMs: 18500, activeProjectsMs: 420, userTasksMs: 3200, totalMs: 19000, generation: 7 }),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(0, 0, 1, 18100),
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toEqual([
      { name: "office_state_cache:hits=0,joined=1,fetched=1", durationMs: 0, ok: true },
      { name: "office_state_fetch:reverse_deps_wait", durationMs: 18500, ok: true },
      { name: "office_state_fetch:active_projects", durationMs: 420, ok: true },
      { name: "office_state_fetch:user_tasks", durationMs: 3200, ok: true },
      { name: "reverse_dep_map_cache:hits=0,joined=0,fetched=1", durationMs: 18100, ok: true },
    ]);
  });
});

describe("computeOfficeOverviewPerfRecords — זיהוי זיהום (audit)", () => {
  it("delta גבוה מהצפוי (3 במקום 2) — בקשה/מתזמן אחר נגע ב-getOfficeState במקביל → unreliable, בלי lastFetch", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(2, 0, 1, { reverseDepsMs: 999, activeProjectsMs: 999, userTasksMs: 999, totalMs: 999, generation: 1 }),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(0, 0, 1, 999),
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
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toEqual([{ name: "office_state_cache:unreliable(total=1,expected=2)", durationMs: 0, ok: true }]);
  });

  it("officeState אמין (2) אבל reverse_dep_map זוהם (getEmployeeDashboard מקביל קרא לו גם) → office מדווח, rd מסומן unreliable", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(0, 1, 1, { reverseDepsMs: 100, activeProjectsMs: 50, userTasksMs: 200, totalMs: 300, generation: 2 }),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(1, 0, 1, 90), // ציפייה: fetched=1 בלבד (officeFetched=1), בפועל total=2 — קורא עצמאי התערב
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toEqual([
      { name: "office_state_cache:hits=0,joined=1,fetched=1", durationMs: 0, ok: true },
      { name: "office_state_fetch:reverse_deps_wait", durationMs: 100, ok: true },
      { name: "office_state_fetch:active_projects", durationMs: 50, ok: true },
      { name: "office_state_fetch:user_tasks", durationMs: 200, ok: true },
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
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    expect(recs).toEqual([{ name: "office_state_cache:unreliable(total=4,expected=2)", durationMs: 0, ok: true }]);
  });
});

describe("computeOfficeOverviewPerfRecords — הגנות קצה", () => {
  it("officeFetched>0 אבל lastFetch חסר (הגנתי, לא אמור לקרות) — לא קורס, לא דוחף fetch breakdown", () => {
    const snap: OfficeOverviewDiagnosticSnapshot = {
      before: office(0, 0, 0),
      after: office(1, 0, 1, null),
      beforeRd: rd(0, 0, 0),
      afterRd: rd(0, 0, 1, 50),
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
    };
    const recs = computeOfficeOverviewPerfRecords(snap);
    const rdRecord = recs.find((r) => r.name.startsWith("reverse_dep_map_cache:hits="));
    expect(rdRecord?.durationMs).toBe(0); // לא 12345 — זה lastFetchMs של משהו אחר, לא שלנו
  });
});
