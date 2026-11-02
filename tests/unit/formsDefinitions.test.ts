/**
 * טפסי יצירה בצ'אט — הגדרות, מילוי מראש וולידציה (פונקציות טהורות, בלי DB/Monday).
 */

import { describe, expect, it } from "vitest";
import { resolveUserByKey } from "../../src/identity/index.js";
import {
  buildPrefill,
  canUseForm,
  getFormDefinition,
  isValidPhone,
  toMondayPhone,
  normalizeAndValidate,
} from "../../src/ops/forms/definitions.js";

describe("buildPrefill", () => {
  it("משימה: stage מפורש → scope=stage; taskKind=project → project; בלי פרויקט → general", () => {
    expect(buildPrefill("task", { taskName: "להתקשר", project: "בלומינג", stage: "שלב 2" }).values).toMatchObject({
      taskName: "להתקשר",
      scope: "stage",
      project: "בלומינג",
      stage: "שלב 2",
    });
    expect(buildPrefill("task", { taskName: "x", project: "בלומינג", taskKind: "project" }).values.scope).toBe("project");
    expect(buildPrefill("task", { taskName: "x" }).values.scope).toBe("general");
  });

  it("משימה: פרויקט בלי מידע על סוג השיוך → scope נשאר ריק (לא מחליטים בשם המשתמש)", () => {
    const p = buildPrefill("task", { taskName: "x", project: "בלומינג" });
    expect(p.values.scope).toBeUndefined();
    expect(p.values.project).toBe("בלומינג");
  });

  it("תאריך לא תקין נזרק, ערך select לא חוקי נזרק, ערכים נחתכים ומנוקים", () => {
    const p = buildPrefill("task", { taskName: "  x  ", dueDate: "מחר", scope: "weird" });
    expect(p.values.taskName).toBe("x");
    expect(p.values.dueDate).toBeUndefined();
    expect(p.values.scope).toBe("general");
  });

  it("ליד: תאימות לשמות הישנים firstName/lastName/product", () => {
    const p = buildPrefill("lead", { firstName: "דנה", lastName: "כהן", product: "מעונות יום" });
    expect(p.values.contactName).toBe("דנה כהן");
    expect(p.values.projectType).toBe("מעונות יום");
  });

  it("קלט שאינו מחרוזת נזרק (אובייקט/מערך)", () => {
    expect(buildPrefill("commitment", { toWhom: { a: 1 }, what: ["x"] }).values).toEqual({});
  });
});

describe("normalizeAndValidate — ליד", () => {
  const def = getFormDefinition("lead");
  const ok = { contactName: "דנה כהן", phone: "050-1234567", projectName: "בית פרטי", projectType: "מעונות יום" };

  it("ארבעת שדות החובה נאכפים", () => {
    const r = normalizeAndValidate(def, {});
    expect(Object.keys(r.errors).sort()).toEqual(["contactName", "phone", "projectName", "projectType"]);
  });

  it("טלפון ומייל נבדקים; שדות רשות ריקים תקינים", () => {
    expect(normalizeAndValidate(def, ok).errors).toEqual({});
    expect(normalizeAndValidate(def, { ...ok, phone: "12" }).errors.phone).toBeTruthy();
    expect(normalizeAndValidate(def, { ...ok, email: "not-an-email" }).errors.email).toBeTruthy();
    expect(normalizeAndValidate(def, { ...ok, whatsapp: "abc" }).errors.whatsapp).toBeTruthy();
  });

  it('"אין" שונה משדה שלא מולא: none מסומן, והערך שהושאר בשדה נמחק', () => {
    const r = normalizeAndValidate(def, { ...ok, email: "a@b.co" }, { email: true });
    expect(r.none).toEqual({ email: true });
    expect(r.values.email).toBeUndefined();
    const unfilled = normalizeAndValidate(def, ok);
    expect(unfilled.none).toEqual({});
  });

  it('"אין" נתמך רק בשדות allowNone (לא בשם/טלפון)', () => {
    const r = normalizeAndValidate(def, { ...ok, phone: "" }, { phone: true });
    expect(r.errors.phone).toBe("שדה חובה");
  });
});

describe("normalizeAndValidate — משימה", () => {
  const def = getFormDefinition("task");

  it("project/stage חובה רק כשהם נראים לפי scope", () => {
    expect(normalizeAndValidate(def, { taskName: "x", scope: "general" }).errors).toEqual({});
    expect(normalizeAndValidate(def, { taskName: "x", scope: "project" }).errors).toEqual({ project: "שדה חובה" });
    expect(Object.keys(normalizeAndValidate(def, { taskName: "x", scope: "stage", project: "p" }).errors)).toEqual(["stage"]);
  });

  it("שדה מוסתר נזרק מהערכים (project עם scope=general)", () => {
    const r = normalizeAndValidate(def, { taskName: "x", scope: "general", project: "p", stage: "s" });
    expect(r.values.project).toBeUndefined();
    expect(r.values.stage).toBeUndefined();
  });

  it("scope לא חוקי ותאריך לא חוקי נדחים; שדות לא מוכרים נזרקים", () => {
    const r = normalizeAndValidate(def, { taskName: "x", scope: "zzz", dueDate: "2026-13-45", hacker: "1" });
    expect(r.errors.scope).toBeTruthy();
    expect(r.errors.dueDate).toBeTruthy();
    expect((r.values as Record<string, string>).hacker).toBeUndefined();
  });
});

describe("הרשאות פתיחה ואכיפת הכבוי של טופס הליד", () => {
  it("planner: משימה והתחייבות כן; שלב וליד לא", () => {
    const ruchama = resolveUserByKey("ruchama")!;
    expect(canUseForm(ruchama, "task")).toBe(true);
    expect(canUseForm(ruchama, "commitment")).toBe(true);
    expect(canUseForm(ruchama, "stage")).toBe(false);
    expect(canUseForm(ruchama, "lead")).toBe(false);
  });

  it("finance (גולדי): אין יצירת משימה/ליד/שלב", () => {
    const goldi = resolveUserByKey("goldi")!;
    expect(canUseForm(goldi, "task")).toBe(false);
    expect(canUseForm(goldi, "stage")).toBe(false);
    expect(canUseForm(goldi, "lead")).toBe(false);
  });

  it("מנהל פרויקט: הכל", () => {
    const dov = resolveUserByKey("dov")!;
    for (const k of ["task", "stage", "lead", "commitment"] as const) expect(canUseForm(dov, k)).toBe(true);
  });
});

describe("isValidPhone", () => {
  it.each(["0501234567", "050-123-4567", "+972 50 123 4567", "(03) 1234567"])("תקין: %s", (v) => expect(isValidPhone(v)).toBe(true));
  it.each(["", "123", "abc1234567", "050123456789012345"])("לא תקין: %s", (v) => expect(isValidPhone(v)).toBe(false));
});

describe("toMondayPhone — הפורמט ש-Monday מקבל", () => {
  it.each([
    ["054-7000011", "0547000011"],
    ["+972 54 700 0011", "0547000011"],
    ["(03) 123-4567", "031234567"],
    ["0501234567", "0501234567"],
  ])("%s → %s", (input, out) => expect(toMondayPhone(input)).toBe(out));
});
