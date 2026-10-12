/**
 * מודול נוכחות — ממשק הכתיבה ל-Monday (שלב ד, הכנה בלבד).
 *
 * **createRealMondayAttendanceClient (למטה) לא נקרא משום מקום בקוד הפעיל** — לא מחובר ל-scheduler,
 * לא מופעל אוטומטית, ולא נבדק מול Monday אמיתי בשום סקריפט בדיקה (ר' scripts/test-attendance-
 * monday-sync.ts — מריץ רק מול FakeMondayAttendanceClient בזיכרון). קיים כתשתית מוכנה לשלב שיאושר
 * בנפרד להפעלה בפועל. אסור לקרוא לו/להפעיל אותו לפני אישור מפורש (ר' גבולות האישור בדוח).
 */

import { DateTime } from "luxon";
import { mondayRequest } from "./client.js";
import { ATTENDANCE_GROUP_TITLE, ATTENDANCE_COLUMN_TITLES, type AttendanceColumnKey } from "./attendanceBoards.js";

export interface MondayAttendanceColumnValues {
  workDate: string; // YYYY-MM-DD
  firstInLocal: { hour: number; minute: number } | null;
  lastOutLocal: { hour: number; minute: number } | null;
  breakMinutes: number;
  /** שעות נטו, עשרוני (למשל 7.25) */
  netHours: number;
  statusLabel: string;
  segmentCount: number;
  sourceLabel: string;
  syncId: string;
}

export interface MondayAttendanceClient {
  findItemBySyncId(boardId: string, syncId: string): Promise<{ itemId: string } | null>;
  createItem(boardId: string, itemName: string, values: MondayAttendanceColumnValues): Promise<{ itemId: string }>;
  updateItem(boardId: string, itemId: string, values: MondayAttendanceColumnValues): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// מימוש אמיתי — כתוב ומוכן, **לא קרוי משום מקום בקוד הפעיל** (ר' docstring בראש הקובץ).
// ─────────────────────────────────────────────────────────────────────────────

interface ResolvedBoardSchema {
  groupId: string;
  columnIds: Record<AttendanceColumnKey, string>;
}

const schemaCache = new Map<string, { at: number; schema: ResolvedBoardSchema }>();
const SCHEMA_TTL_MS = 10 * 60_000;

/**
 * מאתרת את הקבוצה והעמודות *לפי כותרת* — לעולם לא יוצרת אותן (בניגוד ל-findOrCreateStageGroupId
 * ב-opsWrite.ts, שכן יוצרת group חדש לשלבים). אם הקבוצה/עמודה חסרה — שגיאה ברורה שמסבירה מה
 * חסר ולמה (עדיין לא נוצר ב-Monday), לא ניחוש ולא יצירה אוטומטית.
 */
async function resolveBoardSchema(boardId: string): Promise<ResolvedBoardSchema> {
  const cached = schemaCache.get(boardId);
  if (cached && Date.now() - cached.at < SCHEMA_TTL_MS) return cached.schema;

  const res = await mondayRequest<{
    boards: { groups: { id: string; title: string }[]; columns: { id: string; title: string }[] }[];
  }>(`query ($boardId: ID!) { boards(ids: [$boardId]) { groups { id title } columns { id title } } }`, { boardId });
  const board = res.boards[0];
  if (!board) throw new Error(`לוח Monday ${boardId} לא נמצא.`);

  const group = board.groups.find((g) => g.title === ATTENDANCE_GROUP_TITLE);
  if (!group) {
    throw new Error(
      `הקבוצה "${ATTENDANCE_GROUP_TITLE}" לא נמצאה בלוח ${boardId} — עדיין לא נוצרה ב-Monday (ר' תוכנית השינוי). לא ניצור אותה אוטומטית.`,
    );
  }

  const columnIds = {} as Record<AttendanceColumnKey, string>;
  for (const [key, title] of Object.entries(ATTENDANCE_COLUMN_TITLES) as [AttendanceColumnKey, string][]) {
    const col = board.columns.find((c) => c.title === title);
    if (!col) {
      throw new Error(`העמודה "${title}" לא נמצאה בלוח ${boardId} — עדיין לא נוצרה ב-Monday (ר' תוכנית השינוי). לא ניצור אותה אוטומטית.`);
    }
    columnIds[key] = col.id;
  }

  const schema: ResolvedBoardSchema = { groupId: group.id, columnIds };
  schemaCache.set(boardId, { at: Date.now(), schema });
  return schema;
}

function buildColumnValuesJson(columnIds: Record<AttendanceColumnKey, string>, values: MondayAttendanceColumnValues): Record<string, unknown> {
  const cv: Record<string, unknown> = {
    [columnIds.workDate]: { date: values.workDate },
    [columnIds.breakMinutes]: String(values.breakMinutes),
    [columnIds.netHours]: String(values.netHours),
    [columnIds.status]: { label: values.statusLabel },
    [columnIds.segmentCount]: String(values.segmentCount),
    // תוקן (audit שלב ו, 2026-10-12, live smoke): עמודת dropdown (בניגוד ל-status) מצפה למפתח
    // "labels" (מערך), לא "label" יחיד — Monday דחה את היצירה עם "parameters are an array of ids
    // or labels". לא נתפס ע"י הבדיקות הממומחזות מהסיבה הרגילה (FakeMondayAttendanceClient לא
    // שולח GraphQL אמיתי).
    [columnIds.source]: { labels: [values.sourceLabel] },
    [columnIds.syncId]: values.syncId,
  };
  if (values.firstInLocal) cv[columnIds.firstIn] = { hour: values.firstInLocal.hour, minute: values.firstInLocal.minute };
  if (values.lastOutLocal) cv[columnIds.lastOut] = { hour: values.lastOutLocal.hour, minute: values.lastOutLocal.minute };
  return cv;
}

export function createRealMondayAttendanceClient(): MondayAttendanceClient {
  return {
    async findItemBySyncId(boardId, syncId) {
      const schema = await resolveBoardSchema(boardId);
      // תוקן (audit שלב ו, 2026-10-12, live smoke): Monday's items_page query_params.rules.column_id
      // הוא ID! בפועל, לא String! — הצהרת הטיפוס הקודמת גרמה לשגיאת GraphQL ("used in position
      // expecting type ID!") שלא נתפסה ע"י הבדיקות הממומחזות (FakeMondayAttendanceClient לא
      // שולח GraphQL אמיתי בכלל) — נתגלתה רק כש-הופעל פעם ראשונה מול Monday חי.
      const res = await mondayRequest<{ boards: { items_page: { items: { id: string }[] } }[] }>(
        `query ($boardId: ID!, $columnId: ID!, $value: String!) {
          boards(ids: [$boardId]) {
            items_page(query_params: { rules: [{ column_id: $columnId, compare_value: [$value], operator: contains_text }] }) {
              items { id }
            }
          }
        }`,
        { boardId, columnId: schema.columnIds.syncId, value: syncId },
      );
      const item = res.boards[0]?.items_page.items[0];
      return item ? { itemId: item.id } : null;
    },

    async createItem(boardId, itemName, values) {
      const schema = await resolveBoardSchema(boardId);
      const columnValues = buildColumnValuesJson(schema.columnIds, values);
      const res = await mondayRequest<{ create_item: { id: string } }>(
        `mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
          create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) { id }
        }`,
        { boardId, groupId: schema.groupId, itemName, columnValues: JSON.stringify(columnValues) },
      );
      return { itemId: res.create_item.id };
    },

    async updateItem(boardId, itemId, values) {
      const schema = await resolveBoardSchema(boardId);
      const columnValues = buildColumnValuesJson(schema.columnIds, values);
      await mondayRequest(
        `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
          change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
        }`,
        { boardId, itemId, columnValues: JSON.stringify(columnValues) },
      );
    },
  };
}

/** שם הפריט — תאריך בפורמט מקומי, עקבי עם שאר העיצוב בעברית באפליקציה. */
export function buildAttendanceItemName(workDate: string): string {
  return DateTime.fromISO(workDate).toFormat("dd/MM/yyyy");
}
