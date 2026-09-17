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

/**
 * קורא את תווית הסטטוס הנוכחית של משימה מ-Monday (לא מ-cache שלנו) — למשל ל-commitment_check
 * שצריך לדעת אם המשימה כבר נסגרה לפני שפונים לעובד. null אם הפריט לא נמצא.
 */
export async function getTaskStatusLabel(source: OpsTaskSource, itemId: string): Promise<string | null> {
  const cfg = STATUS_CONFIG[source];
  const res = await mondayRequest<{ items: { id: string; column_values: { text: string | null }[] }[] }>(
    `query ($id: [ID!], $col: [String!]) {
      items(ids: $id) { id column_values(ids: $col) { text } }
    }`,
    { id: [itemId], col: [cfg.columnId] },
  );
  const item = res.items[0];
  return item?.column_values[0]?.text ?? null;
}

/**
 * האם תווית הסטטוס אומרת "המשימה באמת הסתיימה" — רק DONE_LABEL (בוצע/הושלם).
 * (Audit 2026-09-15): בעבר isClosedStatusLabel חיבר לזה גם PARKED_LABEL — זו טעות. "מושהה"
 * (general) הוא paused/on-hold לפי מפת הבורדים ב-CLAUDE.md, לא סיום; "לא רלוונטי" (project_stage)
 * קרוב יותר ל"בוטל", גם הוא לא "הושלם". completion אמיתי = רק זה.
 */
export function isDoneStatusLabel(source: OpsTaskSource, label: string | null): boolean {
  return !!label && label === DONE_LABEL[source];
}

/**
 * "מושהה"/"לא רלוונטי" — מושהה/מבוטל, לא בוצע ולא עדיין פעיל באופן רגיל. commitment_check לא
 * אמור להניח שההתחייבות קוימה (isDoneStatusLabel) ולא אמור לשאול "איפה זה עומד" על משהו שהוקפא —
 * ראה followups.ts.
 */
export function isParkedStatusLabel(source: OpsTaskSource, label: string | null): boolean {
  return !!label && label === PARKED_LABEL[source];
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

// ---------------------------------------------------------------------------
// יצירת משימות מהחלונית (create_task, ר' src/ops/actions.ts) — subitem בשלב הנכון של פרויקט,
// או item בבורד המשימות הכללי. הישן createTask() (tasks.ts) יצר item גנרי בקבוצה הראשונה בלי
// שום column value — לא מתאים למבנה פרויקט→שלב→משימה. לא משתמשים בו כאן.
// ---------------------------------------------------------------------------

const columnLabelsCache = new Map<string, { at: number; labels: string[] }>();
const COLUMN_LABELS_TTL_MS = 10 * 60_000;

/**
 * תוויות תקינות של עמודת status/color לפי id — נקרא דינמית מ-Monday (לא מנחשים ערכים,
 * ר' get_board_info ב-CLAUDE.md §8). labels ריק (עמודה לא נמצאה) → מדלגים על הוולידציה.
 */
async function getColumnLabels(boardId: string, columnId: string): Promise<string[]> {
  const key = `${boardId}:${columnId}`;
  const cached = columnLabelsCache.get(key);
  if (cached && Date.now() - cached.at < COLUMN_LABELS_TTL_MS) return cached.labels;
  const res = await mondayRequest<{ boards: { columns: { id: string; settings_str: string }[] }[] }>(
    `query ($boardId: ID!, $columnId: [String!]) {
      boards(ids: [$boardId]) { columns(ids: $columnId) { id settings_str } }
    }`,
    { boardId, columnId: [columnId] },
  );
  const col = res.boards[0]?.columns[0];
  let labels: string[] = [];
  if (col) {
    try {
      const settings = JSON.parse(col.settings_str) as { labels?: Record<string, string> };
      labels = Object.values(settings.labels ?? {});
    } catch {
      labels = [];
    }
  }
  columnLabelsCache.set(key, { at: Date.now(), labels });
  return labels;
}

/**
 * מאמת תווית מול Monday ומחזיר את התווית *האמיתית* לשימוש בכתיבה (לא בהכרח זהה למה שהתקבל).
 * נדרש כי לפחות עמודת תעדוף אחת (color8__1/priority) מכילה בפועל "קריטי ⚠️️" (עם סיומת
 * אמוג'י) ולא "קריטי" — אומת מול Monday החי ב-2026-09-17. המודל (ובני אדם) כותבים "קריטי" בלי
 * האמוג'י, אז התאמה מדויקת בלבד הייתה דוחה תעדוף תקין לגמרי. אם יש בדיוק תווית אחת שמכילה את מה
 * שניתן — משתמשים בה; יותר מאחת/אף אחת → זורקים (לא מנחשים בין כמה אפשרויות).
 */
async function resolveLabel(boardId: string, columnId: string, label: string, fieldName: string): Promise<string> {
  const labels = await getColumnLabels(boardId, columnId);
  if (!labels.length) return label; // העמודה לא נמצאה/אין לה תוויות מוגדרות — לא חוסמים
  if (labels.includes(label)) return label;
  const loose = labels.filter((l) => l.toLowerCase().includes(label.trim().toLowerCase()));
  if (loose.length === 1) return loose[0]!;
  throw new Error(`"${label}" אינו ${fieldName} חוקי. אפשרויות: ${labels.join(", ")}`);
}

export interface CreateStageTaskInput {
  /** מזהה ה-item של השלב (parent), לא itemId של משימה קיימת */
  stageItemId: string;
  name: string;
  personId: string;
  /** YYYY-MM-DD */
  dueDate?: string;
  priority?: string;
  /** "באחריות" — המשרד/וועדה/הלקוח/קבלן. ברירת מחדל "המשרד". */
  responsibleParty?: string;
}

/** יוצר משימה כ-subitem תחת ה-item של השלב הנכון (BOARD_PROJECT_STAGE_TASKS). */
export async function createStageTask(input: CreateStageTaskInput): Promise<{ id: string; name: string }> {
  const name = input.name.trim();
  if (!name) throw new Error("חסר שם למשימה");
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
    throw new Error(`תאריך לא תקין: "${input.dueDate}" (צריך YYYY-MM-DD)`);
  }
  const responsibleParty = await resolveLabel(
    BOARD_PROJECT_STAGE_TASKS,
    "color2__1",
    input.responsibleParty ?? "המשרד",
    '"באחריות"',
  );
  const priorityLabel = input.priority
    ? await resolveLabel(BOARD_PROJECT_STAGE_TASKS, "color8__1", input.priority, "תעדוף")
    : undefined;

  const columnValues: Record<string, unknown> = {
    person: { personsAndTeams: [{ id: Number(input.personId), kind: "person" }] },
    color85__1: { label: "לביצוע" },
    color2__1: { label: responsibleParty },
  };
  if (input.dueDate) columnValues.date__1 = { date: input.dueDate };
  if (priorityLabel) columnValues.color8__1 = { label: priorityLabel };

  const res = await mondayRequest<{ create_subitem: { id: string; name: string } }>(
    `mutation ($parentItemId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_subitem(parent_item_id: $parentItemId, item_name: $itemName, column_values: $columnValues) {
        id
        name
      }
    }`,
    { parentItemId: input.stageItemId, itemName: name, columnValues: JSON.stringify(columnValues) },
  );
  return res.create_subitem;
}

let generalGroupCache: { at: number; groupId: string } | null = null;
const GENERAL_GROUP_TTL_MS = 30 * 60_000;

/**
 * קבוצת ברירת המחדל למשימות משרד כלליות. הבורד הזה שטוח (לא מקובץ לפי פרויקט כמו מאגר
 * המשימות) — לוקחים את הקבוצה הראשונה. אומת מול Monday החי ב-2026-09-17 (קריאה בלבד): הקבוצה
 * הראשונה היא "topics" / "משימות חדשות" — בדיוק הקבוצה הסמנטית הנכונה למשימה שנוצרת עכשיו
 * (שאר הקבוצות: "בעבודה", "משימות שבוצעו", "משימות רקע"). לא הנחה שנשארה לא מאומתת.
 */
async function generalTasksGroupId(): Promise<string> {
  if (generalGroupCache && Date.now() - generalGroupCache.at < GENERAL_GROUP_TTL_MS) return generalGroupCache.groupId;
  const res = await mondayRequest<{ boards: { groups: { id: string }[] }[] }>(
    `query ($boardId: ID!) { boards(ids: [$boardId]) { groups { id } } }`,
    { boardId: BOARD_GENERAL_TASKS },
  );
  const groupId = res.boards[0]?.groups[0]?.id;
  if (!groupId) throw new Error(`לבורד ${BOARD_GENERAL_TASKS} אין קבוצות`);
  generalGroupCache = { at: Date.now(), groupId };
  return groupId;
}

export interface CreateGeneralTaskInput {
  name: string;
  personId: string;
  dueDate?: string;
  priority?: string;
  /** אם ניתן — מקשר את המשימה לפרויקט (board_relation_mkqzzfgt), בלי לשייך אותה לשלב. */
  projectId?: string;
}

/** יוצר משימת משרד כללית (item רגיל, לא subitem) ב-BOARD_GENERAL_TASKS. */
export async function createGeneralTask(input: CreateGeneralTaskInput): Promise<{ id: string; name: string }> {
  const name = input.name.trim();
  if (!name) throw new Error("חסר שם למשימה");
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
    throw new Error(`תאריך לא תקין: "${input.dueDate}" (צריך YYYY-MM-DD)`);
  }
  const priorityLabel = input.priority
    ? await resolveLabel(BOARD_GENERAL_TASKS, "priority", input.priority, "תעדוף")
    : undefined;

  const groupId = await generalTasksGroupId();
  const columnValues: Record<string, unknown> = {
    person: { personsAndTeams: [{ id: Number(input.personId), kind: "person" }] },
    status: { label: "לביצוע" },
  };
  if (input.dueDate) columnValues.date4 = { date: input.dueDate };
  if (priorityLabel) columnValues.priority = { label: priorityLabel };
  if (input.projectId) columnValues.board_relation_mkqzzfgt = { item_ids: [Number(input.projectId)] };

  const res = await mondayRequest<{ create_item: { id: string; name: string } }>(
    `mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
        id
        name
      }
    }`,
    { boardId: BOARD_GENERAL_TASKS, groupId, itemName: name, columnValues: JSON.stringify(columnValues) },
  );
  return res.create_item;
}
