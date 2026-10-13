/**
 * שכבת הזהות — הועבר אחד-לאחד מ-scripts/test-identity.ts (24 בדיקות, הסקריפט הישן הוסר).
 * לוגיקה טהורה; tools.ts נטען (לסינון הכלים) — רשת חסומה ו-DB זמני דרך tests/setup.
 */

import { describe, expect, it } from "vitest";
import { toAnthropicTools } from "../../src/integrations/claude/tools.js";
import {
  resolveUserByEmail,
  resolveUserByKey,
  resolveUserByMondayId,
  resolveUserByWhatsappJid,
  userCan,
} from "../../src/identity/index.js";

describe("זיהוי לפי ערוצים", () => {
  it("JID של מוטי → moti", () => {
    expect(resolveUserByWhatsappJid("972527530044@s.whatsapp.net")?.key).toBe("moti");
  });
  it("JID לא מוכר → null", () => {
    expect(resolveUserByWhatsappJid("972500000000@s.whatsapp.net")).toBeNull();
  });
  it("מזהה Monday 62982081 → dov", () => {
    expect(resolveUserByMondayId("62982081")?.key).toBe("dov");
  });
  it("מייל (case-insensitive) → eitan", () => {
    expect(resolveUserByEmail("EITAN@gotlib.biz")?.key).toBe("eitan");
  });
  it("מפתח לא קיים → null", () => {
    expect(resolveUserByKey("nobody")).toBeNull();
  });
});

describe("הרשאות לפי תפקיד", () => {
  const moti = resolveUserByKey("moti");
  const ruchama = resolveUserByKey("ruchama");
  const goldi = resolveUserByKey("goldi");
  const dov = resolveUserByKey("dov");
  const yochi = resolveUserByKey("yochi");

  it("מוטי מאשר פעולות רגישות", () => expect(userCan(moti, "approve:sensitive")).toBe(true));
  it("מוטי רואה הכל", () => expect(userCan(moti, "view:all_work")).toBe(true));
  it("יוכי (אדמין) לא מאשר פעולות רגישות — רק מוטי", () => expect(userCan(yochi, "approve:sensitive")).toBe(false));
  it("יוכי כן אדמין מערכת", () => expect(userCan(yochi, "system:admin")).toBe(true));
  it("רוחמה לא מקצה לאחרים / מנהלת פרויקט", () => expect(userCan(ruchama, "task:manage")).toBe(false));
  it("רוחמה מעדכנת משימות שלה", () => expect(userCan(ruchama, "task:update_own")).toBe(true));
  it("רוחמה יוצרת לעצמה משימות המשך", () => expect(userCan(ruchama, "task:create")).toBe(true));
  it("רוחמה לא רואה כספים", () => expect(userCan(ruchama, "view:finance")).toBe(false));
  it("גולדי מנהלת גבייה", () => expect(userCan(goldi, "finance:manage")).toBe(true));
  it("גולדי לא מנהלת פרויקטים", () => expect(userCan(goldi, "project:manage")).toBe(false));
  it("דוב מנהל פרויקטים כולל רישוי", () => expect(userCan(dov, "project:manage")).toBe(true));
  it("דוב לא מאשר פעולות רגישות (כסף/מחיקה)", () => expect(userCan(dov, "approve:sensitive")).toBe(false));
  it("משתמש לא מזוהה — אפס הרשאות", () => expect(userCan(null, "view:own_work")).toBe(false));
});

describe("סינון כלים ל-AI לפי הרשאות", () => {
  const motiTools = toAnthropicTools(resolveUserByKey("moti")).map((t) => t.name);
  const ruchamaTools = toAnthropicTools(resolveUserByKey("ruchama")).map((t) => t.name);
  const anonTools = toAnthropicTools(null).map((t) => t.name);

  it("מוטי מקבל את כלי המייל", () => expect(motiTools).toContain("send_meeting_summary_email"));
  it("רוחמה לא מקבלת את כלי המייל", () => expect(ruchamaTools).not.toContain("send_meeting_summary_email"));
  it("רוחמה לא מקבלת הקצאת משימה לאחרים", () => expect(ruchamaTools).not.toContain("assign_monday_task"));
  it("רוחמה כן מקבלת יצירת משימת המשך", () => expect(ruchamaTools).toContain("create_monday_task"));
  it("רוחמה כן מקבלת 'המשימות שלי'", () => expect(ruchamaTools).toContain("list_my_work"));
  it("משתמש לא מזוהה — 0 כלים ל-AI", () => expect(anonTools).toHaveLength(0));
});
