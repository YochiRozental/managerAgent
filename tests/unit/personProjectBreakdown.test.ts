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
  buildPersonFullDetail,
  buildPersonProjectBreakdown,
  buildPersonProjectDrilldown,
  matchPersonProjects,
  PERSON_BYPROJECT_CAP,
  PERSON_FULL_DETAIL_CAP,
  resolveProjectByIndex,
  type PersonProjectBreakdown,
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

  /**
   * audit בקשות-המשך (2026-10-18) — נרמול רווחים (דרישה 3): שם הפרויקט ב-Monday עצמו יכול לכלול
   * רווח כפול (דאטה אמיתי), או שהמודל מקליד שאילתה עם רווח יחיד/כפול שלא תואם בדיוק. **לא**
   * fuzzy-matching — רק רצפי-whitespace, לא שגיאות-כתיב (ר' הבדיקה הבאה).
   */
  it("רווח כפול בשם הפרויקט עצמו (ב-Monday) — עדיין נמצא עם שאילתה ברווח יחיד", () => {
    const withDoubleSpace = buildPersonProjectBreakdown([
      task({ projectId: "p9", context: "אויירבך  משה מגרש 302" }), // רווח כפול בין "אויירבך" ל-"משה"
    ]).byProject;
    expect(matchPersonProjects(withDoubleSpace, "אויירבך משה")).toHaveLength(1);
  });

  it("רווח כפול בשאילתה — עדיין נמצא כש-שם הפרויקט ברווח יחיד", () => {
    expect(matchPersonProjects(byProject, "אויירבך  משה")).toEqual(
      matchPersonProjects(byProject, "אויירבך משה"),
    );
  });

  it("שגיאת-כתיב אמיתית (לא רווח) — לא נמצא, בכוונה: אין fuzzy-matching שעלול לערבב פרויקטים", () => {
    const withTypo = buildPersonProjectBreakdown([task({ projectId: "p9", context: "אויירבך משה מגרש 302 המשבה" })]).byProject;
    expect(matchPersonProjects(withTypo, "המושבה")).toEqual([]); // "המשבה" (בדאטה) != "המושבה" (בשאילתה) — זה תקין, לא באג
  });
});

describe("resolveProjectByIndex — בקשת-המשך לפי מיקום ('הראשון/השני/האחרון ברשימה')", () => {
  const ordered: PersonProjectBreakdown[] = [
    { project: "פרויקט א", projectId: "a", open: 5, overdue: 3, stuck: 1, blocking: 0, dueToday: 0 },
    { project: "פרויקט ב", projectId: "b", open: 4, overdue: 2, stuck: 0, blocking: 0, dueToday: 0 },
    { project: "פרויקט ג", projectId: "c", open: 2, overdue: 1, stuck: 0, blocking: 0, dueToday: 0 },
  ];

  it("1 → הראשון ברשימה", () => {
    const r = resolveProjectByIndex(ordered, 1);
    expect(r).toMatchObject({ ok: true, project: { projectId: "a" } });
  });
  it("2 → השני", () => {
    expect(resolveProjectByIndex(ordered, 2)).toMatchObject({ ok: true, project: { projectId: "b" } });
  });
  it("-1 → האחרון ברשימה (סופר מהסוף, בלי שהמודל יצטרך לדעת totalProjects)", () => {
    expect(resolveProjectByIndex(ordered, -1)).toMatchObject({ ok: true, project: { projectId: "c" } });
  });
  it("-2 → לפני-אחרון", () => {
    expect(resolveProjectByIndex(ordered, -2)).toMatchObject({ ok: true, project: { projectId: "b" } });
  });
  it("0 → out_of_range (אין מיקום 0, לא 1-based ולא תקין)", () => {
    expect(resolveProjectByIndex(ordered, 0)).toMatchObject({ ok: false, reason: "out_of_range" });
  });
  it("מיקום גדול מהרשימה → out_of_range", () => {
    expect(resolveProjectByIndex(ordered, 99)).toMatchObject({ ok: false, reason: "out_of_range" });
  });
  it("מיקום שלילי גדול מהרשימה (לפני ההתחלה) → out_of_range", () => {
    expect(resolveProjectByIndex(ordered, -99)).toMatchObject({ ok: false, reason: "out_of_range" });
  });
  it("אינדקס לא שלם (לדוגמה 1.5) → out_of_range, לא מתעגל בשקט", () => {
    expect(resolveProjectByIndex(ordered, 1.5)).toMatchObject({ ok: false, reason: "out_of_range" });
  });
  it("רשימה ריקה → out_of_range לכל מיקום", () => {
    expect(resolveProjectByIndex([], 1)).toMatchObject({ ok: false, reason: "out_of_range" });
  });

  /**
   * ההוכחה המרכזית לדרישה 1 ("אם אי אפשר להבטיח — אל תנחש, החזר הבהרה"): שני פרויקטים עם ערכי
   * (overdue,stuck,open) זהים — הסדר היחסי ביניהם לא מובטח-לפי-ערך בין שתי קריאות fetch נפרדות
   * (תלוי בסדר ה-items מ-Monday). resolveProjectByIndex מזהה את זה ומסרב לנחש.
   */
  it("tie בערכים (overdue/stuck/open זהים) במיקום המבוקש → ambiguous_order, לא ניחוש", () => {
    const tied: PersonProjectBreakdown[] = [
      { project: "פרויקט X", projectId: "x", open: 3, overdue: 1, stuck: 0, blocking: 0, dueToday: 0 },
      { project: "פרויקט Y", projectId: "y", open: 3, overdue: 1, stuck: 0, blocking: 0, dueToday: 0 },
    ];
    const r = resolveProjectByIndex(tied, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ambiguous_order");
    expect(new Set(r.candidates!.map((c) => c.projectId))).toEqual(new Set(["x", "y"]));
  });

  it("tie קיים ברשימה אבל לא במיקום המבוקש — עדיין פותר דטרמיניסטית (ה-tie לא רלוונטי לשאלה)", () => {
    const mixedTies: PersonProjectBreakdown[] = [
      { project: "יחיד בראש", projectId: "solo", open: 9, overdue: 5, stuck: 0, blocking: 0, dueToday: 0 },
      { project: "תיקו 1", projectId: "t1", open: 1, overdue: 0, stuck: 0, blocking: 0, dueToday: 0 },
      { project: "תיקו 2", projectId: "t2", open: 1, overdue: 0, stuck: 0, blocking: 0, dueToday: 0 },
    ];
    expect(resolveProjectByIndex(mixedTies, 1)).toMatchObject({ ok: true, project: { projectId: "solo" } });
    expect(resolveProjectByIndex(mixedTies, 2)).toMatchObject({ ok: false, reason: "ambiguous_order" });
  });
});

describe("buildPersonFullDetail — פירוט משימות אמיתי לכל הפרויקטים בבת אחת ('תפרק לי את כל המשימות שלו')", () => {
  it("מחזיר משימות בפועל (לא רק counts) לכל פרויקט, בסדר byProject (הכי-חשוב קודם)", () => {
    const tasks = [
      task({ projectId: "p1", context: "פרויקט דחוף", name: "משימה א", flags: { overdue: true, daysOverdue: 5 } }),
      task({ projectId: "p2", context: "פרויקט רגיל", name: "משימה ב" }),
    ];
    const breakdown = buildPersonProjectBreakdown(tasks);
    const full = buildPersonFullDetail(tasks, breakdown.byProject);
    expect(full.projects).toHaveLength(2);
    expect(full.projects[0]!.project).toBe("פרויקט דחוף"); // overdue קודם — אותו סדר כמו byProject
    expect(full.projects[0]!.tasks).toHaveLength(1);
    expect(full.projects[0]!.tasks[0]).toMatchObject({ name: "משימה א" });
    expect(full.truncated).toBe(false);
  });

  it("totalProjects/tasksTotal תמיד מדויקים, גם בלי חיתוך", () => {
    const tasks = [task({ projectId: "p1" }), task({ projectId: "p1" }), task({ projectId: "p2" })];
    const breakdown = buildPersonProjectBreakdown(tasks);
    const full = buildPersonFullDetail(tasks, breakdown.byProject);
    expect(full.totalProjects).toBe(2);
    expect(full.tasksTotal).toBe(3);
    expect(full.tasksShown).toBe(3);
    expect(full.projectsShown).toBe(2);
  });

  it("רשימה ריקה — לא קורס, הכל אפסים, לא truncated", () => {
    const full = buildPersonFullDetail([], []);
    expect(full.projects).toEqual([]);
    expect(full.totalProjects).toBe(0);
    expect(full.tasksTotal).toBe(0);
    expect(full.truncated).toBe(false);
  });

  /**
   * דרישה 2: חיתוך-כולל חייב להיות מפורש (truncated=true + tasksShown/tasksTotal מדויקים),
   * לא "סיכום שקט" — בדיוק התקלה שהביאה לכל התיקון הזה. החיתוך בגבולות-פרויקט (לא מפרק פרויקט
   * לשניים), כדי שלא יוצג פרויקט "חצי" בלי האזהרה המתאימה.
   */
  it("חיתוך מפורש כש-סכום המשימות על פני כל הפרויקטים עובר את PERSON_FULL_DETAIL_CAP", () => {
    // כל פרויקט עם 30 משימות (מתחת לתקרת ה-40 של drilldown עצמו) — 6 פרויקטים = 180 > 150 (ה-cap)
    const perProject = 30;
    const projectCount = Math.ceil((PERSON_FULL_DETAIL_CAP + 10) / perProject);
    const tasks = Array.from({ length: projectCount }, (_, p) =>
      Array.from({ length: perProject }, () => task({ projectId: `p${p}`, context: `פרויקט ${p}` })),
    ).flat();
    const breakdown = buildPersonProjectBreakdown(tasks);
    const full = buildPersonFullDetail(tasks, breakdown.byProject);

    expect(full.truncated).toBe(true);
    expect(full.totalProjects).toBe(projectCount); // מדויק גם כש-truncated
    expect(full.tasksTotal).toBe(projectCount * perProject); // מדויק גם כש-truncated
    expect(full.tasksShown).toBeLessThanOrEqual(PERSON_FULL_DETAIL_CAP);
    expect(full.projectsShown).toBeLessThan(full.totalProjects); // לא כל הפרויקטים הוצגו
    // אין פרויקט "חצי" — כל פרויקט שהוצג, הוצג עם כל 30 המשימות שלו (מתחת לתקרת ה-drilldown)
    for (const p of full.projects) {
      expect(p.tasks.length).toBe(perProject);
      expect(p.taskListTruncated).toBe(false);
    }
  });

  it("פרויקט בודד שעובר את PERSON_BYPROJECT_CAP (40) שלו — taskListTruncated=true על אותו פרויקט", () => {
    const n = PERSON_BYPROJECT_CAP + 5;
    const tasks = Array.from({ length: n }, () => task({ projectId: "p1", context: "פרויקט גדול" }));
    const breakdown = buildPersonProjectBreakdown(tasks);
    const full = buildPersonFullDetail(tasks, breakdown.byProject);
    expect(full.projects).toHaveLength(1);
    expect(full.projects[0]!.taskListTruncated).toBe(true);
    expect(full.projects[0]!.tasks.length).toBe(PERSON_BYPROJECT_CAP);
    expect(full.truncated).toBe(true);
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
