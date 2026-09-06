/**
 * פעולות עדכון מהחלונית (שלב 2). כל פעולה עוברת: הרשאה → בעלות על המשימה → כתיבה ל-Monday.
 *
 * מותר: סימון בוצע / שינוי סטטוס / הערה / דיווח חסם. אלו עדכונים תפעוליים פנימיים שהסוכן עושה
 * לבד. מחיקה / לקוח / כסף — לא כאן.
 */

import { resolveUsersByAssigneeText, userCan, type IdentifiedUser } from "../identity/index.js";
import type { OpsTaskSource } from "../integrations/monday/opsRead.js";
import {
  addTaskNote,
  assertUserOwnsItem,
  DONE_LABEL,
  setTaskStatus,
} from "../integrations/monday/opsWrite.js";
import { detectPeopleColumn, setItemPeople } from "../integrations/monday/itemWrite.js";
import { findUsersByName } from "../integrations/monday/users.js";

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

/**
 * הוספת הערת עדכון (Update) לכל פריט ב-Monday — ליד / משימה / פרויקט / עסקה / גבייה.
 * הערה היא פעולה תפעולית פנימית ובלתי-הרסנית, לכן מותרת לכל מי שיש לו הרשאת "נגיעה" כלשהי,
 * ובלי בדיקת בעלות (בניגוד לשינוי סטטוס). לא כותב ללקוח — רק ל-Updates הפנימיים.
 */
export async function addUpdateToItem(
  user: IdentifiedUser,
  itemId: string,
  body: string,
): Promise<{ ok: true; message: string }> {
  const canNote =
    userCan(user, "task:update_own") ||
    userCan(user, "task:create") ||
    userCan(user, "lead:manage") ||
    userCan(user, "finance:manage") ||
    userCan(user, "project:manage");
  if (!canNote) throw new Error("אין לך הרשאה להוסיף הערות");
  if (!body.trim()) throw new Error("הערה ריקה");
  if (!/^\d+$/.test(itemId)) throw new Error("מזהה פריט לא תקין");
  // כל כתיבה ל-Monday רשומה על חשבון ה-API (מוטי). השורה הראשונה היא מי באמת רשם.
  await addTaskNote(itemId, `✍️ נרשם ע"י ${user.name} (דרך העוזר התפעולי)\n\n${body.trim()}`);
  return { ok: true, message: "ההערה נוספה ל-Monday" };
}

/**
 * החלפת האחראי/ת של פריט Monday (ליד / עסקה / משימה / פרויקט / שלב).
 * שינוי תפעולי פנימי — מותר למי שמנהל משימות/לידים/פרויקטים (owner, admin, מנהל פרויקט).
 * לא כספים ולא שרטוט. כל החלפה מתועדת ב-Update עם שם המבצע.
 */
export async function reassignItem(
  user: IdentifiedUser,
  itemId: string,
  person: string,
): Promise<{ ok: true; message: string }> {
  const canReassign =
    userCan(user, "task:manage") || userCan(user, "lead:manage") || userCan(user, "project:manage");
  if (!canReassign) throw new Error("אין לך הרשאה לשנות אחראי/ת על פריטים");
  if (!/^\d+$/.test(itemId)) throw new Error("מזהה פריט לא תקין");
  const wanted = person.trim();
  if (!wanted) throw new Error("לא צוין למי להעביר");

  // קודם ספר הצוות שלנו (מכיר "יוכי" בעברית), אחר כך חיפוש משתמשי Monday.
  let targetId: string | undefined;
  let targetName = wanted;
  const fromDirectory = resolveUsersByAssigneeText(wanted);
  if (fromDirectory.length === 1) {
    if (!fromDirectory[0]!.mondayUserId) {
      throw new Error(`ל${fromDirectory[0]!.name} אין חשבון Monday פעיל — אי אפשר להקצות אליו/ה`);
    }
    targetId = fromDirectory[0]!.mondayUserId;
    targetName = fromDirectory[0]!.name;
  } else if (fromDirectory.length > 1) {
    throw new Error(`"${wanted}" מתאים לכמה אנשים: ${fromDirectory.map((u) => u.name).join(", ")}. מי בדיוק?`);
  } else {
    const mondayMatches = await findUsersByName(wanted);
    if (mondayMatches.length === 0) throw new Error(`לא מצאתי משתמש/ת בשם "${wanted}" ב-Monday`);
    if (mondayMatches.length > 1) {
      throw new Error(`"${wanted}" מתאים לכמה: ${mondayMatches.map((u) => u.name).join(", ")}. מי בדיוק?`);
    }
    targetId = mondayMatches[0]!.id;
    targetName = mondayMatches[0]!.name;
  }

  const col = await detectPeopleColumn(itemId);
  if (col.currentIds.length === 1 && col.currentIds[0] === targetId) {
    return { ok: true, message: `"${col.itemName}" כבר משויך/ת ל${targetName}` };
  }
  await setItemPeople(col.boardId, itemId, col.columnId, [targetId]);
  await addTaskNote(
    itemId,
    `👤 ${col.columnTitle} שונה/תה ל${targetName} — ע"י ${user.name} דרך העוזר התפעולי`,
  );
  return { ok: true, message: `${col.columnTitle} של "${col.itemName}" עודכן/ה ל${targetName}` };
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
