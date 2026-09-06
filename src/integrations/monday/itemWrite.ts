/**
 * שינוי ערכי עמודות בפריט Monday — מעבר לסטטוס/הערה של opsWrite.
 *
 * כרגע: החלפת האחראי/ת (עמודת people) על כל פריט — ליד / עסקה / משימה / פרויקט / שלב.
 * עמודת ה-people שונה בכל בורד, לכן מזהים אותה דינמית לפי הטיפוס במקום להחזיק מיפוי קשיח.
 *
 * כל כתיבה ל-Monday רשומה על חשבון ה-API (מוטי) — התיעוד של מי באמת ביצע נכנס כ-Update.
 */

import { mondayRequest } from "./client.js";

export interface PeopleColumnInfo {
  boardId: string;
  columnId: string;
  columnTitle: string;
  currentIds: string[];
  itemName: string;
}

interface ItemColsResult {
  items: {
    id: string;
    name: string;
    board: { id: string } | null;
    column_values: {
      id: string;
      type: string;
      column: { title: string } | null;
      persons_and_teams?: { id: string }[] | null;
    }[];
  }[];
}

/**
 * מוצא את עמודת ה-people של הפריט. אם יש כמה — מעדיף כזו שבכותרת שלה "אחרא"/"responsible",
 * אחרת הראשונה. זורק אם אין עמודת people בכלל.
 */
export async function detectPeopleColumn(itemId: string): Promise<PeopleColumnInfo> {
  const res = await mondayRequest<ItemColsResult>(
    `query ($id: [ID!]) {
      items(ids: $id) {
        id
        name
        board { id }
        column_values {
          id
          type
          column { title }
          ... on PeopleValue { persons_and_teams { id } }
        }
      }
    }`,
    { id: [itemId] },
  );

  const item = res.items[0];
  if (!item) throw new Error("הפריט לא נמצא ב-Monday");
  if (!item.board) throw new Error("לא הצלחתי לזהות את הבורד של הפריט");

  const peopleCols = item.column_values.filter((c) => c.type === "people");
  if (peopleCols.length === 0) throw new Error("לפריט הזה אין עמודת אחראי/ת");

  const preferred =
    peopleCols.find((c) => /אחרא|responsible|owner/i.test(c.column?.title ?? "")) ?? peopleCols[0]!;

  return {
    boardId: item.board.id,
    columnId: preferred.id,
    columnTitle: preferred.column?.title ?? "אחראי/ת",
    currentIds: (preferred.persons_and_teams ?? []).map((p) => String(p.id)),
    itemName: item.name,
  };
}

/** קובע את רשימת האחראים על עמודת people (מחליף את מה שהיה). */
export async function setItemPeople(
  boardId: string,
  itemId: string,
  columnId: string,
  personIds: string[],
): Promise<void> {
  const value = JSON.stringify({
    personsAndTeams: personIds.map((id) => ({ id: Number(id), kind: "person" })),
  });
  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }`,
    { boardId, itemId, columnId, value },
  );
}
