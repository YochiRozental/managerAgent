/**
 * קריאת משימות פר-עובד לצורך שלוש התצוגות של החלונית (שלב 1).
 *
 * שני מקורות משימה:
 *  1. בורד "משימות 📝" 1550734526 — משימות משרד כלליות.
 *  2. תת-פריטים של "מאגר משימות פרויקטים 🗒️" (בורד 1550734556) — משימות בתוך שלבי פרויקט.
 *
 * ה-IDs של העמודות נלקחו מ-get_board_info (2026-09-02) — ראה מפת הבורדים ב-CLAUDE.md סעיף 4.
 * סינון "בוצע" נעשה כאן לפי רשימת תוויות קשיחה (ה-API לא מחזיר is_done בערך הטקסט).
 *
 * הערה על סינון לפי אדם: query_params של items_page לא מקבל מזהה משתמש מספרי ישירות בבורדים האלה —
 * הפורמט שעובד הוא compare_value: ["person-<id>"] עם operator any_of (נבדק מול ה-API).
 */

import { mondayRequest } from "./client.js";

const MONDAY_HOST = "https://gottlieb-league.monday.com";

export const BOARD_GENERAL_TASKS = "1550734526";
export const BOARD_PROJECT_STAGES = "1550734531";
export const BOARD_PROJECT_STAGE_TASKS = "1550734556";
export const BOARD_PROJECTS = "1550734533";

/** תוויות שמשמעותן "סגור" — לא מוצג בשום תצוגה. */
const GENERAL_DONE = new Set(["בוצע", "מושהה"]);
const STAGE_TASK_DONE = new Set(["הושלם", "לא רלוונטי"]);

export type OpsTaskSource = "general" | "project_stage";

export interface OpsTask {
  source: OpsTaskSource;
  itemId: string;
  name: string;
  url: string;
  /** שם הפרויקט, או "משימת משרד" למשימה כללית */
  context: string;
  /** שם השלב (רק למשימת פרויקט) */
  stageName?: string;
  /** תווית סטטוס גולמית; "" אם לא הוגדר */
  status: string;
  /** תווית תעדוף אם קיימת ("קריטי ⚠️", "גבוה", ...) */
  priority?: string;
  /** תאריך יעד YYYY-MM-DD, או undefined */
  dueDate?: string;
  /** "באחריות" — המשרד / וועדה / הלקוח / קבלן. רק למשימת פרויקט. */
  responsibleParty?: string;
  /** טקסט עמודת האחראי, למשל "מוטי, דוב שפירא" */
  assignees: string;
}

function assertNumericId(id: string): void {
  if (!/^\d+$/.test(id)) throw new Error(`מזהה משתמש Monday לא תקין: "${id}"`);
}

type RawColumnValue = {
  id: string;
  text: string | null;
  display_value?: string | null;
  linked_item_ids?: string[] | null;
};

function cv(values: RawColumnValue[], id: string): string {
  const v = values.find((c) => c.id === id);
  // עמודות board_relation/mirror מחזירות text=null אך display_value עם שמות הפריטים המקושרים.
  return (v?.display_value || v?.text || "").trim();
}

/** עמודות תאריך ב-Monday יכולות לחזור כ-"YYYY-MM-DD" או "YYYY-MM-DD HH:MM" — משאירים רק את היום. */
function dateOnly(text: string): string | undefined {
  const m = text.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : undefined;
}

type RawItem = {
  id: string;
  name: string;
  column_values: RawColumnValue[];
  parent_item?: {
    name: string;
    column_values: RawColumnValue[];
  } | null;
};

/** ל-board_relation/mirror צריך את display_value — text מגיע null גם כשיש פריטים מקושרים. */
const REL_FRAGMENT = `... on BoardRelationValue { display_value } ... on MirrorValue { display_value }`;

/** משימות משרד כלליות של המשתמש (בורד 1550734526). */
async function fetchGeneralTasks(mondayUserId: string): Promise<OpsTask[]> {
  const rule = `{ column_id: "person", compare_value: ["person-${mondayUserId}"], operator: any_of }`;
  const selection = `
    id
    name
    column_values(ids: ["status", "priority", "date4", "person", "board_relation_mkqzzfgt"]) { id text ${REL_FRAGMENT} }
  `;

  const first = await mondayRequest<{
    boards: { items_page: { cursor: string | null; items: RawItem[] } }[];
  }>(
    `query {
      boards(ids: [${BOARD_GENERAL_TASKS}]) {
        items_page(limit: 200, query_params: { rules: [${rule}] }) {
          cursor
          items { ${selection} }
        }
      }
    }`,
  );

  const page = first.boards[0]?.items_page;
  const items: RawItem[] = page ? [...page.items] : [];
  let cursor = page?.cursor ?? null;
  while (cursor) {
    const next = await mondayRequest<{
      next_items_page: { cursor: string | null; items: RawItem[] };
    }>(
      `query ($cursor: String!) {
        next_items_page(cursor: $cursor, limit: 200) { cursor items { ${selection} } }
      }`,
      { cursor },
    );
    items.push(...next.next_items_page.items);
    cursor = next.next_items_page.cursor;
  }

  const out: OpsTask[] = [];
  for (const item of items) {
    const status = cv(item.column_values, "status");
    if (GENERAL_DONE.has(status)) continue;
    const project = cv(item.column_values, "board_relation_mkqzzfgt");
    out.push({
      source: "general",
      itemId: item.id,
      name: item.name,
      url: `${MONDAY_HOST}/boards/${BOARD_GENERAL_TASKS}/pulses/${item.id}`,
      context: project || "משימת משרד",
      status,
      priority: cv(item.column_values, "priority") || undefined,
      dueDate: dateOnly(cv(item.column_values, "date4")),
      assignees: cv(item.column_values, "person"),
    });
  }
  return out;
}

/** משימות בתוך שלבי פרויקט של המשתמש (תת-פריטים, בורד 1550734556). */
async function fetchProjectStageTasks(mondayUserId: string): Promise<OpsTask[]> {
  const rule = `{ column_id: "person", compare_value: ["person-${mondayUserId}"], operator: any_of }`;
  const selection = `
    id
    name
    column_values(ids: ["color85__1", "color8__1", "date__1", "color2__1", "person"]) { id text }
    parent_item {
      name
      column_values(ids: ["connect_boards4__1"]) { id text ${REL_FRAGMENT} }
    }
  `;

  const first = await mondayRequest<{
    boards: { items_page: { cursor: string | null; items: RawItem[] } }[];
  }>(
    `query {
      boards(ids: [${BOARD_PROJECT_STAGE_TASKS}]) {
        items_page(limit: 200, query_params: { rules: [${rule}] }) {
          cursor
          items { ${selection} }
        }
      }
    }`,
  );

  const page = first.boards[0]?.items_page;
  const items: RawItem[] = page ? [...page.items] : [];
  let cursor = page?.cursor ?? null;
  while (cursor) {
    const next = await mondayRequest<{
      next_items_page: { cursor: string | null; items: RawItem[] };
    }>(
      `query ($cursor: String!) {
        next_items_page(cursor: $cursor, limit: 200) { cursor items { ${selection} } }
      }`,
      { cursor },
    );
    items.push(...next.next_items_page.items);
    cursor = next.next_items_page.cursor;
  }

  const out: OpsTask[] = [];
  for (const item of items) {
    const status = cv(item.column_values, "color85__1");
    if (STAGE_TASK_DONE.has(status)) continue;
    const project = item.parent_item ? cv(item.parent_item.column_values, "connect_boards4__1") : "";
    out.push({
      source: "project_stage",
      itemId: item.id,
      name: item.name,
      url: `${MONDAY_HOST}/boards/${BOARD_PROJECT_STAGE_TASKS}/pulses/${item.id}`,
      context: project || "פרויקט לא מקושר",
      stageName: item.parent_item?.name,
      status,
      priority: cv(item.column_values, "color8__1") || undefined,
      dueDate: dateOnly(cv(item.column_values, "date__1")),
      responsibleParty: cv(item.column_values, "color2__1") || undefined,
      assignees: cv(item.column_values, "person"),
    });
  }
  return out;
}

/**
 * כל המשימות הפתוחות של המשתמש משני המקורות, ממוין לפי תאריך יעד (ריק — בסוף).
 * שגיאה באחד המקורות נזרקת החוצה במכוון — עדיף שהחלונית תציג "לא הצלחתי לטעון" מאשר רשימה
 * ריקה שגורמת לעובד לחשוב שאין לו כלום.
 */
export async function fetchUserOpsTasks(mondayUserId: string): Promise<OpsTask[]> {
  assertNumericId(mondayUserId);
  const [general, stages] = await Promise.all([
    fetchGeneralTasks(mondayUserId),
    fetchProjectStageTasks(mondayUserId),
  ]);
  const all = [...general, ...stages];
  all.sort((a, b) => (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99"));
  return all;
}

// ---------------------------------------------------------------------------
// תלויות הפוכות — "מי מחכה לי"
//
// עמודת dependency__1 בתת-פריט מצביעה על המשימות שהיא *חסומה בגללן*. כדי לענות על "מי מחכה
// למשימה שלי" צריך את הכיוון ההפוך: לסרוק את כל המשימות שיש להן תלות, ולבנות מפה
// blockerId → [המשימות הפתוחות שתלויות בו]. המפה נשמרת ב-cache קצר כי תלויות משתנות לעיתים רחוקות.
// ---------------------------------------------------------------------------

export interface DependentRef {
  itemId: string;
  name: string;
  assignees: string;
  project: string;
}

let reverseDepCache: { at: number; map: Map<string, DependentRef[]> } | null = null;
const REVERSE_DEP_TTL_MS = 5 * 60_000;

export async function getReverseDependencyMap(): Promise<Map<string, DependentRef[]>> {
  if (reverseDepCache && Date.now() - reverseDepCache.at < REVERSE_DEP_TTL_MS) {
    return reverseDepCache.map;
  }

  const selection = `
    id
    name
    column_values(ids: ["dependency__1", "color85__1", "person"]) {
      id text
      ... on DependencyValue { linked_item_ids }
    }
    parent_item { column_values(ids: ["connect_boards4__1"]) { id text ${REL_FRAGMENT} } }
  `;

  const first = await mondayRequest<{
    boards: { items_page: { cursor: string | null; items: RawItem[] } }[];
  }>(
    `query {
      boards(ids: [${BOARD_PROJECT_STAGE_TASKS}]) {
        items_page(
          limit: 200
          query_params: { rules: [{ column_id: "dependency__1", compare_value: [""], operator: is_not_empty }] }
        ) {
          cursor
          items { ${selection} }
        }
      }
    }`,
  );

  const page = first.boards[0]?.items_page;
  const items: RawItem[] = page ? [...page.items] : [];
  let cursor = page?.cursor ?? null;
  while (cursor) {
    const next = await mondayRequest<{
      next_items_page: { cursor: string | null; items: RawItem[] };
    }>(
      `query ($cursor: String!) {
        next_items_page(cursor: $cursor, limit: 200) { cursor items { ${selection} } }
      }`,
      { cursor },
    );
    items.push(...next.next_items_page.items);
    cursor = next.next_items_page.cursor;
  }

  const map = new Map<string, DependentRef[]>();
  for (const item of items) {
    const status = cv(item.column_values, "color85__1");
    if (STAGE_TASK_DONE.has(status)) continue; // משימה סגורה כבר לא "מחכה" לאף אחד
    const blockerIds = item.column_values.find((c) => c.id === "dependency__1")?.linked_item_ids ?? [];
    if (blockerIds.length === 0) continue;
    const ref: DependentRef = {
      itemId: item.id,
      name: item.name,
      assignees: cv(item.column_values, "person"),
      project: (item.parent_item && cv(item.parent_item.column_values, "connect_boards4__1")) || "",
    };
    for (const blockerId of blockerIds) {
      const arr = map.get(blockerId);
      if (arr) arr.push(ref);
      else map.set(blockerId, [ref]);
    }
  }

  reverseDepCache = { at: Date.now(), map };
  return map;
}

// ---------------------------------------------------------------------------
// פרויקטים פעילים — לתצוגת הבקרה של מוטי
// ---------------------------------------------------------------------------

/** קבוצות בבורד הפרויקטים שלא רלוונטיות לבקרה שוטפת. */
const PROJECT_GROUPS_EXCLUDE = new Set([
  "new_group4414__1", // טמפלייטים
  "group_title", // פרויקטים שהסתיימו
  "group_mkph3435", // נמכרו
]);
const PROJECT_STATUS_CLOSED = new Set(["הסתיים", "נמכר"]);

export interface ProjectMeta {
  itemId: string;
  name: string;
  owner: string;
  status: string;
  deliveryDate?: string;
  groupTitle: string;
}

export async function fetchActiveProjects(): Promise<ProjectMeta[]> {
  const selection = `
    id
    name
    group { id title }
    column_values(ids: ["person", "status_17__1", "date4__1"]) { id text }
  `;

  const first = await mondayRequest<{
    boards: { items_page: { cursor: string | null; items: (RawItem & { group: { id: string; title: string } })[] } }[];
  }>(
    `query {
      boards(ids: [${BOARD_PROJECTS}]) {
        items_page(limit: 200) { cursor items { ${selection} } }
      }
    }`,
  );

  const page = first.boards[0]?.items_page;
  const items = page ? [...page.items] : [];
  let cursor = page?.cursor ?? null;
  while (cursor) {
    const next = await mondayRequest<{
      next_items_page: { cursor: string | null; items: (RawItem & { group: { id: string; title: string } })[] };
    }>(
      `query ($cursor: String!) {
        next_items_page(cursor: $cursor, limit: 200) { cursor items { ${selection} } }
      }`,
      { cursor },
    );
    items.push(...next.next_items_page.items);
    cursor = next.next_items_page.cursor;
  }

  const out: ProjectMeta[] = [];
  for (const item of items) {
    if (PROJECT_GROUPS_EXCLUDE.has(item.group?.id)) continue;
    const status = cv(item.column_values, "status_17__1");
    if (PROJECT_STATUS_CLOSED.has(status)) continue;
    out.push({
      itemId: item.id,
      name: item.name,
      owner: cv(item.column_values, "person"),
      status,
      deliveryDate: dateOnly(cv(item.column_values, "date4__1")),
      groupTitle: item.group?.title ?? "",
    });
  }
  return out;
}
