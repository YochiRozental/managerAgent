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
  /** מזהה פריט הפרויקט ב-Monday (רק למשימת פרויקט מקושרת) — לחישוב "הפעולה הבאה" של הפרויקט */
  projectId?: string;
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
  persons_and_teams?: { id: string }[] | null;
};

function cv(values: RawColumnValue[], id: string): string {
  const v = values.find((c) => c.id === id);
  // עמודות board_relation/mirror מחזירות text=null אך display_value עם שמות הפריטים המקושרים.
  return (v?.display_value || v?.text || "").trim();
}

/** מזהי המשתמשים בעמודת people — לזיהוי מדויק (לא לפי טקסט/שם), למשל "מי מנהל/ת את הפרויקט". */
function personIds(values: RawColumnValue[], id: string): string[] {
  return (values.find((c) => c.id === id)?.persons_and_teams ?? []).map((p) => String(p.id));
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
const REL_FRAGMENT = `... on BoardRelationValue { display_value linked_item_ids } ... on MirrorValue { display_value }`;
const PEOPLE_FRAGMENT = `... on PeopleValue { persons_and_teams { id } }`;

function linkedIds(values: RawColumnValue[], id: string): string[] {
  return values.find((c) => c.id === id)?.linked_item_ids ?? [];
}

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
    const projectId = linkedIds(item.column_values, "board_relation_mkqzzfgt")[0];
    out.push({
      source: "general",
      itemId: item.id,
      name: item.name,
      url: `${MONDAY_HOST}/boards/${BOARD_GENERAL_TASKS}/pulses/${item.id}`,
      context: project || "משימת משרד",
      projectId,
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
    const projectId = item.parent_item ? linkedIds(item.parent_item.column_values, "connect_boards4__1")[0] : undefined;
    out.push({
      source: "project_stage",
      itemId: item.id,
      name: item.name,
      url: `${MONDAY_HOST}/boards/${BOARD_PROJECT_STAGE_TASKS}/pulses/${item.id}`,
      context: project || "פרויקט לא מקושר",
      projectId,
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
  /**
   * מזהי Monday של מי שבעמודת האחראי/ת (person, board 1550734533) — מקור האמת ל"מנהל פרויקט"
   * (CLAUDE.md §3: "מנהל פרויקט = מי שמופיע ב'אחראי/ת' של הפרויקט"). ID ולא טקסט, כדי שסינון
   * הרשאות (assertManagesProject ב-actions.ts) לא יתבסס על התאמת שם.
   */
  ownerIds: string[];
  status: string;
  deliveryDate?: string;
  groupTitle: string;
}

export async function fetchActiveProjects(): Promise<ProjectMeta[]> {
  const selection = `
    id
    name
    group { id title }
    column_values(ids: ["person", "status_17__1", "date4__1"]) { id text ${PEOPLE_FRAGMENT} }
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
      ownerIds: personIds(item.column_values, "person"),
      status,
      deliveryDate: dateOnly(cv(item.column_values, "date4__1")),
      groupTitle: item.group?.title ?? "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// "הפעולה הבאה" של פרויקט — מחושבת, לא נשמרת (CLAUDE.md סעיף 6)
//
// המשימה הפתוחה הראשונה בסריקת השלבים לפי מספר ("שלב N") ובתוך כל שלב לפי הסדר,
// מדלגים על מה שהושלם/לא רלוונטי ועל משימה שתלויה במשימה שעדיין לא הושלמה.
//
// הערה מהדאטה האמיתי: סטטוס השלב עצמו כמעט תמיד ריק — לכן לא מסתמכים עליו, רק על
// סטטוס תת-המשימות. הסדר שמתקבל מ-items(ids:) אינו סדר השלבים — חובה למיין לפי המספר.
// ---------------------------------------------------------------------------

export interface ProjectNextAction {
  projectId: string;
  stageName: string;
  taskId: string;
  taskName: string;
  status: string;
  assignees: string;
  dueDate?: string;
}

/** מספר השלב מתוך שמו ("שלב 3" → 3). שלב בלי מספר בשם נדחק לסוף המיון (999). */
export const stageNumber = (name: string): number => {
  const m = name.match(/שלב\s*0*(\d+)/);
  return m ? parseInt(m[1]!, 10) : 999;
};

// ---------------------------------------------------------------------------
// שלבי פרויקט — קריאה משותפת ל"הפעולה הבאה" (getProjectNextAction) ול-יצירת משימה חדשה
// (create_task, ר' src/ops/actions.ts). מקור אמת אחד ללוגיקת השלבים כדי שלא יתפצלו.
// ---------------------------------------------------------------------------

export interface StageSubitem {
  id: string;
  name: string;
  status: string;
  assignees: string;
  dueDate?: string;
  /** מזהי המשימות שהמשימה הזו תלויה/חסומה בהן (dependency__1) */
  blockedBy: string[];
}

export interface ProjectStage {
  id: string;
  name: string;
  subitems: StageSubitem[];
}

const stagesCache = new Map<string, { at: number; value: ProjectStage[] }>();
const STAGES_TTL_MS = 5 * 60_000;

/** שלבי הפרויקט (link_to____________9__1) עם תת-הפריטים שלהם, ממוין לפי מספר השלב. */
export async function getProjectStages(projectId: string): Promise<ProjectStage[]> {
  if (!/^\d+$/.test(projectId)) return [];
  const cached = stagesCache.get(projectId);
  if (cached && Date.now() - cached.at < STAGES_TTL_MS) return cached.value;

  const proj = await mondayRequest<{ items: { column_values: RawColumnValue[] }[] }>(
    `query ($id: [ID!]) {
      items(ids: $id) {
        column_values(ids: ["link_to____________9__1"]) { id text ${REL_FRAGMENT} }
      }
    }`,
    { id: [projectId] },
  );
  const stageIds = proj.items[0] ? linkedIds(proj.items[0].column_values, "link_to____________9__1") : [];
  if (stageIds.length === 0) {
    stagesCache.set(projectId, { at: Date.now(), value: [] });
    return [];
  }

  type Sub = { id: string; name: string; column_values: RawColumnValue[] };
  const res = await mondayRequest<{ items: { id: string; name: string; subitems: Sub[] }[] }>(
    `query ($ids: [ID!]) {
      items(ids: $ids) {
        id
        name
        subitems {
          id
          name
          column_values(ids: ["color85__1", "person", "date__1", "dependency__1"]) {
            id text
            ... on DependencyValue { linked_item_ids }
          }
        }
      }
    }`,
    { ids: stageIds.slice(0, 100) },
  );

  const value: ProjectStage[] = [...res.items]
    .sort((a, b) => stageNumber(a.name) - stageNumber(b.name))
    .map((st) => ({
      id: st.id,
      name: st.name,
      subitems: st.subitems.map((sub) => ({
        id: sub.id,
        name: sub.name,
        status: cv(sub.column_values, "color85__1"),
        assignees: cv(sub.column_values, "person"),
        dueDate: dateOnly(cv(sub.column_values, "date__1")),
        blockedBy: linkedIds(sub.column_values, "dependency__1"),
      })),
    }));

  stagesCache.set(projectId, { at: Date.now(), value });
  return value;
}

/**
 * אינדקס "השלב הנוכחי" ברשימת שלבים ממוינת — השלב הגבוה ביותר שיש בו משימה שהושלמה (אם אין —
 * השלב הראשון). פונקציה טהורה כדי שגם getProjectNextAction וגם create_task ישתמשו באותה הגדרה.
 */
export function currentStageIndex(stages: ProjectStage[]): number {
  const isDone = (sub: StageSubitem) => STAGE_TASK_DONE.has(sub.status);
  const lastTouched = stages.reduce((acc, st, i) => (st.subitems.some(isDone) ? i : acc), -1);
  return lastTouched >= 0 ? lastTouched : 0;
}

/**
 * מתאים שלבים לפי טקסט חופשי — ל-create_task כשהעובד ציין שלב במפורש. מספר ("שלב 3"/"3") גובר
 * אם יש התאמה מספרית חד-משמעית; אחרת התאמת תת-מחרוזת בשם. לא מנחש — מחזיר את כל ההתאמות,
 * הקורא מחליט (0=לא נמצא, 1=חד-משמעי, 2+=עמום).
 */
export function matchStagesByQuery(stages: ProjectStage[], query: string): ProjectStage[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const num = q.match(/\d+/)?.[0];
  if (num) {
    const byNumber = stages.filter((s) => stageNumber(s.name) === Number(num));
    if (byNumber.length === 1) return byNumber;
  }
  return stages.filter((s) => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase()));
}

/** מתאים פרויקטים לפי טקסט חופשי — ל-create_task. אותו עיקרון: לא מנחש, מחזיר את כל ההתאמות. */
export function matchProjectsByQuery(projects: ProjectMeta[], query: string): ProjectMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return projects.filter((p) => p.name.toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// זיהוי "לאיזה פרויקט שייך פריט" — לאכיפת project scope (reassignItem/updateTask/create_task,
// החלטת יוכי 2026-09-17/24). כל קשר אומת חי מול Monday (2026-09-24, קריאה בלבד, ללא כתיבה):
//  - stage item (1550734531): connect_boards4__1 מצביע חזרה על הפרויקט (נבדק: שלב אמיתי → אותו
//    projectId שממנו הגענו אליו דרך link_to____________9__1).
//  - subitem (1550734556): parent_item (=ה-stage) נושא את אותו connect_boards4__1.
//  - משימת משרד (1550734526): board_relation_mkqzzfgt — קיים רק על חלק מהמשימות; משימה בלי
//    קישור מחזירה projectId=null באופן לגיטימי (אין לה "פרויקט" בכלל, לא שגיאה).
//  - בקשת column_values(ids:[...]) עם עמודות שלא קיימות בבורד של הפריט (למשל על ליד) פשוט
//    מוחזרת ריקה — לא שגיאה — נבדק חי מול בורד הלידים 1550734525.
// ---------------------------------------------------------------------------

export interface ItemProjectScope {
  boardId: string;
  /** מזהה הפרויקט של הפריט, או null אם אין מושג "פרויקט" רלוונטי (ליד/עסקה/משימת משרד לא-מקושרת) */
  projectId: string | null;
}

/** לוחות שבהם *כל* פריט חייב להיות שייך לפרויקט — projectId=null עליהם הוא דאטה חריגה, לא "אין קשר". */
export const BOARDS_WITH_MANDATORY_PROJECT = new Set([BOARD_PROJECTS, BOARD_PROJECT_STAGES, BOARD_PROJECT_STAGE_TASKS]);

/**
 * מזהה לאיזה פרויקט שייך פריט Monday נתון, לפי סוג הבורד שלו. לא מנחש — לכל בורד קשר שכבר
 * מתועד ונבדק בקוד הקיים (ר' fetchGeneralTasks/fetchProjectStageTasks למעלה שכבר משתמשים
 * באותם column ids). מחזיר null (לא ItemProjectScope|null אלא .projectId=null) על בורד בלי
 * מושג פרויקט (לידים/עסקאות/...), ו-null כולו רק אם הפריט עצמו לא נמצא.
 */
export async function resolveItemProjectScope(itemId: string): Promise<ItemProjectScope | null> {
  if (!/^\d+$/.test(itemId)) return null;
  const res = await mondayRequest<{
    items: {
      id: string;
      board: { id: string } | null;
      column_values: RawColumnValue[];
      parent_item: { column_values: RawColumnValue[] } | null;
    }[];
  }>(
    `query ($id: [ID!]) {
      items(ids: $id) {
        id
        board { id }
        column_values(ids: ["connect_boards4__1", "board_relation_mkqzzfgt"]) { id text ${REL_FRAGMENT} }
        parent_item {
          column_values(ids: ["connect_boards4__1"]) { id text ${REL_FRAGMENT} }
        }
      }
    }`,
    { id: [itemId] },
  );
  const item = res.items[0];
  if (!item || !item.board) return null;
  const boardId = item.board.id;

  if (boardId === BOARD_PROJECTS) return { boardId, projectId: itemId };
  if (boardId === BOARD_PROJECT_STAGES) {
    return { boardId, projectId: linkedIds(item.column_values, "connect_boards4__1")[0] ?? null };
  }
  if (boardId === BOARD_PROJECT_STAGE_TASKS) {
    const pid = item.parent_item ? (linkedIds(item.parent_item.column_values, "connect_boards4__1")[0] ?? null) : null;
    return { boardId, projectId: pid };
  }
  if (boardId === BOARD_GENERAL_TASKS) {
    return { boardId, projectId: linkedIds(item.column_values, "board_relation_mkqzzfgt")[0] ?? null };
  }
  return { boardId, projectId: null }; // ליד/עסקה/כל בורד אחר — אין מושג פרויקט
}

/** מזהי האחראי/ת (person) של פרויקט ספציפי — לבדיקת scope כשאין כבר ProjectMeta בהישג יד. */
export async function getProjectOwnerIds(projectId: string): Promise<string[]> {
  if (!/^\d+$/.test(projectId)) return [];
  const res = await mondayRequest<{ items: { column_values: RawColumnValue[] }[] }>(
    `query ($id: [ID!]) {
      items(ids: $id) {
        column_values(ids: ["person"]) { id text ${PEOPLE_FRAGMENT} }
      }
    }`,
    { id: [projectId] },
  );
  return personIds(res.items[0]?.column_values ?? [], "person");
}

export interface ActiveStage {
  stage: ProjectStage;
  /** המשימה הפתוחה הראשונה (לא הושלמה, לא חסומה) בתוך אותו שלב */
  openTask: StageSubitem;
}

/**
 * "השלב הפעיל" האמיתי — סורק מ-currentStageIndex קדימה ומחזיר את השלב הראשון שיש בו משימה
 * פתוחה ולא חסומה, יחד עם אותה משימה (לא רק "הכי מאוחר שנגעו בו" — currentStageIndex לבד יכול
 * להצביע על שלב שכולו כבר הושלם, אם המשימה הפתוחה הבאה נמצאת בשלב הבא). null אם כל השלבים
 * סגורים/חסומים — הקורא מחליט מה ברירת המחדל במקרה הזה (אין "שלב פעיל" ברור).
 * משותף ל-getProjectNextAction (הפעולה הבאה) ול-create_task (ברירת מחדל לשלב חדש) — מקור
 * אמת אחד, כדי שהתדריך היומי ("עכשיו:") ומשימה חדשה בלי שלב מפורש תמיד יסכימו על "איפה אנחנו".
 */
export function findActiveStage(stages: ProjectStage[]): ActiveStage | null {
  const isDone = (sub: StageSubitem) => STAGE_TASK_DONE.has(sub.status);
  const doneIds = new Set<string>();
  const allSubIds = new Set<string>();
  for (const st of stages) {
    for (const sub of st.subitems) {
      allSubIds.add(sub.id);
      if (isDone(sub)) doneIds.add(sub.id);
    }
  }
  const isBlocked = (sub: StageSubitem) => sub.blockedBy.some((d) => allSubIds.has(d) && !doneIds.has(d));
  const startIdx = currentStageIndex(stages);
  for (let i = startIdx; i < stages.length; i++) {
    const st = stages[i]!;
    const openTask = st.subitems.find((sub) => !doneIds.has(sub.id) && !isBlocked(sub));
    if (openTask) return { stage: st, openTask };
  }
  return null;
}

const nextActionCache = new Map<string, { at: number; value: ProjectNextAction | null }>();
const NEXT_ACTION_TTL_MS = 5 * 60_000;

export async function getProjectNextAction(projectId: string): Promise<ProjectNextAction | null> {
  if (!/^\d+$/.test(projectId)) return null;
  const cached = nextActionCache.get(projectId);
  if (cached && Date.now() - cached.at < NEXT_ACTION_TTL_MS) return cached.value;

  const stages = await getProjectStages(projectId);
  if (stages.length === 0) {
    nextActionCache.set(projectId, { at: Date.now(), value: null });
    return null;
  }

  const active = findActiveStage(stages);
  const value: ProjectNextAction | null = active
    ? {
        projectId,
        stageName: active.stage.name,
        taskId: active.openTask.id,
        taskName: active.openTask.name,
        status: active.openTask.status,
        assignees: active.openTask.assignees,
        dueDate: active.openTask.dueDate,
      }
    : null;

  nextActionCache.set(projectId, { at: Date.now(), value });
  return value;
}
