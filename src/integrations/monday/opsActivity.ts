/**
 * "הסתיים היום" — Source of Truth = Monday (סיכום סוף יום, audit+spike מאושרים 2026-09-17).
 *
 * שולף boards.activity_logs, מזהה שינויי עמודת סטטוס ל-DONE שקרו היום, ומאמת מול הסטטוס
 * הנוכחי בפועל לפני שמכניסים משהו לרשימה.
 *
 * שני ממצאי spike קריטיים (2026-09-17, נתונים אמיתיים מהחשבון):
 *
 * 1. `activity_logs` הוא שדה **deprecated** ב-schema של Monday ("Replaced by a new
 *    Board.activity_logs with additional entities and capabilities, available from version
 *    2026-10") — עדיין פעיל ועובד היום, אבל צריך להיבדק מחדש כש-API version יתעדכן אחרי 2026-10.
 * 2. `created_at` בלוג **אינו** ISO8601 ואינו unix-ms — הוא ticks של 100 ננושנייה מאז Unix epoch
 *    (אומת אריתמטית מול timestamp אמיתי בזמן ריצת ה-spike). ticksToUnixMs ממיר.
 *
 * value.label בתוך ה-data של הלוג נושא גם `text` (התווית הקריאה) וגם `is_done` (בוליאני) — אין
 * צורך במיפוי index→תווית, שני האיתותים זמינים ישירות.
 */

import { DateTime } from "luxon";
import { mondayRequest } from "./client.js";
import { BOARD_GENERAL_TASKS, BOARD_PROJECT_STAGE_TASKS, type OpsTaskSource } from "./opsRead.js";

const STATUS_COLUMN: Record<OpsTaskSource, string> = {
  general: "status",
  project_stage: "color85__1",
};

/** תוויות "בוצע" לפי מקור — זהות ל-DONE_LABEL ב-opsWrite.ts (לא מיובאות משם כדי לא ליצור תלות מעגלית עם client חדש; אותם ערכים בדיוק). */
export const ACTIVITY_DONE_LABEL: Record<OpsTaskSource, string> = {
  general: "בוצע",
  project_stage: "הושלם",
};

const ACTIVITY_PAGE_LIMIT = 500;
/** הגנה בלבד — 20 עמודים * 500 = 10,000 events ביום אחד הוא הרבה מעבר לכל תרחיש ריאלי במשרד הזה. */
const MAX_PAGES = 20;

/**
 * ticks של 100ns מאז Unix epoch (1970-01-01) → מילישניות unix.
 * אומת אמפירית ב-spike (2026-09-17): ticks="17896378511161132" → ~1,789,637,851,116ms
 * → תואם בפועל את זמן ריצת הבדיקה (2026-09-17). אל תניח ISO/unix-ms — זה לא אחד מהם.
 */
export function ticksToUnixMs(rawTicks: string): number {
  const ticks = Number(rawTicks);
  if (!Number.isFinite(ticks)) {
    throw new Error(`activity_log created_at לא מספרי: "${rawTicks}"`);
  }
  return Math.floor(ticks / 10_000);
}

export interface RawActivityLog {
  id: string;
  event: string;
  entity: string;
  data: string;
  created_at: string;
  user_id: string;
}

interface StatusChangeLogData {
  pulse_id: number;
  pulse_name: string;
  parent_item_id: number | null;
  column_id: string;
  value?: { label?: { text?: string | null; is_done?: boolean } | null } | null;
}

export interface StatusChangeEvent {
  itemId: string;
  taskName: string;
  /** subitem בלבד — מזהה פריט-האב (השלב). null עבור משימות משרד. */
  parentItemId: string | null;
  atMs: number;
  isDone: boolean;
  labelText: string | null;
}

/**
 * הופך שורת activity_log גולמית לאירוע שינוי-סטטוס, או null אם זו לא שורה רלוונטית.
 * פונקציה טהורה — אין כאן שום קריאת רשת, נבדקת ישירות עם fixtures.
 */
export function parseStatusChangeLog(log: RawActivityLog, statusColumnId: string): StatusChangeEvent | null {
  if (log.event !== "update_column_value") return null;
  let parsed: StatusChangeLogData;
  try {
    parsed = JSON.parse(log.data) as StatusChangeLogData;
  } catch {
    return null;
  }
  if (!parsed || parsed.column_id !== statusColumnId) return null;
  const label = parsed.value?.label;
  return {
    itemId: String(parsed.pulse_id),
    taskName: parsed.pulse_name,
    parentItemId: parsed.parent_item_id != null ? String(parsed.parent_item_id) : null,
    atMs: ticksToUnixMs(log.created_at),
    isDone: label?.is_done === true,
    labelText: label?.text ?? null,
  };
}

/** משאיר רק את שינוי הסטטוס האחרון (לפי atMs) לכל item — dedup לכמה שינויים באותו יום. */
export function lastEventPerItem(events: StatusChangeEvent[]): Map<string, StatusChangeEvent> {
  const map = new Map<string, StatusChangeEvent>();
  for (const ev of events) {
    const existing = map.get(ev.itemId);
    if (!existing || ev.atMs > existing.atMs) map.set(ev.itemId, ev);
  }
  return map;
}

/**
 * מסננת ל"נכנס לרשימת מועמדים ל-הסתיים היום": is_done===true, ואם text קיים הוא חייב להיות
 * תואם בדיוק לתווית ה-DONE של אותו מקור (הגנה כפולה — לא סומכים רק על is_done אם text סותר).
 */
export function pickDoneCandidates(events: Iterable<StatusChangeEvent>, doneLabelText: string): StatusChangeEvent[] {
  const out: StatusChangeEvent[] = [];
  for (const ev of events) {
    if (!ev.isDone) continue;
    if (ev.labelText && ev.labelText !== doneLabelText) continue;
    out.push(ev);
  }
  return out;
}

export interface FetchStatusChangeEventsDeps {
  /** קריאת עמוד אחד מ-activity_logs — ברירת מחדל: הקריאה האמיתית ל-Monday. Injectable לבדיקות. */
  requestPage?: (
    boardId: string,
    statusColumnId: string,
    fromUtcIso: string,
    toUtcIso: string,
    limit: number,
    page: number,
  ) => Promise<RawActivityLog[]>;
}

async function requestActivityLogPage(
  boardId: string,
  statusColumnId: string,
  fromUtcIso: string,
  toUtcIso: string,
  limit: number,
  page: number,
): Promise<RawActivityLog[]> {
  const res = await mondayRequest<{ boards: { activity_logs: RawActivityLog[] }[] }>(
    `query ($boardIds: [ID!], $from: ISO8601DateTime, $to: ISO8601DateTime, $columnIds: [String], $limit: Int, $page: Int) {
      boards(ids: $boardIds) {
        activity_logs(from: $from, to: $to, column_ids: $columnIds, limit: $limit, page: $page) {
          id event entity data created_at user_id
        }
      }
    }`,
    { boardIds: [boardId], from: fromUtcIso, to: toUtcIso, columnIds: [statusColumnId], limit, page },
  );
  return res.boards[0]?.activity_logs ?? [];
}

/**
 * כל אירועי שינוי-ערך של עמודת סטטוס אחת, בטווח נתון, עם pagination (page — לא cursor, אומת מול
 * schema ב-spike). ממשיך לעמוד הבא כל עוד העמוד הקודם החזיר בדיוק `limit` שורות (עמוד מלא = יכול
 * להיות עוד) — עוצר ברגע שמקבל פחות מ-limit (עמוד אחרון), עד MAX_PAGES כהגנה.
 */
export async function fetchStatusChangeEvents(
  boardId: string,
  statusColumnId: string,
  fromUtcIso: string,
  toUtcIso: string,
  deps: FetchStatusChangeEventsDeps = {},
): Promise<StatusChangeEvent[]> {
  const doRequestPage = deps.requestPage ?? requestActivityLogPage;
  const out: StatusChangeEvent[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const logs = await doRequestPage(boardId, statusColumnId, fromUtcIso, toUtcIso, ACTIVITY_PAGE_LIMIT, page);
    for (const log of logs) {
      const ev = parseStatusChangeLog(log, statusColumnId);
      if (ev) out.push(ev);
    }
    if (logs.length < ACTIVITY_PAGE_LIMIT) break; // עמוד לא-מלא = עמוד אחרון
  }
  return out;
}

// ---------------------------------------------------------------------------
// אימות batched של הסטטוס הנוכחי + הבאת context (אחראי/פרויקט) — אחרי שכבר יודעים אילו items
// "כרגע נראים כמו שהושלמו היום" מה-activity log.
// ---------------------------------------------------------------------------

export interface VerifiedGeneralItem {
  status: string;
  assignees: string;
  project: string;
}

export interface VerifiedStageItem {
  status: string;
  assignees: string;
  parentItemId: string | null;
}

export interface ProjectContext {
  stageName: string;
  project: string;
}

type RawColumnValue = { id: string; text: string | null; display_value?: string | null; linked_item_ids?: string[] | null };
const REL_FRAGMENT = `... on BoardRelationValue { display_value } ... on MirrorValue { display_value }`;
function cv(values: RawColumnValue[], id: string): string {
  const v = values.find((c) => c.id === id);
  return (v?.display_value || v?.text || "").trim();
}

/** אימות batched לבורד הכללי: סטטוס נוכחי + אחראי + פרויקט מקושר, לכל ה-itemIds בבת אחת. */
export async function verifyGeneralStillDone(itemIds: string[]): Promise<Map<string, VerifiedGeneralItem>> {
  const map = new Map<string, VerifiedGeneralItem>();
  if (itemIds.length === 0) return map;
  const res = await mondayRequest<{ items: { id: string; column_values: RawColumnValue[] }[] }>(
    `query ($ids: [ID!]) {
      items(ids: $ids) {
        id
        column_values(ids: ["status", "person", "board_relation_mkqzzfgt"]) { id text ${REL_FRAGMENT} }
      }
    }`,
    { ids: itemIds },
  );
  for (const item of res.items) {
    map.set(item.id, {
      status: cv(item.column_values, "status"),
      assignees: cv(item.column_values, "person"),
      project: cv(item.column_values, "board_relation_mkqzzfgt"),
    });
  }
  return map;
}

/** אימות batched לבורד תת-הפריטים: סטטוס נוכחי + אחראי + מזהה פריט-אב (לצורך context בהמשך). */
export async function verifyStageStillDone(itemIds: string[]): Promise<Map<string, VerifiedStageItem>> {
  const map = new Map<string, VerifiedStageItem>();
  if (itemIds.length === 0) return map;
  const res = await mondayRequest<{ items: { id: string; column_values: RawColumnValue[]; parent_item: { id: string } | null }[] }>(
    `query ($ids: [ID!]) {
      items(ids: $ids) {
        id
        parent_item { id }
        column_values(ids: ["color85__1", "person"]) { id text }
      }
    }`,
    { ids: itemIds },
  );
  for (const item of res.items) {
    map.set(item.id, {
      status: cv(item.column_values, "color85__1"),
      assignees: cv(item.column_values, "person"),
      parentItemId: item.parent_item?.id ?? null,
    });
  }
  return map;
}

/** context של שלב/פרויקט לפי מזהי פריט-האב (parent_item_id) — אותו pattern כמו fetchProjectStageTasks. */
export async function resolveProjectContext(parentItemIds: string[]): Promise<Map<string, ProjectContext>> {
  const map = new Map<string, ProjectContext>();
  if (parentItemIds.length === 0) return map;
  const res = await mondayRequest<{ items: { id: string; name: string; column_values: RawColumnValue[] }[] }>(
    `query ($ids: [ID!]) {
      items(ids: $ids) {
        id
        name
        column_values(ids: ["connect_boards4__1"]) { id text ${REL_FRAGMENT} }
      }
    }`,
    { ids: parentItemIds },
  );
  for (const item of res.items) {
    map.set(item.id, { stageName: item.name, project: cv(item.column_values, "connect_boards4__1") });
  }
  return map;
}

// ---------------------------------------------------------------------------
// הרכבה: fetchCompletedToday
// ---------------------------------------------------------------------------

export interface CompletedTodayItem {
  source: OpsTaskSource;
  itemId: string;
  taskName: string;
  /** טקסט עמודת האחראי מ-Monday (לא activity_log.user_id — זה יכול להיות אוטומציה, לא אדם). */
  assignees: string;
  project?: string;
  stageName?: string;
}

export interface FetchCompletedTodayDeps {
  fetchGeneralEvents?: (fromUtcIso: string, toUtcIso: string) => Promise<StatusChangeEvent[]>;
  fetchStageEvents?: (fromUtcIso: string, toUtcIso: string) => Promise<StatusChangeEvent[]>;
  verifyGeneralStillDone?: (itemIds: string[]) => Promise<Map<string, VerifiedGeneralItem>>;
  verifyStageStillDone?: (itemIds: string[]) => Promise<Map<string, VerifiedStageItem>>;
  resolveProjectContext?: (parentItemIds: string[]) => Promise<Map<string, ProjectContext>>;
}

/**
 * "מה הסתיים היום" — Source of Truth = Monday. אלגוריתם (מאומת ב-spike, מאושר ב-audit):
 *   1. activity_logs מתחילת היום (Asia/Jerusalem, לא UTC) עד עכשיו, לכל אחד משני הבורדים.
 *   2. dedup: שינוי הסטטוס האחרון של כל item היום קובע (done→reopened באותו יום → לא מופיע).
 *   3. is_done===true (+ text תואם אם קיים) → מועמד.
 *   4. אימות batched: הסטטוס הנוכחי ב-Monday עדיין DONE ברגע יצירת הדוח — מגן מפני מרוץ בין רגע
 *      הלוג לרגע הריצה, ומפני כל פער בתיעוד ה-activity log עצמו.
 *   5. אחראי — מעמודת ה-person של הפריט, לעולם לא מ-activity_log.user_id (יכול להיות אוטומציה/-4).
 */
export async function fetchCompletedToday(nowLocal: DateTime, deps: FetchCompletedTodayDeps = {}): Promise<CompletedTodayItem[]> {
  const doFetchGeneralEvents =
    deps.fetchGeneralEvents ?? ((from, to) => fetchStatusChangeEvents(BOARD_GENERAL_TASKS, STATUS_COLUMN.general, from, to));
  const doFetchStageEvents =
    deps.fetchStageEvents ?? ((from, to) => fetchStatusChangeEvents(BOARD_PROJECT_STAGE_TASKS, STATUS_COLUMN.project_stage, from, to));
  const doVerifyGeneral = deps.verifyGeneralStillDone ?? verifyGeneralStillDone;
  const doVerifyStage = deps.verifyStageStillDone ?? verifyStageStillDone;
  const doResolveProjectContext = deps.resolveProjectContext ?? resolveProjectContext;

  const fromUtcIso = nowLocal.startOf("day").toUTC().toISO()!;
  const toUtcIso = nowLocal.toUTC().toISO()!;

  const [generalEvents, stageEvents] = await Promise.all([doFetchGeneralEvents(fromUtcIso, toUtcIso), doFetchStageEvents(fromUtcIso, toUtcIso)]);

  const out: CompletedTodayItem[] = [];

  const generalCandidates = pickDoneCandidates(lastEventPerItem(generalEvents).values(), ACTIVITY_DONE_LABEL.general);
  if (generalCandidates.length) {
    const verified = await doVerifyGeneral(generalCandidates.map((e) => e.itemId));
    for (const e of generalCandidates) {
      const v = verified.get(e.itemId);
      if (!v || v.status !== ACTIVITY_DONE_LABEL.general) continue; // נפתח מחדש / נמחק / לא אומת → לא נכלל
      out.push({ source: "general", itemId: e.itemId, taskName: e.taskName, assignees: v.assignees, project: v.project || undefined });
    }
  }

  const stageCandidates = pickDoneCandidates(lastEventPerItem(stageEvents).values(), ACTIVITY_DONE_LABEL.project_stage);
  if (stageCandidates.length) {
    const verified = await doVerifyStage(stageCandidates.map((e) => e.itemId));
    const parentIds = [...new Set([...verified.values()].map((v) => v.parentItemId).filter((x): x is string => !!x))];
    const contexts = await doResolveProjectContext(parentIds);
    for (const e of stageCandidates) {
      const v = verified.get(e.itemId);
      if (!v || v.status !== ACTIVITY_DONE_LABEL.project_stage) continue;
      const ctx = v.parentItemId ? contexts.get(v.parentItemId) : undefined;
      out.push({
        source: "project_stage",
        itemId: e.itemId,
        taskName: e.taskName,
        assignees: v.assignees,
        project: ctx?.project || undefined,
        stageName: ctx?.stageName,
      });
    }
  }

  return out;
}
