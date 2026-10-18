/**
 * person_status — פירוק מלא לפי פרויקטים (2026-10-18).
 *
 * בדיקות על הפונקציות הטהורות (buildPersonProjectBreakdown/matchPersonProjects/
 * buildPersonProjectDrilldown) בלבד — בלי Monday/AI, בלי getOfficeState אמיתי. הפוקוס: סכימה
 * נכונה (בלי ספירה כפולה), שיוך נכון לפרויקט (projectId קודם, context כ-fallback), דלי "ללא
 * פרויקט" נפרד, סינון/drill-down לפרויקט בודד, וחיתוך-מפורש (לא "מלא" כש-זה לא).
 */

import { describe, expect, it } from "vitest";
import {
  buildPersonProjectBreakdown,
  buildPersonProjectDrilldown,
  matchPersonProjects,
  PERSON_BYPROJECT_CAP,
} from "../../src/ops/chat.js";
import type { DashboardTask, TaskFlags } from "../../src/ops/dashboard.js";

const baseFlags: TaskFlags = {
  overdue: false,
  daysOverdue: 0,
  dueToday: false,
  dueThisWeek: false,
  stuck: false,
  critical: false,
  waitingExternal: false,
  blocking: [],
};

let seq = 0;
function task(overrides: Partial<DashboardTask> & { flags?: Partial<TaskFlags> }): DashboardTask {
  seq++;
  const { flags, ...rest } = overrides;
  return {
    source: "project_stage",
    itemId: `item-${seq}`,
    name: `משימה ${seq}`,
    url: `https://example/${seq}`,
    context: "פרויקט לדוגמה",
    status: "לביצוע",
    assignees: "איתן ברמן",
    ...rest,
    flags: { ...baseFlags, ...flags },
  };
}

function blockingRef(n = 1) {
  return Array.from({ length: n }, (_, i) => ({ itemId: `blk-${i}`, name: `חוסם ${i}` })) as TaskFlags["blocking"];
}

describe("buildPersonProjectBreakdown — ספירה מלאה, בלי כפילות", () => {
  it("סכום open על פני byProject+withoutProject שווה בדיוק למספר המשימות הכולל", () => {
    const tasks = [
      task({ projectId: "p1", context: "אויירבך" }),
      task({ projectId: "p1", context: "אויירבך", flags: { overdue: true, daysOverdue: 5 } }),
      task({ projectId: "p2", context: "שוורץ יוסף", flags: { blocking: blockingRef(2) } }),
      task({ source: "general", context: "משימת משרד", projectId: undefined }),
      task({ source: "project_stage", context: "פרויקט לא מקושר", projectId: undefined }),
    ];
    const b = buildPersonProjectBreakdown(tasks);
    const sumByProject = b.byProject.reduce((s, p) => s + p.open, 0);
    expect(sumByProject + b.withoutProject.open).toBe(tasks.length);
    expect(b.byProject.reduce((s, p) => s + p.open, 0) + b.withoutProject.open).toBe(5);
  });

  it("כל קטגוריה (overdue/stuck/blocking/dueToday) נספרת נכון, בלי לדרוס אחת את השנייה", () => {
    const tasks = [
      task({ projectId: "p1", flags: { overdue: true, daysOverdue: 3 } }),
      task({ projectId: "p1", flags: { stuck: true } }),
      task({ projectId: "p1", flags: { blocking: blockingRef(1) } }),
      task({ projectId: "p1", flags: { dueToday: true } }),
      task({ projectId: "p1" }), // "נקייה" — לא נכנסת לשום קטגוריה חוץ מ-open
    ];
    const b = buildPersonProjectBreakdown(tasks);
    const p1 = b.byProject.find((p) => p.projectId === "p1")!;
    expect(p1).toMatchObject({ open: 5, overdue: 1, stuck: 1, blocking: 1, dueToday: 1 });
  });

  it("שיוך לפי projectId קודם ל-context — שתי משימות עם אותו projectId אבל context שונה (data drift) נכנסות לאותו דלי", () => {
    const tasks = [
      task({ projectId: "p1", context: "שם ישן" }),
      task({ projectId: "p1", context: "שם מעודכן" }),
    ];
    const b = buildPersonProjectBreakdown(tasks);
    expect(b.byProject).toHaveLength(1);
    expect(b.byProject[0]!.open).toBe(2);
  });

  it("בלי projectId אבל עם context אמיתי (לא סנטינל) — עדיין נכנס ל-byProject, מקובץ לפי context", () => {
    const tasks = [
      task({ projectId: undefined, context: "פרויקט בלי id" }),
      task({ projectId: undefined, context: "פרויקט בלי id" }),
    ];
    const b = buildPersonProjectBreakdown(tasks);
    expect(b.byProject).toHaveLength(1);
    expect(b.byProject[0]!.open).toBe(2);
    expect(b.withoutProject.open).toBe(0);
  });

  it("דלי 'ללא פרויקט' נפרד — לא עוד שורה ב-byProject", () => {
    const tasks = [
      task({ source: "general", context: "משימת משרד", projectId: undefined, flags: { overdue: true, daysOverdue: 1 } }),
      task({ source: "project_stage", context: "פרויקט לא מקושר", projectId: undefined, flags: { stuck: true } }),
      task({ projectId: "p1", context: "פרויקט אמיתי" }),
    ];
    const b = buildPersonProjectBreakdown(tasks);
    expect(b.byProject.map((p) => p.project)).toEqual(["פרויקט אמיתי"]);
    expect(b.withoutProject).toEqual({ open: 2, overdue: 1, stuck: 1, blocking: 0, dueToday: 0 });
  });

  it("חיתוך מפורש: יותר מ-PERSON_BYPROJECT_CAP פרויקטים → byProjectTruncated=true, totalProjects מדויק", () => {
    const n = PERSON_BYPROJECT_CAP + 5;
    const tasks = Array.from({ length: n }, (_, i) => task({ projectId: `p${i}`, context: `פרויקט ${i}` }));
    const b = buildPersonProjectBreakdown(tasks);
    expect(b.byProject.length).toBe(PERSON_BYPROJECT_CAP);
    expect(b.byProjectTruncated).toBe(true);
    expect(b.totalProjects).toBe(n);
  });

  it("בלי חיתוך (מתחת לסף) — byProjectTruncated=false ו-totalProjects=byProject.length", () => {
    const tasks = [task({ projectId: "p1" }), task({ projectId: "p2" })];
    const b = buildPersonProjectBreakdown(tasks);
    expect(b.byProjectTruncated).toBe(false);
    expect(b.totalProjects).toBe(b.byProject.length);
  });

  it("רשימה ריקה — לא קורס, הכל אפסים", () => {
    const b = buildPersonProjectBreakdown([]);
    expect(b.byProject).toEqual([]);
    expect(b.byProjectTruncated).toBe(false);
    expect(b.totalProjects).toBe(0);
    expect(b.withoutProject).toEqual({ open: 0, overdue: 0, stuck: 0, blocking: 0, dueToday: 0 });
  });

  /**
   * audit טרום-פריסה (2026-10-18): הבדיקות למעלה הוכיחו כיסוי מלא בלי כפילות עבור `open` בלבד.
   * הבדיקה הזו מוכיחה את אותו דבר על פני *כל* הקטגוריות (overdue/stuck/blocking/dueToday) יחד,
   * עם דאטה מפוזר על כמה פרויקטים + דלי "ללא פרויקט" — בדיוק דרישה #2.
   */
  it("כיסוי מלא בלי כפילות על פני *כל* הקטגוריות (לא רק open), עם כמה פרויקטים + ללא-פרויקט", () => {
    const tasks = [
      task({ projectId: "p1", flags: { overdue: true, daysOverdue: 1 } }),
      task({ projectId: "p1", flags: { stuck: true } }),
      task({ projectId: "p2", flags: { blocking: blockingRef(1), overdue: true, daysOverdue: 2 } }),
      task({ projectId: "p2", flags: { dueToday: true } }),
      task({ source: "general", context: "משימת משרד", projectId: undefined, flags: { overdue: true, daysOverdue: 3 } }),
      task({ source: "project_stage", context: "פרויקט לא מקושר", projectId: undefined, flags: { stuck: true, dueToday: true } }),
      task({ projectId: "p1" }),
    ];
    const b = buildPersonProjectBreakdown(tasks);
    const buckets = [...b.byProject, b.withoutProject];
    const sum = (key: "open" | "overdue" | "stuck" | "blocking" | "dueToday") =>
      buckets.reduce((s, x) => s + x[key], 0);

    for (const key of ["open", "overdue", "stuck", "blocking", "dueToday"] as const) {
      const expected = tasks.filter((t) => {
        if (key === "open") return true;
        if (key === "overdue") return t.flags.overdue;
        if (key === "stuck") return t.flags.stuck;
        if (key === "blocking") return t.flags.blocking.length > 0;
        return t.flags.dueToday;
      }).length;
      expect(sum(key)).toBe(expected);
    }
    expect(sum("open")).toBe(tasks.length);
  });
});

describe("matchPersonProjects — חיפוש בין buckets מחושבים (לא tasks גולמיים)", () => {
  const tasks = [
    task({ projectId: "p1", context: "אויירבך משה מגרש 302" }),
    task({ projectId: "p2", context: "שוורץ יוסף מגרש 302" }),
    task({ source: "general", context: "משימת משרד", projectId: undefined }),
  ];
  const byProject = buildPersonProjectBreakdown(tasks).byProject;

  it("התאמה חלקית, case-insensitive", () => {
    expect(matchPersonProjects(byProject, "אויירבך").map((m) => m.project)).toEqual(["אויירבך משה מגרש 302"]);
  });
  it("לא מחפש בתוך דלי 'ללא פרויקט' (לא נכלל ב-byProject כלל)", () => {
    expect(matchPersonProjects(byProject, "משרד")).toEqual([]);
  });
  it("תווית מתאימה לכמה פרויקטים (שתיהן 'מגרש 302') מחזירה את שתיהן — הקורא מחליט על עמימות", () => {
    expect(matchPersonProjects(byProject, "מגרש 302").map((m) => m.project).sort()).toEqual(
      ["אויירבך משה מגרש 302", "שוורץ יוסף מגרש 302"].sort(),
    );
  });
  it("שאילתה ריקה → []", () => {
    expect(matchPersonProjects(byProject, "")).toEqual([]);
  });
  it("אין התאמה → []", () => {
    expect(matchPersonProjects(byProject, "לא קיים בכלל")).toEqual([]);
  });

  /**
   * audit טרום-פריסה (2026-10-18) — הממצא המרכזי: שני פרויקטים *שונים* (projectId שונה) יכולים
   * לחלוק שם תצוגה זהה (שגיאת הקלדה/כפילות אמיתית ב-Monday). matchPersonProjects חייב להחזיר
   * אותם כשתי התאמות נפרדות (לא למזג) — כדי ש-buildPersonProjectDrilldown בהמשך לא יערבב משימות
   * משני פרויקטים שונים לתוך תשובה אחת (ר' הבדיקה הבאה ב-buildPersonProjectDrilldown).
   */
  it("שני byProject buckets עם שם זהה אבל projectId שונה — שתי התאמות נפרדות, לא אחת (ללא מיזוג)", () => {
    const collidingTasks = [
      task({ projectId: "real-p1", context: "פרויקט כפול" }),
      task({ projectId: "real-p2", context: "פרויקט כפול" }),
    ];
    const collidingByProject = buildPersonProjectBreakdown(collidingTasks).byProject;
    expect(collidingByProject).toHaveLength(2); // שני buckets, לא אחד — ההוכחה שהאגרגציה לא מיזגה
    const matches = matchPersonProjects(collidingByProject, "כפול");
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((m) => m.projectId))).toEqual(new Set(["real-p1", "real-p2"]));
  });
});

describe("buildPersonProjectDrilldown — פירוט משימות בפרויקט ספציפי", () => {
  it("מחזיר רק את המשימות של הפרויקט המבוקש, עם שם/שלב/תאריך/סטטוסים", () => {
    const tasks = [
      task({
        projectId: "p1",
        context: "אויירבך",
        name: "לבדוק תכניות",
        stageName: "שלב 3",
        dueDate: "2026-10-01",
        status: "תקוע",
        priority: "קריטי",
        flags: { overdue: true, daysOverdue: 10, stuck: true, blocking: blockingRef(2) },
      }),
      task({ projectId: "p2", context: "שוורץ יוסף" }), // לא אמור להופיע
    ];
    const breakdown = buildPersonProjectBreakdown(tasks);
    const target = breakdown.byProject.find((p) => p.projectId === "p1")!;
    const d = buildPersonProjectDrilldown(tasks, target);
    expect(d.tasks).toHaveLength(1);
    expect(d.totalMatching).toBe(1);
    expect(d.truncated).toBe(false);
    expect(d.tasks[0]).toMatchObject({
      name: "לבדוק תכניות",
      stageName: "שלב 3",
      dueDate: "2026-10-01",
      status: "תקוע",
      priority: "קריטי",
      overdue: true,
      daysOverdue: 10,
      stuck: true,
      blockingCount: 2,
    });
  });

  it("פרויקט בלי התאמות (target שלא קיים בפועל ב-tasks) — tasks ריק, totalMatching=0", () => {
    const d = buildPersonProjectDrilldown([task({ projectId: "p1", context: "אויירבך" })], {
      project: "לא קיים",
      projectId: "no-such-id",
      open: 0,
      overdue: 0,
      stuck: 0,
      blocking: 0,
      dueToday: 0,
    });
    expect(d.tasks).toEqual([]);
    expect(d.totalMatching).toBe(0);
  });

  it("חיתוך מפורש: יותר מ-PERSON_BYPROJECT_CAP משימות באותו פרויקט → truncated=true, totalMatching מדויק", () => {
    const n = PERSON_BYPROJECT_CAP + 3;
    const tasks = Array.from({ length: n }, () => task({ projectId: "p1", context: "פרויקט גדול" }));
    const target = buildPersonProjectBreakdown(tasks).byProject[0]!;
    const d = buildPersonProjectDrilldown(tasks, target);
    expect(d.tasks.length).toBe(PERSON_BYPROJECT_CAP);
    expect(d.truncated).toBe(true);
    expect(d.totalMatching).toBe(n);
  });

  it("לא מחזיר משימות 'ללא פרויקט' גם אם target.project שווה בטעות לסנטינל", () => {
    const tasks = [task({ source: "general", context: "משימת משרד", projectId: undefined })];
    const d = buildPersonProjectDrilldown(tasks, {
      project: "משימת משרד",
      open: 0,
      overdue: 0,
      stuck: 0,
      blocking: 0,
      dueToday: 0,
    });
    expect(d.tasks).toEqual([]);
    expect(d.totalMatching).toBe(0);
  });

  /**
   * ההוכחה הישירה לממצא המרכזי: שני פרויקטים *שונים* עם שם תצוגה זהה — דריל-דאון על ה-target
   * הנכון (עם projectId) מחזיר רק את המשימות של *אותו* projectId, לא את שתי הקבוצות ממוזגות.
   */
  it("שני פרויקטים עם שם זהה, projectId שונה — דריל-דאון על אחד מהם לא מחזיר משימות של האחר", () => {
    const tasks = [
      task({ projectId: "real-p1", context: "פרויקט כפול", name: "משימה בפרויקט הראשון" }),
      task({ projectId: "real-p2", context: "פרויקט כפול", name: "משימה בפרויקט השני" }),
    ];
    const byProject = buildPersonProjectBreakdown(tasks).byProject;
    const target1 = byProject.find((p) => p.projectId === "real-p1")!;
    const d1 = buildPersonProjectDrilldown(tasks, target1);
    expect(d1.tasks).toHaveLength(1);
    expect(d1.tasks[0]!.name).toBe("משימה בפרויקט הראשון");
    expect(d1.totalMatching).toBe(1); // לא 2 — לא זלגה משימה מהפרויקט האחר
  });
});
