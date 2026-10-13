/**
 * מוכיח ש-callsDirectly (tests/helpers/sourceCalls.ts) באמת מסוגל להיכשל על הפרה — על פונקציות שעברו
 * את טרנספורמציית Vitest, לא על מחרוזות שנכתבו ביד. בלי זה, בדיקת "אין קריאה ישירה ל-createTask"
 * ב-whatsappAgentTools.test.ts הייתה יכולה לעבור תמיד בלי לבדוק כלום.
 */
import { expect, it } from "vitest";
import { getTool } from "../../src/integrations/claude/tools.js";
import { callsDirectly } from "../helpers/sourceCalls.js";
import { allowedSimilarName, forbiddenDirect, forbiddenNamespace } from "../fixtures/directCallAdapters.js";

it("תחת Vitest, includes('createTask(') הישן לא תופס קריאה ישירה — זו הסיבה להחלפה", () => {
  expect(forbiddenDirect.toString().includes("createTask(")).toBe(false);
});

it("callsDirectly תופס קריאה ישירה ל-createTask אחרי הטרנספורמציה", () => {
  expect(callsDirectly(forbiddenDirect.toString(), "createTask")).toBe(true);
});

it("callsDirectly תופס קריאה דרך namespace (tasks.createTask)", () => {
  expect(callsDirectly(forbiddenNamespace.toString(), "createTask")).toBe(true);
});

it("callsDirectly תופס את הקריאה הישירה האמיתית ב-create_monday_task (legacy, tools.ts)", () => {
  expect(callsDirectly(getTool("create_monday_task")!.execute.toString(), "createTask")).toBe(true);
});

it("callsDirectly לא נותן false-positive על שם ארוך יותר (createTaskAction)", () => {
  expect(callsDirectly(allowedSimilarName.toString(), "createTask")).toBe(false);
});

it("callsDirectly לא נותן false-positive על adapters תקינים (mark_done/set_status/create_task)", () => {
  for (const name of ["mark_done", "set_status", "create_task"]) {
    expect(callsDirectly(getTool(name)!.execute.toString(), "createTask"), name).toBe(false);
  }
});
