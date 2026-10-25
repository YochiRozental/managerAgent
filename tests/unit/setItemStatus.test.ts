/**
 * setItemStatus (set_item_status, 2026-10-25) — שינוי סטטוס על כל בורד: ליד / עסקה / פרויקט / שלב /
 * גבייה / תשלום / בורד לא מוכר. כל ה-deps מוזרקים — אין Monday אמיתי.
 *
 * מוודאת: הרשאה לפי סוג הבורד, בחירת עמודת הסטטוס הראשית (גם כשיש כמה עמודות status), אימות
 * תווית מול Monday (כולל "בוצע"↔"הושלם" ושגיאה עם האפשרויות), no-op כשהסטטוס כבר זהה, ותיעוד ב-Update.
 */

import { describe, expect, it } from "vitest";
import { resolveUserByKey } from "../../src/identity/index.js";
import { matchStatusLabel, pickStatusColumn, setItemStatus, type SetItemStatusDeps } from "../../src/ops/actions.js";
import type { ItemStatusColumns } from "../../src/integrations/monday/itemWrite.js";

const moti = resolveUserByKey("moti")!;
const dov = resolveUserByKey("dov")!;
const ruchama = resolveUserByKey("ruchama")!;
const goldi = resolveUserByKey("goldi")!;

const LEADS = "1550734525";
const PROJECTS = "1550734533";
const COLLECTION = "1550734546";
const OTHER = "2124228925"; // הסכמים — אין לו מדיניות מוגדרת

const LEAD_LABELS = ["ליד חדש", "ניסיון יצירת קשר", "פוטנציאלי", "פולואפ", "עבר לעסקה", "נסגר", "לא רלוונטי", "הוקפא"];

function harness(item: ItemStatusColumns, labels: Record<string, string[]>, extra: Partial<SetItemStatusDeps> = {}) {
  const writes: { boardId: string; itemId: string; values: Record<string, unknown> }[] = [];
  const notes: string[] = [];
  const deps: SetItemStatusDeps = {
    readItemStatusColumns: async () => item,
    getColumnLabels: async (_b, col) => labels[col] ?? [],
    setItemColumnValues: async (boardId, itemId, values) => {
      writes.push({ boardId, itemId, values });
    },
    addTaskNote: async (_id, body) => {
      notes.push(body);
    },
    // ניהול פרויקט: דוב מנהל את הפרויקט בבדיקות האלה
    resolveItemProjectScope: async () => ({ boardId: PROJECTS, projectId: "900" }) as never,
    getProjectOwnerIds: async () => [dov.mondayUserId!],
    ...extra,
  };
  return { deps, writes, notes };
}

const leadItem: ItemStatusColumns = {
  boardId: LEADS,
  itemName: "משפחת כהן",
  columns: [
    { id: "color__1", title: "סטטוס", text: "ליד חדש" },
    { id: "color1__1", title: "מקור הגעה", text: "אתר" },
    { id: "color5__1", title: "מוצר", text: "בית פרטי" },
  ],
};

describe("setItemStatus — ליד", () => {
  it("דוב (lead:manage) מעביר ליד לפולואפ — נכתבת עמודת הסטטוס הראשית + Update", async () => {
    const h = harness(leadItem, { color__1: LEAD_LABELS });
    const r = await setItemStatus(dov, { itemId: "111", status: "פולואפ" }, h.deps);
    expect(r.message).toContain("פולואפ");
    expect(h.writes).toEqual([{ boardId: LEADS, itemId: "111", values: { color__1: { label: "פולואפ" } } }]);
    expect(h.notes[0]).toContain("דוב");
    expect(h.notes[0]).toContain("ליד חדש");
  });

  it("רוחמה (planner) נחסמת לפני כתיבה", async () => {
    const h = harness(leadItem, { color__1: LEAD_LABELS });
    await expect(setItemStatus(ruchama, { itemId: "111", status: "פולואפ" }, h.deps)).rejects.toThrow(/הרשאה/);
    expect(h.writes).toHaveLength(0);
  });

  it("תווית לא קיימת → שגיאה עם האפשרויות, בלי כתיבה", async () => {
    const h = harness(leadItem, { color__1: LEAD_LABELS });
    await expect(setItemStatus(dov, { itemId: "111", status: "בטיפול" }, h.deps)).rejects.toThrow(/האפשרויות/);
    expect(h.writes).toHaveLength(0);
  });

  it("כבר באותו סטטוס → no-op", async () => {
    const h = harness(leadItem, { color__1: LEAD_LABELS });
    const r = await setItemStatus(dov, { itemId: "111", status: "ליד חדש" }, h.deps);
    expect(r.message).toContain("כבר");
    expect(h.writes).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
  });

  it("column מפורש — משנה עמודה אחרת (מקור הגעה)", async () => {
    const h = harness(leadItem, { color1__1: ["אתר", "המלצה", "פייסבוק"] });
    await setItemStatus(dov, { itemId: "111", status: "המלצה", column: "מקור" }, h.deps);
    expect(h.writes[0]!.values).toEqual({ color1__1: { label: "המלצה" } });
  });

  it("מזהה לא מספרי נדחה לפני קריאת Monday", async () => {
    const h = harness(leadItem, { color__1: LEAD_LABELS });
    await expect(setItemStatus(dov, { itemId: "lead_x", status: "פולואפ" }, h.deps)).rejects.toThrow(/מזהה/);
  });
});

describe("setItemStatus — פרויקט / גבייה / בורד אחר", () => {
  const projectItem: ItemStatusColumns = {
    boardId: PROJECTS,
    itemName: "בית כנסת",
    columns: [
      { id: "status1__1", title: "מוצר", text: "תכנון" },
      { id: "status_17__1", title: "סטטוס פרויקט", text: "בעבודה" },
    ],
  };

  it("מנהל הפרויקט משנה ל'קיבל היתר' (התאמה חלקית יחידה)", async () => {
    const h = harness(projectItem, { status_17__1: ["טרם החל", "בעבודה", "לקראת היתר", "קיבל היתר", "הסתיים"] });
    await setItemStatus(dov, { itemId: "222", status: "היתר" }, h.deps).catch((e) => e);
    // "היתר" מתאים לשתי תוויות — חייב לשאול
    expect(h.writes).toHaveLength(0);
    await setItemStatus(dov, { itemId: "222", status: "קיבל היתר" }, h.deps);
    expect(h.writes[0]!.values).toEqual({ status_17__1: { label: "קיבל היתר" } });
  });

  it("מנהל פרויקט שאינו מנהל את הפרויקט — נחסם", async () => {
    const h = harness(
      projectItem,
      { status_17__1: ["בעבודה", "קיבל היתר"] },
      { getProjectOwnerIds: async () => ["999"] },
    );
    await expect(setItemStatus(dov, { itemId: "222", status: "קיבל היתר" }, h.deps)).rejects.toThrow(/מנהל/);
    expect(h.writes).toHaveLength(0);
  });

  const collectionItem: ItemStatusColumns = {
    boardId: COLLECTION,
    itemName: "גבייה — בית כנסת",
    columns: [
      { id: "status", title: "סטטוס גבייה", text: "ממתין לתשלום" },
      { id: "status9__1", title: "אופן תשלום", text: "לפי שלבים" },
    ],
  };
  const COLLECTION_LABELS = { status: ["ממתין לתשלום", "בתהליך", "מאחר", "שולם", "עתידית"] };

  it("גולדי (finance:manage) מסמנת שולם; דוב נחסם", async () => {
    const h = harness(collectionItem, COLLECTION_LABELS);
    await setItemStatus(goldi, { itemId: "333", status: "שולם" }, h.deps);
    expect(h.writes[0]!.values).toEqual({ status: { label: "שולם" } });
    await expect(setItemStatus(dov, { itemId: "333", status: "שולם" }, h.deps)).rejects.toThrow(/גבייה/);
  });

  it("בורד לא מוכר — רק owner/admin; כמה עמודות בלי 'סטטוס' בכותרת → שואלים", async () => {
    const otherItem: ItemStatusColumns = {
      boardId: OTHER,
      itemName: "הסכם",
      columns: [
        { id: "a", title: "שלב חתימה", text: "" },
        { id: "b", title: "סוג", text: "" },
      ],
    };
    const h = harness(otherItem, { a: ["נשלח", "נחתם"] });
    await expect(setItemStatus(dov, { itemId: "444", status: "נחתם" }, h.deps)).rejects.toThrow(/בעלים/);
    await expect(setItemStatus(moti, { itemId: "444", status: "נחתם" }, h.deps)).rejects.toThrow(/כמה עמודות סטטוס/);
    await setItemStatus(moti, { itemId: "444", status: "נחתם", column: "שלב חתימה" }, h.deps);
    expect(h.writes[0]!.values).toEqual({ a: { label: "נחתם" } });
  });

  it("אין תוויות מ-Monday → לא כותבים בלי לאמת", async () => {
    const h = harness(leadItem, {});
    await expect(setItemStatus(moti, { itemId: "111", status: "פולואפ" }, h.deps)).rejects.toThrow(/בלי לאמת/);
    expect(h.writes).toHaveLength(0);
  });
});

describe("matchStatusLabel / pickStatusColumn", () => {
  it("'בוצע' ממופה ל'הושלם' כשזו תווית הסיום היחידה", () => {
    expect(matchStatusLabel(["לביצוע", "בעבודה", "הושלם"], "בוצע", "סטטוס")).toBe("הושלם");
  });
  it("עמודה יחידה בלי 'סטטוס' בכותרת נבחרת", () => {
    expect(pickStatusColumn([{ id: "x", title: "שלב", text: "" }], undefined, undefined).id).toBe("x");
  });
  it("פריט בלי עמודות סטטוס → שגיאה", () => {
    expect(() => pickStatusColumn([], undefined, undefined)).toThrow(/אין עמודת סטטוס/);
  });
});
