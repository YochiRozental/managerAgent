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
import { BOARD_GENERAL_TASKS, BOARD_PROJECT_STAGES, BOARD_PROJECT_STAGE_TASKS, BOARD_PROJECTS, type OpsTaskSource } from "./opsRead.js";

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
  // בכוונה לא כולל board_relation_mkqzzfgt כאן — ר' הערה למטה.

  const res = await mondayRequest<{ create_item: { id: string; name: string } }>(
    `mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
        id
        name
      }
    }`,
    { boardId: BOARD_GENERAL_TASKS, groupId, itemName: name, columnValues: JSON.stringify(columnValues) },
  );

  // קישור לפרויקט (board_relation_mkqzzfgt) — בכוונה *לא* דרך column_values של create_item.
  // אובחן ב-production ב-2026-09-22 (item 3237786923, "להתקשר ליוכי"): person/status נכתבו
  // נכון מאותו column_values בדיוק, אבל board_relation_mkqzzfgt נשאר ריק — create_item לא כותב
  // בפועל עמודות connect_boards inline. change_column_value בנפרד (אותה שיטה שכבר מוכחת עובדת
  // ב-setTaskDueDate/setTaskStatus) הוא התיקון.
  if (input.projectId) {
    await mondayRequest(
      `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
      }`,
      {
        boardId: BOARD_GENERAL_TASKS,
        itemId: res.create_item.id,
        columnId: "board_relation_mkqzzfgt",
        value: JSON.stringify({ item_ids: [Number(input.projectId)] }),
      },
    );
  }

  return res.create_item;
}

// ---------------------------------------------------------------------------
// יצירת שלב חדש בפרויקט (create_project_stage, ר' src/ops/actions.ts) — item חדש בבורד
// "מאגר משימות פרויקטים" (BOARD_PROJECT_STAGES), בקבוצת השלבים של הפרויקט הנכון, מקושר אליו.
//
// נבדק חי מול Monday (קריאה בלבד, 2026-09-22): קבוצה בבורד השלבים = פרויקט אחד (כותרת הקבוצה
// בד"כ קרובה לשם הפרויקט אבל לא בהכרח זהה מילה-במילה — לא סומכים על התאמת מחרוזת בלבד כשיש
// כבר שלב קיים לקחת ממנו את מזהה הקבוצה). סטטוס השלב עצמו כמעט תמיד ריק בדאטה האמיתי (ר'
// CLAUDE.md) — לא ממציאים ברירת מחדל, משאירים ריק כמו רוב השלבים הקיימים.
//
// connect_boards4__1 (שלב→פרויקט) ו-link_to____________9__1 (פרויקט→שלב) הם connect_boards
// עם boardIds שמצביעים זה על זה (settings_str נבדק חי) — נראה כמו טור מקושר דו-כיווני, אבל
// באותו אופן שבו create_item לא כתב בפועל board_relation_mkqzzfgt inline (ר' createGeneralTask
// למעלה), לא סומכים על מיראור אוטומטי: קוראים חזרה את הפרויקט אחרי הכתיבה ומוודאים/משלימים את
// הצד השני בעצמנו (ensureProjectLinksStage) — בטוח משני הכיוונים: אם Monday כבר סינכרן לבד,
// הקריאה החוזרת פשוט מוצאת את השלב כבר שם ולא כותבת שוב.
// ---------------------------------------------------------------------------

function normalizeGroupTitle(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/["'׳״]/g, "")
    .replace(/[-,._]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** מזהי הפריטים המקושרים של column_value מסוג board_relation, מהתגובה הגולמית של Monday. */
function readLinkedIds(values: { id: string; linked_item_ids?: string[] | null }[], columnId: string): string[] {
  return values.find((c) => c.id === columnId)?.linked_item_ids ?? [];
}

/**
 * מזהה את הקבוצה בבורד השלבים ששייכת לפרויקט הנתון: אם יש כבר שלב קיים — לוקחים את הקבוצה שלו
 * (מקור אמת ודאי). אחרת מחפשים קבוצה עם כותרת קרובה לשם הפרויקט; אם אין — יוצרים קבוצה חדשה
 * (פרויקט חדש לגמרי בלי אף שלב עדיין, מקרה קצה אמיתי אך נדיר).
 */
async function findOrCreateStageGroupId(projectId: string, projectName: string, existingStageIds: string[]): Promise<string> {
  if (existingStageIds.length > 0) {
    const res = await mondayRequest<{ items: { group: { id: string } | null }[] }>(
      `query ($id: [ID!]) { items(ids: $id) { group { id } } }`,
      { id: [existingStageIds[0]] },
    );
    const groupId = res.items[0]?.group?.id;
    if (groupId) return groupId;
  }

  const boardRes = await mondayRequest<{ boards: { groups: { id: string; title: string }[] }[] }>(
    `query ($boardId: ID!) { boards(ids: [$boardId]) { groups { id title } } }`,
    { boardId: BOARD_PROJECT_STAGES },
  );
  const groups = boardRes.boards[0]?.groups ?? [];
  const nName = normalizeGroupTitle(projectName);
  const match = groups.find((g) => {
    const ng = normalizeGroupTitle(g.title);
    return ng === nName || ng.includes(nName) || nName.includes(ng);
  });
  if (match) return match.id;

  const createRes = await mondayRequest<{ create_group: { id: string } }>(
    `mutation ($boardId: ID!, $groupName: String!) {
      create_group(board_id: $boardId, group_name: $groupName) { id }
    }`,
    { boardId: BOARD_PROJECT_STAGES, groupName: projectName },
  );
  return createRes.create_group.id;
}

/**
 * מוודא ש-link_to____________9__1 של הפרויקט כולל את מזהה השלב החדש — append בלבד (קורא את
 * הרשימה הקיימת קודם), לא overwrite, כדי לא למחוק שלבים אחרים אם אין מיראור אוטומטי.
 */
async function ensureProjectLinksStage(projectId: string, stageId: string): Promise<void> {
  const res = await mondayRequest<{
    items: { column_values: { id: string; linked_item_ids?: string[] | null }[] }[];
  }>(
    `query ($id: [ID!]) {
      items(ids: $id) {
        column_values(ids: ["link_to____________9__1"]) {
          id
          ... on BoardRelationValue { linked_item_ids }
        }
      }
    }`,
    { id: [projectId] },
  );
  const current = readLinkedIds(res.items[0]?.column_values ?? [], "link_to____________9__1");
  if (current.includes(stageId)) return; // כבר שם — או שנכתב אוטומטית (מיראור), או שנקרא כבר מוקדם יותר

  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }`,
    {
      boardId: BOARD_PROJECTS,
      itemId: projectId,
      columnId: "link_to____________9__1",
      value: JSON.stringify({ item_ids: [...current, stageId].map(Number) }),
    },
  );
}

export interface CreateProjectStageInput {
  projectId: string;
  projectName: string;
  /** מזהי השלבים הקיימים של הפרויקט (מ-getProjectStages) — לאיתור ודאי של הקבוצה הנכונה. */
  existingStageIds: string[];
  name: string;
}

/** יוצר שלב (item) חדש בבורד השלבים, בקבוצת הפרויקט הנכונה, ומקשר אותו לפרויקט בשני הכיוונים. */
export async function createProjectStage(input: CreateProjectStageInput): Promise<{ id: string; name: string }> {
  const name = input.name.trim();
  if (!name) throw new Error("חסר שם לשלב");

  const groupId = await findOrCreateStageGroupId(input.projectId, input.projectName, input.existingStageIds);

  const res = await mondayRequest<{ create_item: { id: string; name: string } }>(
    `mutation ($boardId: ID!, $groupId: String!, $itemName: String!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName) { id name }
    }`,
    { boardId: BOARD_PROJECT_STAGES, groupId, itemName: name },
  );

  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }`,
    {
      boardId: BOARD_PROJECT_STAGES,
      itemId: res.create_item.id,
      columnId: "connect_boards4__1",
      value: JSON.stringify({ item_ids: [Number(input.projectId)] }),
    },
  );

  await ensureProjectLinksStage(input.projectId, res.create_item.id);

  return res.create_item;
}
