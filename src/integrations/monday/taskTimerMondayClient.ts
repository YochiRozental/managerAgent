/**
 * כתיבת "זמן עבודה מצטבר" ל-Monday (עמודת מספר, שעות). כותב **רק** את העמודה הזו — אף עמודה אחרת, אף
 * סטטוס, ולא את עמודת ה-Time Tracking הקיימת ("זמן בפועל", שהיא read-only ב-API ולא נוגעים בה).
 * הערך הוא הסכום הכולל (לא תוספת); קריאה חוזרת עם אותו ערך אידמפוטנטית.
 */

import { env } from "../../config/env.js";
import { mondayRequest } from "./client.js";
import { BOARD_GENERAL_TASKS, BOARD_PROJECT_STAGE_TASKS } from "./opsRead.js";

export interface TaskTimerMondayClient {
  /** כותב את הסכום הכולל בשעות (כבר מעוגל ל-2 ספרות) לפריט. זורק על כשל. */
  writeCumulativeHours(itemSource: string, itemId: string, hours: number): Promise<void>;
}

/** שגיאה שאין טעם לנסות שוב עליה (פריט נמחק, עמודה שגויה) — הפריט יסומן dead עד שינוי חדש. */
export class PermanentSyncError extends Error {}

const PERMANENT = /item.*not found|ItemNotFound|InvalidBoardId|InvalidColumnId|column.*(not found|does not exist)|Cannot find|inactive/i;

export function classifySyncError(err: unknown): { permanent: boolean; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { permanent: err instanceof PermanentSyncError || PERMANENT.test(message), message };
}

function target(itemSource: string): { boardId: string; columnId: string } {
  return itemSource === "project_stage"
    ? { boardId: BOARD_PROJECT_STAGE_TASKS, columnId: env.TASK_TIMER_MONDAY_COLUMN_STAGE }
    : { boardId: BOARD_GENERAL_TASKS, columnId: env.TASK_TIMER_MONDAY_COLUMN_GENERAL };
}

const validated = new Set<string>();

/** בדיקות בלבד — מאפס את מטמון אימות העמודות. */
export function _resetColumnValidationForTests(): void {
  validated.clear();
}

/** מוודא פעם אחת לתהליך שהעמודה קיימת ומסוג numbers — אחרת לא כותבים (שגיאת קונפיגורציה, לא ניסיון חוזר). */
async function assertNumbersColumn(boardId: string, columnId: string): Promise<void> {
  const key = `${boardId}:${columnId}`;
  if (validated.has(key)) return;
  const res = await mondayRequest<{ boards: { columns: { id: string; type: string }[] }[] }>(
    `query ($boardId: ID!, $columnId: [String!]) { boards(ids: [$boardId]) { columns(ids: $columnId) { id type } } }`,
    { boardId, columnId: [columnId] },
  );
  const col = res.boards[0]?.columns[0];
  if (!col) throw new PermanentSyncError(`עמודה ${columnId} לא נמצאה בלוח ${boardId}`);
  if (col.type !== "numbers") throw new PermanentSyncError(`עמודה ${columnId} בלוח ${boardId} היא ${col.type}, לא numbers`);
  validated.add(key);
}

export function createRealTaskTimerMondayClient(): TaskTimerMondayClient {
  return {
    async writeCumulativeHours(itemSource, itemId, hours) {
      if (!/^\d+$/.test(itemId)) throw new PermanentSyncError(`מזהה פריט לא תקין: ${itemId}`);
      const { boardId, columnId } = target(itemSource);
      await assertNumbersColumn(boardId, columnId);
      await mondayRequest(
        `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
           change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
         }`,
        { boardId, itemId, columnId, value: String(hours) },
      );
    },
  };
}
