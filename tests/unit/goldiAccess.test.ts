/**
 * גישת גולדי (finance, guest ב-Monday) למשימות שלה — 2026-10-26.
 *
 * היה: mondayUserId=null בספר הצוות → הצ'אט ענה "אין לך חשבון Monday מקושר" למרות שיש לה משימות.
 * עכשיו: mondayUserId=63386527 + task:update_own לתפקיד finance. הבעלות נאכפת בשרת (authorize →
 * isOwnItem לפי מזהה Monday) — לא דרך הנחיות לסוכן. כל ה-side-effects מוזרקים — אין קריאת Monday.
 */

import { describe, it, expect } from "vitest";
import { resolveUserByKey, resolveUserByMondayId, ROLE_PERMISSIONS, TEAM_DIRECTORY } from "../../src/identity/index.js";
import { updateTask, addUpdateToItem } from "../../src/ops/actions.js";
import { buildAgentTools } from "../../src/ops/agentTools.js";

const GOLDI_MONDAY_ID = "63386527";

function fakeDeps(ownerMondayId: string) {
  const ownerChecks: string[] = [];
  const statusWrites: unknown[] = [];
  const noteWrites: unknown[] = [];
  return {
    ownerChecks,
    statusWrites,
    noteWrites,
    deps: {
      isOwnItem: async (_itemId: string, mondayUserId: string) => {
        ownerChecks.push(mondayUserId);
        return mondayUserId === ownerMondayId;
      },
      setTaskStatus: async (...a: unknown[]) => void statusWrites.push(a),
      addTaskNote: async (...a: unknown[]) => void noteWrites.push(a),
      // משימה לא שלה → אסור להגיע לבדיקת scope פרויקט בכלל (אין task:manage)
      resolveItemProjectScope: async () => {
        throw new Error("לא אמור להיקרא");
      },
    },
  };
}

describe("זהות גולדי", () => {
  const goldi = resolveUserByKey("goldi")!;

  it("מקושרת למזהה ה-Monday שלה", () => expect(goldi.mondayUserId).toBe(GOLDI_MONDAY_ID));
  it("זיהוי לפי מזהה Monday מחזיר את גולדי", () => expect(resolveUserByMondayId(GOLDI_MONDAY_ID)?.key).toBe("goldi"));
  it("הרשאות finance = הקודמות + task:update_own בלבד", () =>
    expect([...goldi.permissions].sort()).toEqual(
      ["view:own_work", "view:finance", "finance:manage", "report:hours", "task:update_own"].sort(),
    ));
  it("אין לה task:manage / task:create / approve:sensitive", () => {
    for (const p of ["task:manage", "task:create", "approve:sensitive"] as const) expect(goldi.permissions).not.toContain(p);
  });
  it("נכללת בבקרת העומסים והתזכורות (officeState סורק כל מי שיש לו mondayUserId)", () =>
    expect(TEAM_DIRECTORY.filter((m) => m.mondayUserId).map((m) => m.key)).toContain("goldi"));
});

describe("הרשאות שאר התפקידים לא השתנו", () => {
  it("project_manager", () =>
    expect([...ROLE_PERMISSIONS.project_manager].sort()).toEqual(
      ["view:own_work", "view:managed_projects", "report:hours", "task:update_own", "task:create", "task:manage", "project:manage", "lead:manage", "client:communicate"].sort(),
    ));
  it("planner", () =>
    expect([...ROLE_PERMISSIONS.planner].sort()).toEqual(["view:own_work", "report:hours", "task:update_own", "task:create"].sort()));
  it("owner = הכל, admin = הכל חוץ מ-approve:sensitive", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("approve:sensitive");
    expect([...ROLE_PERMISSIONS.admin].sort()).toEqual(ROLE_PERMISSIONS.owner.filter((p) => p !== "approve:sensitive").sort());
  });
});

describe("גולדי מעדכנת משימות — בעלות נאכפת בשרת", () => {
  const goldi = resolveUserByKey("goldi")!;

  it("משימה שלה: סטטוס / בוצע / הערה נכתבים, והבדיקה היא לפי המזהה שלה", async () => {
    const f = fakeDeps(GOLDI_MONDAY_ID);
    await updateTask(goldi, { action: "state", source: "general", itemId: "111", label: "בעבודה" }, f.deps);
    await updateTask(goldi, { action: "done", source: "general", itemId: "111" }, f.deps);
    await updateTask(goldi, { action: "note", source: "general", itemId: "111", note: "התקבלה חשבונית" }, f.deps);
    expect(f.statusWrites).toHaveLength(2);
    expect(f.noteWrites).toHaveLength(1);
    expect(new Set(f.ownerChecks)).toEqual(new Set([GOLDI_MONDAY_ID]));
  });

  it("משימה של עובד אחר: נחסמת לפני כל כתיבה", async () => {
    const f = fakeDeps("62982385"); // המשימה של רוחמה
    for (const input of [
      { action: "state" as const, source: "general" as const, itemId: "222", label: "בוצע" },
      { action: "done" as const, source: "project" as const, itemId: "222" },
      { action: "note" as const, source: "general" as const, itemId: "222", note: "x" },
      { action: "blocker" as const, source: "general" as const, itemId: "222", note: "x" },
    ]) {
      await expect(updateTask(goldi, input, f.deps)).rejects.toThrow("המשימה הזו לא משויכת אליך");
    }
    expect(f.statusWrites).toHaveLength(0);
    expect(f.noteWrites).toHaveLength(0);
  });
});

describe("add_update — finance מוסיפה הערה רק למשימה שלה (בדיקת בעלות בשרת)", () => {
  const goldi = resolveUserByKey("goldi")!;
  const ruchama = resolveUserByKey("ruchama")!;
  const BOARD_GENERAL_TASKS = "1550734526";
  const BOARD_COLLECTION = "1550734546";

  function noteDeps(boardId: string | null, ownerMondayId: string) {
    const ownerChecks: string[] = [];
    const notes: unknown[] = [];
    let scopeCalls = 0;
    return {
      ownerChecks,
      notes,
      scopeCalls: () => scopeCalls,
      deps: {
        resolveItemProjectScope: async () => {
          scopeCalls++;
          return boardId ? { boardId, projectId: null } : null;
        },
        isOwnItem: async (_itemId: string, mondayUserId: string) => {
          ownerChecks.push(mondayUserId);
          return mondayUserId === ownerMondayId;
        },
        addTaskNote: async (...a: unknown[]) => void notes.push(a),
      },
    };
  }

  it("משימה שלה: ההערה נכתבת, הבעלות נבדקה לפי המזהה שלה", async () => {
    const f = noteDeps(BOARD_GENERAL_TASKS, GOLDI_MONDAY_ID);
    await addUpdateToItem(goldi, "111", "התקבלה חשבונית", f.deps);
    expect(f.notes).toHaveLength(1);
    expect(f.ownerChecks).toEqual([GOLDI_MONDAY_ID]);
  });

  it("משימה של עובד אחר: נחסמת, שום דבר לא נכתב", async () => {
    const f = noteDeps(BOARD_GENERAL_TASKS, "62982385");
    await expect(addUpdateToItem(goldi, "222", "x", f.deps)).rejects.toThrow("המשימה הזו לא משויכת אליך");
    expect(f.notes).toHaveLength(0);
  });

  it("משימת שלב פרויקט / תת-משימה של עובד אחר: נחסמת", async () => {
    for (const board of ["1550734556", "1550734559"]) {
      const f = noteDeps(board, "62982081");
      await expect(addUpdateToItem(goldi, "333", "x", f.deps)).rejects.toThrow("לא משויכת אליך");
      expect(f.notes).toHaveLength(0);
    }
  });

  it("גבייה (לא משימה): לא השתנה — נכתב בלי בדיקת בעלות", async () => {
    const f = noteDeps(BOARD_COLLECTION, "62912552");
    await addUpdateToItem(goldi, "444", "שולם", f.deps);
    expect(f.notes).toHaveLength(1);
    expect(f.ownerChecks).toHaveLength(0);
  });

  it("פריט שלא זוהה ב-Monday: נחסם (לא מנחשים)", async () => {
    const f = noteDeps(null, GOLDI_MONDAY_ID);
    await expect(addUpdateToItem(goldi, "555", "x", f.deps)).rejects.toThrow("לא הצלחתי לזהות");
    expect(f.notes).toHaveLength(0);
  });

  it("תפקיד אחר (planner) לא השתנה — בלי שאילתת בורד ובלי בדיקת בעלות", async () => {
    const f = noteDeps(BOARD_GENERAL_TASKS, "62982081");
    await addUpdateToItem(ruchama, "666", "x", f.deps);
    expect(f.notes).toHaveLength(1);
    expect(f.scopeCalls()).toBe(0);
    expect(f.ownerChecks).toHaveLength(0);
  });

  describe("קריאה ישירה לכלי add_update (AgentTool → addUpdateToItem האמיתי)", () => {
    function toolWith(f: ReturnType<typeof noteDeps>) {
      const tools = buildAgentTools({ addUpdateToItem: (u, i, b) => addUpdateToItem(u, i, b, f.deps) });
      return tools.find((t) => t.name === "add_update")!;
    }

    it("משימה שלה — עובר", async () => {
      const f = noteDeps(BOARD_GENERAL_TASKS, GOLDI_MONDAY_ID);
      const r = await toolWith(f).execute({ itemId: "111", body: "בוצע תשלום" }, { user: goldi });
      expect(r).toMatchObject({ ok: true });
      expect(f.notes).toHaveLength(1);
    });

    it("משימה של עובד אחר — נחסם", async () => {
      const f = noteDeps(BOARD_GENERAL_TASKS, "62982385");
      await expect(toolWith(f).execute({ itemId: "222", body: "x" }, { user: goldi })).rejects.toThrow("לא משויכת אליך");
      expect(f.notes).toHaveLength(0);
    });
  });
});
