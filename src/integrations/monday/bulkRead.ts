/**
 * קריאות Monday לסינון ולעדכון קבוצתי (src/ops/bulkQuery.ts / bulkUpdate.ts).
 *
 * שני דברים בלבד:
 *  1. fetchLeadsForBulk — כל הלידים (pagination מלא), עם מזהי האחראים (persons_and_teams) ו-updated_at.
 *     fetchOpenLeads הקיים (crmRead.ts) מחזיר רק טקסט אחראי — לא מספיק לאכיפת scope ("רק הלידים שלי").
 *     סינון לפי אחראי בצד Monday כשניתן (compare_value ["person-<id>"], אותו פורמט שאומת ב-opsRead.ts).
 *  2. readItemsForVerification — קריאה טרייה של רשומות לפי מזהים (items(ids:), עד 100 לקריאה) —
 *     snapshot לפני תצוגת עדכון ושוב רגע לפני הביצוע, כדי לזהות שינוי באמצע.
 *
 * Column IDs לפי מפת הבורדים (CLAUDE.md §4) — אותם IDs ש-opsRead.ts/opsWrite.ts/crmRead.ts כותבים/קוראים.
 */

import { mondayRequest } from "./client.js";
import { BOARD_GENERAL_TASKS, BOARD_PROJECT_STAGE_TASKS, type OpsTaskSource } from "./opsRead.js";
import { BOARD_LEADS } from "./crmRead.js";

const MONDAY_HOST = "https://gottlieb-league.monday.com";

export type BulkItemKind = OpsTaskSource | "lead";

/** עמודות לכל סוג רשומה. priority חסר ללידים (אין עמודת תעדוף בבורד הלידים). */
export const BULK_COLUMNS: Record<
  BulkItemKind,
  { boardId: string; status: string; date: string; priority?: string; people: string; projectRel?: string }
> = {
  general: { boardId: BOARD_GENERAL_TASKS, status: "status", date: "date4", priority: "priority", people: "person", projectRel: "board_relation_mkqzzfgt" },
  project_stage: { boardId: BOARD_PROJECT_STAGE_TASKS, status: "color85__1", date: "date__1", priority: "color8__1", people: "person" },
  lead: { boardId: BOARD_LEADS, status: "color__1", date: "date__1", people: "multiple_person__1" },
};

const BOARD_TO_KIND: Record<string, BulkItemKind> = {
  [BOARD_GENERAL_TASKS]: "general",
  [BOARD_PROJECT_STAGE_TASKS]: "project_stage",
  [BOARD_LEADS]: "lead",
};

type RawCV = {
  id: string;
  text: string | null;
  display_value?: string | null;
  linked_item_ids?: string[] | null;
  persons_and_teams?: { id: string; kind?: string }[] | null;
};

const FRAGMENTS = `... on PeopleValue { persons_and_teams { id kind } } ... on BoardRelationValue { display_value linked_item_ids } ... on MirrorValue { display_value }`;

function cv(vals: RawCV[], id: string | undefined): string {
  if (!id) return "";
  const v = vals.find((c) => c.id === id);
  return (v?.display_value || v?.text || "").trim();
}
function personIds(vals: RawCV[], id: string): string[] {
  return (vals.find((c) => c.id === id)?.persons_and_teams ?? []).filter((p) => !p.kind || p.kind === "person").map((p) => String(p.id));
}
function dateOnly(text: string): string | undefined {
  const m = text.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : undefined;
}

// ---------------------------------------------------------------------------

export interface BulkLead {
  itemId: string;
  name: string;
  status: string;
  /** "תאריך הבא לתזכורת" */
  reminderDate?: string;
  owner: string;
  ownerIds: string[];
  source: string;
  product: string;
  updatedAt?: string;
  url: string;
}

type LeadItem = { id: string; name: string; updated_at?: string | null; column_values: RawCV[] };

const LEAD_COLS = `["color__1", "date__1", "multiple_person__1", "color1__1", "color5__1"]`;

/** כל הלידים בבורד (כולל סגורים — הסינון לפי סטטוס נעשה ב-bulkQuery). ownerMondayId → סינון בצד Monday. */
export async function fetchLeadsForBulk(ownerMondayId?: string): Promise<BulkLead[]> {
  if (ownerMondayId !== undefined && !/^\d+$/.test(ownerMondayId)) throw new Error(`מזהה משתמש Monday לא תקין: "${ownerMondayId}"`);
  const rules = ownerMondayId
    ? `, query_params: { rules: [{ column_id: "multiple_person__1", compare_value: ["person-${ownerMondayId}"], operator: any_of }] }`
    : "";
  const selection = `id name updated_at column_values(ids: ${LEAD_COLS}) { id text ${FRAGMENTS} }`;
  const first = await mondayRequest<{ boards: { items_page: { cursor: string | null; items: LeadItem[] } }[] }>(
    `query { boards(ids: [${BOARD_LEADS}]) { items_page(limit: 500${rules}) { cursor items { ${selection} } } } }`,
  );
  const page = first.boards[0]?.items_page;
  if (!page) throw new Error("בורד הלידים לא הוחזר מ-Monday");
  const items = [...page.items];
  let cursor = page.cursor;
  while (cursor) {
    const next = await mondayRequest<{ next_items_page: { cursor: string | null; items: LeadItem[] } }>(
      `query ($cursor: String!) { next_items_page(cursor: $cursor, limit: 500) { cursor items { ${selection} } } }`,
      { cursor },
    );
    items.push(...next.next_items_page.items);
    cursor = next.next_items_page.cursor;
  }
  return items.map((it) => ({
    itemId: it.id,
    name: it.name,
    status: cv(it.column_values, "color__1"),
    reminderDate: dateOnly(cv(it.column_values, "date__1")),
    owner: cv(it.column_values, "multiple_person__1"),
    ownerIds: personIds(it.column_values, "multiple_person__1"),
    source: cv(it.column_values, "color1__1"),
    product: cv(it.column_values, "color5__1"),
    updatedAt: it.updated_at ?? undefined,
    url: `${MONDAY_HOST}/boards/${BOARD_LEADS}/pulses/${it.id}`,
  }));
}

// ---------------------------------------------------------------------------

/** מצב נוכחי של רשומה ב-Monday — מה שמשווים בין התצוגה לביצוע. */
export interface ItemSnapshot {
  itemId: string;
  kind: BulkItemKind;
  boardId: string;
  name: string;
  status: string;
  date?: string;
  priority?: string;
  assigneeIds: string[];
  /** מזהה פריט הפרויקט (משימת משרד מקושרת / תת-פריט דרך השלב) — לאכיפת scope של מנהל פרויקט */
  projectId?: string;
}

type VerifyItem = {
  id: string;
  name: string;
  board: { id: string } | null;
  column_values: RawCV[];
  parent_item?: { column_values: RawCV[] } | null;
};

const VERIFY_COLS = `["status", "color85__1", "color__1", "date4", "date__1", "priority", "color8__1", "person", "multiple_person__1", "board_relation_mkqzzfgt"]`;
const VERIFY_CHUNK = 100;

/**
 * קריאה טרייה לפי מזהים. רשומה שלא חזרה (נמחקה/אין גישה) פשוט חסרה במפה — הקורא מטפל בזה כ"שונה".
 * רשומה מבורד שלא נתמך בעדכון קבוצתי — מושמטת (לא מנחשים עמודות).
 */
export async function readItemsForVerification(itemIds: string[]): Promise<Map<string, ItemSnapshot>> {
  const out = new Map<string, ItemSnapshot>();
  const ids = [...new Set(itemIds)].filter((id) => /^\d+$/.test(id));
  for (let i = 0; i < ids.length; i += VERIFY_CHUNK) {
    const chunk = ids.slice(i, i + VERIFY_CHUNK);
    const res = await mondayRequest<{ items: VerifyItem[] }>(
      `query ($ids: [ID!]) {
        items(ids: $ids, limit: ${VERIFY_CHUNK}) {
          id name board { id }
          column_values(ids: ${VERIFY_COLS}) { id text ${FRAGMENTS} }
          parent_item { column_values(ids: ["connect_boards4__1"]) { id text ${FRAGMENTS} } }
        }
      }`,
      { ids: chunk },
    );
    for (const it of res.items ?? []) {
      const kind = it.board ? BOARD_TO_KIND[it.board.id] : undefined;
      if (!kind) continue;
      const cols = BULK_COLUMNS[kind];
      let projectId: string | undefined;
      if (kind === "general") projectId = it.column_values.find((c) => c.id === cols.projectRel)?.linked_item_ids?.[0];
      if (kind === "project_stage") projectId = it.parent_item?.column_values.find((c) => c.id === "connect_boards4__1")?.linked_item_ids?.[0];
      out.set(it.id, {
        itemId: it.id,
        kind,
        boardId: cols.boardId,
        name: it.name,
        status: cv(it.column_values, cols.status),
        date: dateOnly(cv(it.column_values, cols.date)),
        priority: cols.priority ? cv(it.column_values, cols.priority) || undefined : undefined,
        assigneeIds: personIds(it.column_values, cols.people).sort(),
        projectId: projectId ? String(projectId) : undefined,
      });
    }
  }
  return out;
}
