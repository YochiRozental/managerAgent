/**
 * כתיבה חזרה ל-Monday מהחלונית (שלב 2) — סימון סטטוס והוספת הערה.
 *
 * עדכונים תפעוליים פנימיים בלבד: סטטוס לפי דיווח מפורש של העובד, והערות. הסוכן עושה אותם לבד
 * (CLAUDE.md סעיף 3 — אוטונומיה מאוזנת). מחיקה / לקוח / כסף לא עוברים כאן.
 *
 * לפני כל כתיבה — מאמתים שהמשימה באמת של המשתמש (או שיש לו task:manage). החלונית ממילא מציגה
 * לעובד רק את המשימות שלו, אבל אסור לסמוך על זה כשמדובר בכתיבה.
 */

import { mondayRequest } from "./client.js";
import { BOARD_GENERAL_TASKS, BOARD_PROJECT_STAGE_TASKS, type OpsTaskSource } from "./opsRead.js";

interface StatusConfig {
  boardId: string;
  columnId: string;
  /** תוויות חוקיות לפי get_board_info (2026-09-02) */
  labels: string[];
}

const STATUS_CONFIG: Record<OpsTaskSource, StatusConfig> = {
  general: {
    boardId: BOARD_GENERAL_TASKS,
    columnId: "status",
    labels: ["לביצוע", "בעבודה", "בוצע", "תקוע", "חסר מידע", "ממתין להתייחסות", "מושהה", "העברתי לקונטריל"],
  },
  project_stage: {
    boardId: BOARD_PROJECT_STAGE_TASKS,
    columnId: "color85__1",
    labels: [
      "לביצוע",
      "בעבודה",
      "הושלם",
      "תקוע",
      "ממתין ללקוח",
      "מתתין ליועץ/ספק/אחר",
      "בטיפול ועדה",
      "טרם הוגדר",
      "לא רלוונטי",
    ],
  },
};

/** תוויות "סיימתי" לפי מקור — כדי שהחלונית לא תצטרך לדעת את ההבדל. */
export const DONE_LABEL: Record<OpsTaskSource, string> = {
  general: "בוצע",
  project_stage: "הושלם",
};

/** עמודת תאריך היעד לכל מקור (get_board_info 2026-09-02). */
const DUE_DATE_COLUMN: Record<OpsTaskSource, string> = {
  general: "date4",
  project_stage: "date__1",
};

/**
 * תווית "ממתין ל..." לפי מקור וסוג ההמתנה. בבורד המשימות הכללי אין תוויות ספציפיות ליועץ/לקוח,
 * אז נופלים ל"ממתין להתייחסות" (וההסבר נכנס להערה).
 */
export function waitingLabel(source: OpsTaskSource, reason: "client" | "consultant" | "manager" | "other"): string {
  if (source === "project_stage") {
    if (reason === "client") return "ממתין ללקוח";
    return "מתתין ליועץ/ספק/אחר";
  }
  return "ממתין להתייחסות";
}

/** תווית "לא רלוונטי / מושהה" לפי מקור. */
export const PARKED_LABEL: Record<OpsTaskSource, string> = {
  general: "מושהה",
  project_stage: "לא רלוונטי",
};

/** קובע תאריך יעד למשימה. dateISO = YYYY-MM-DD. */
export async function setTaskDueDate(source: OpsTaskSource, itemId: string, dateISO: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) throw new Error(`תאריך לא תקין: "${dateISO}" (צריך YYYY-MM-DD)`);
  const cfg = STATUS_CONFIG[source];
  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }`,
    {
      boardId: cfg.boardId,
      itemId,
      columnId: DUE_DATE_COLUMN[source],
      value: JSON.stringify({ date: dateISO }),
    },
  );
}

/** מאמת שהמשתמש הוא אחד האחראים על הפריט. זורק אם לא. */
export async function assertUserOwnsItem(itemId: string, mondayUserId: string): Promise<void> {
  const res = await mondayRequest<{
    items: { id: string; column_values: { id: string; persons_and_teams?: { id: string }[] }[] }[];
  }>(
    `query ($id: [ID!]) {
      items(ids: $id) {
        id
        column_values { id ... on PeopleValue { persons_and_teams { id } } }
      }
    }`,
    { id: [itemId] },
  );

  const item = res.items[0];
  if (!item) throw new Error("המשימה לא נמצאה");

  const owners = new Set<string>();
  for (const col of item.column_values) {
    for (const p of col.persons_and_teams ?? []) owners.add(String(p.id));
  }
  if (!owners.has(String(mondayUserId))) {
    throw new Error("המשימה הזו לא משויכת אליך");
  }
}

export async function setTaskStatus(source: OpsTaskSource, itemId: string, label: string): Promise<void> {
  const cfg = STATUS_CONFIG[source];
  if (!cfg.labels.includes(label)) {
    throw new Error(`"${label}" אינו סטטוס חוקי. אפשרויות: ${cfg.labels.join(", ")}`);
  }
  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }`,
    { boardId: cfg.boardId, itemId, columnId: cfg.columnId, value: JSON.stringify({ label }) },
  );
}

export async function addTaskNote(itemId: string, body: string): Promise<void> {
  const text = body.trim();
  if (!text) throw new Error("הערה ריקה");
  await mondayRequest(
    `mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`,
    { itemId, body: text },
  );
}
