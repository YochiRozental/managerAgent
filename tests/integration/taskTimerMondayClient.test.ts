/**
 * הלקוח האמיתי של סנכרון הזמן ל-Monday — עם mondayRequest ממוקק (אפס רשת): בודק שנכתבת רק עמודת "זמן עבודה
 * מצטבר" הנכונה בלוח הנכון, ערך מחרוזת מספרי, אימות type=numbers לפני כתיבה, ושגיאות קבועות מסווגות.
 */

import "dotenv/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { query: string; variables: Record<string, unknown> }[] = [];
let columnType = "numbers";
let columnMissing = false;
vi.mock("../../src/integrations/monday/client.js", () => ({
  mondayRequest: async (query: string, variables: Record<string, unknown>) => {
    calls.push({ query, variables });
    if (query.includes("columns(ids")) return { boards: [{ columns: columnMissing ? [] : [{ id: (variables.columnId as string[])[0], type: columnType }] }] };
    return { change_simple_column_value: { id: variables.itemId } };
  },
}));
import { _resetColumnValidationForTests, classifySyncError, createRealTaskTimerMondayClient, PermanentSyncError } from "../../src/integrations/monday/taskTimerMondayClient.js";

describe("createRealTaskTimerMondayClient", () => {
  beforeEach(() => {
    calls.length = 0;
    columnType = "numbers";
    columnMissing = false;
    _resetColumnValidationForTests();
  });

  it("תת-פריט של פרויקט → לוח 1550734556 ועמודת numeric_mm8qnjjb; משימה רגילה → 1550734526 ו-numeric_mm8q8czr", async () => {
    const c = createRealTaskTimerMondayClient();
    await c.writeCumulativeHours("project_stage", "111", 1.83);
    const w1 = calls.find((x) => x.query.includes("change_simple_column_value"))!;
    expect(w1.variables).toEqual({ boardId: "1550734556", itemId: "111", columnId: "numeric_mm8qnjjb", value: "1.83" });
    calls.length = 0;
    await c.writeCumulativeHours("general", "222", 0.5);
    const w2 = calls.find((x) => x.query.includes("change_simple_column_value"))!;
    expect(w2.variables).toEqual({ boardId: "1550734526", itemId: "222", columnId: "numeric_mm8q8czr", value: "0.5" });
  });

  it("כותב רק עמודה אחת: לא סטטוס, לא time_tracking (duration_mm6vptzr), ושום mutation אחר", async () => {
    await createRealTaskTimerMondayClient().writeCumulativeHours("project_stage", "333", 2);
    const mutations = calls.filter((x) => x.query.includes("mutation"));
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.query).toContain("change_simple_column_value");
    expect(JSON.stringify(calls)).not.toContain("duration_mm6vptzr");
    expect(JSON.stringify(calls)).not.toContain("color");
  });

  it("האימות נעשה פעם אחת לעמודה, לא בכל כתיבה", async () => {
    const c = createRealTaskTimerMondayClient();
    await c.writeCumulativeHours("general", "1", 1);
    await c.writeCumulativeHours("general", "2", 1);
    expect(calls.filter((x) => x.query.includes("columns(ids"))).toHaveLength(1);
    expect(calls.filter((x) => x.query.includes("mutation"))).toHaveLength(2);
  });

  it("עמודה שאינה numbers / חסרה → שגיאה קבועה ובלי כתיבה", async () => {
    columnType = "time_tracking";
    await expect(createRealTaskTimerMondayClient().writeCumulativeHours("project_stage", "444", 1)).rejects.toBeInstanceOf(PermanentSyncError);
    expect(calls.some((x) => x.query.includes("mutation"))).toBe(false);
    columnType = "numbers";
    columnMissing = true;
    await expect(createRealTaskTimerMondayClient().writeCumulativeHours("general", "555", 1)).rejects.toBeInstanceOf(PermanentSyncError);
    expect(calls.some((x) => x.query.includes("mutation"))).toBe(false);
  });

  it("מזהה פריט לא מספרי נדחה לפני כל קריאה", async () => {
    await expect(createRealTaskTimerMondayClient().writeCumulativeHours("general", "item_x", 1)).rejects.toBeInstanceOf(PermanentSyncError);
    expect(calls).toHaveLength(0);
  });

  it("סיווג שגיאות: פריט שנמחק = קבוע; timeout/rate-limit = זמני", () => {
    expect(classifySyncError(new Error("Item not found")).permanent).toBe(true);
    expect(classifySyncError(new Error("InvalidColumnIdException")).permanent).toBe(true);
    expect(classifySyncError(new Error("ETIMEDOUT")).permanent).toBe(false);
    expect(classifySyncError(new Error("Rate limit exceeded")).permanent).toBe(false);
  });
});
