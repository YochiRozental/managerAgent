/**
 * פעולות עדכון מהחלונית (שלב 2). כל פעולה עוברת: הרשאה → בעלות על המשימה → כתיבה ל-Monday.
 *
 * מותר: סימון בוצע / שינוי סטטוס / הערה / דיווח חסם. אלו עדכונים תפעוליים פנימיים שהסוכן עושה
 * לבד. מחיקה / לקוח / כסף — לא כאן.
 */

import { userCan, type IdentifiedUser } from "../identity/index.js";
import type { OpsTaskSource } from "../integrations/monday/opsRead.js";
import {
  addTaskNote,
  assertUserOwnsItem,
  DONE_LABEL,
  setTaskStatus,
} from "../integrations/monday/opsWrite.js";

async function authorize(user: IdentifiedUser, itemId: string): Promise<void> {
  if (!userCan(user, "task:update_own")) throw new Error("אין לך הרשאה לעדכן משימות");
  if (!user.mondayUserId) throw new Error("אין חשבון Monday מקושר למשתמש");
  // task:manage מאפשר לגעת בכל משימה בפרויקט; בלעדיו — רק במשימות של המשתמש עצמו.
  if (!userCan(user, "task:manage")) {
    await assertUserOwnsItem(itemId, user.mondayUserId);
  }
}

export type TaskUpdateAction = "done" | "state" | "note" | "blocker";

export interface TaskUpdateInput {
  action: TaskUpdateAction;
  source: OpsTaskSource;
  itemId: string;
  label?: string;
  note?: string;
}

export async function updateTask(user: IdentifiedUser, input: TaskUpdateInput): Promise<{ ok: true; message: string }> {
  await authorize(user, input.itemId);

  switch (input.action) {
    case "done":
      await setTaskStatus(input.source, input.itemId, DONE_LABEL[input.source]);
      return { ok: true, message: "סומן כבוצע ✅" };

    case "state":
      if (!input.label) throw new Error("חסר סטטוס");
      await setTaskStatus(input.source, input.itemId, input.label);
      return { ok: true, message: `הסטטוס עודכן ל"${input.label}"` };

    case "note":
      if (!input.note?.trim()) throw new Error("הערה ריקה");
      await addTaskNote(input.itemId, input.note);
      return { ok: true, message: "ההערה נוספה" };

    case "blocker":
      await setTaskStatus(input.source, input.itemId, "תקוע");
      if (input.note?.trim()) await addTaskNote(input.itemId, `🚧 חסם: ${input.note.trim()}`);
      return { ok: true, message: "דווח כתקוע" };

    default:
      throw new Error("פעולה לא מוכרת");
  }
}
