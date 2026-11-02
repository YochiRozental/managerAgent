/**
 * הלקוח האמיתי של סנכרון הזמן ל-Monday — עם mondayRequest ממוקק (אפס רשת): בודק שנכתבת רק עמודת "זמן עבודה
 * מצטבר" הנכונה בלוח הנכון, ערך מחרוזת מספרי, אימות type=numbers לפני כתיבה, ושגיאות קבועות מסווגות.
 */

import "dotenv/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { query: string; variables: Record<string, unknown> }[] = [];
let columnType = "numbers";
let textType = "text";
let columnMissing = false;
vi.mock("../../src/integrations/monday/client.js", () => ({
  mondayRequest: async (query: string, variables: Record<string, unknown>) => {
    calls.push({ query, variables });
    if (query.includes("columns(ids")) return { boards: [{ columns: columnMissing ? [] : [{ id: (variables.columnId as string[])[0], type: (variables.columnId as string[])[0]!.startsWith("text_") ? textType : columnType }] }] };
    return { change_multiple_column_values: { id: variables.itemId } };
  },
}));
import { _resetColumnValidationForTests, classifySyncError, createRealTaskTimerMondayClient, PermanentSyncError } from "../../src/integrations/monday/taskTimerMondayClient.js";

describe("createRealTaskTimerMondayClient", () => {
  beforeEach(() => {
    calls.length = 0;
    columnType = "numbers";
    textType = "text";
    columnMissing = false;
    _resetColumnValidationForTests();
  });

  it("תת-פריט של פרויקט → לוח 1550734556; משימה רגילה → 1550734526 — מספר + HH:MM באותה קריאה", async () => {
    const c = createRealTaskTimerMondayClient();
    await c.writeCumulative("project_stage", "111", { hours: 1.83, display: "01:50" });
    const w1 = calls.filter((x) => x.query.includes("change_multiple_column_values"));
    expect(w1).toHaveLength(1); // קריאה אחת בלבד לשני הערכים
    expect(w1[0]!.variables.boardId).toBe("1550734556");
    expect(w1[0]!.variables.itemId).toBe("111");
    expect(JSON.parse(w1[0]!.variables.columnValues as string)).toEqual({ numeric_mm8qnjjb: "1.83", text_mm8q953x: "01:50" });
    calls.length = 0;
    await c.writeCumulative("general", "222", { hours: 0.5, display: "00:30" });
    const w2 = calls.filter((x) => x.query.includes("change_multiple_column_values"));
    expect(w2[0]!.variables.boardId).toBe("1550734526");
    expect(JSON.parse(w2[0]!.variables.columnValues as string)).toEqual({ numeric_mm8q8czr: "0.5", text_mm8q5d4g: "00:30" });
  });

  it("כותב רק עמודה אחת: לא סטטוס, לא time_tracking (duration_mm6vptzr), ושום mutation אחר", async () => {
    await createRealTaskTimerMondayClient().writeCumulative("project_stage", "333", { hours: 2, display: "02:00" });
    const mutations = calls.filter((x) => x.query.includes("mutation"));
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.query).toContain("change_multiple_column_values");
    expect(JSON.stringify(calls)).not.toContain("duration_mm6vptzr");
    expect(JSON.stringify(calls)).not.toContain("color");
  });

  it("האימות נעשה פעם אחת לעמודה, לא בכל כתיבה", async () => {
    const c = createRealTaskTimerMondayClient();
    await c.writeCumulative("general", "1", { hours: 1, display: "01:00" });
    await c.writeCumulative("general", "2", { hours: 1, display: "01:00" });
    expect(calls.filter((x) => x.query.includes("columns(ids"))).toHaveLength(2); // מספר + טקסט, פעם אחת כל אחת
    expect(calls.filter((x) => x.query.includes("mutation"))).toHaveLength(2);
  });

  it("עמודה שאינה numbers / חסרה → שגיאה קבועה ובלי כתיבה", async () => {
    columnType = "time_tracking";
    await expect(createRealTaskTimerMondayClient().writeCumulative("project_stage", "444", { hours: 1, display: "01:00" })).rejects.toBeInstanceOf(PermanentSyncError);
    expect(calls.some((x) => x.query.includes("mutation"))).toBe(false);
    columnType = "numbers";
    columnMissing = true;
    await expect(createRealTaskTimerMondayClient().writeCumulative("general", "555", { hours: 1, display: "01:00" })).rejects.toBeInstanceOf(PermanentSyncError);
    expect(calls.some((x) => x.query.includes("mutation"))).toBe(false);
  });

  it("מזהה פריט לא מספרי נדחה לפני כל קריאה", async () => {
    await expect(createRealTaskTimerMondayClient().writeCumulative("general", "item_x", { hours: 1, display: "01:00" })).rejects.toBeInstanceOf(PermanentSyncError);
    expect(calls).toHaveLength(0);
  });

  it("עמודת הטקסט חייבת להיות text — עמודה מסוג אחר נדחית לפני כל כתיבה", async () => {
    textType = "numbers"; // עמודת הטקסט שהוגדרה היא בפועל מסוג אחר
    await expect(createRealTaskTimerMondayClient().writeCumulative("general", "666", { hours: 1, display: "01:00" })).rejects.toBeInstanceOf(PermanentSyncError);
    expect(calls.some((x) => x.query.includes("mutation"))).toBe(false);
  });

  it("סיווג שגיאות: פריט שנמחק = קבוע; timeout/rate-limit = זמני", () => {
    expect(classifySyncError(new Error("Item not found")).permanent).toBe(true);
    expect(classifySyncError(new Error("InvalidColumnIdException")).permanent).toBe(true);
    expect(classifySyncError(new Error("ETIMEDOUT")).permanent).toBe(false);
    expect(classifySyncError(new Error("Rate limit exceeded")).permanent).toBe(false);
  });
});
