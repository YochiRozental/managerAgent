import { mondayClient } from "./client.js";
import { env } from "../../config/env.js";

export interface MondayBoardSummary {
  id: string;
  name: string;
}

export async function listBoards(): Promise<MondayBoardSummary[]> {
  const all: MondayBoardSummary[] = [];
  for (let page = 1; ; page++) {
    const result = await mondayClient.request<{ boards: MondayBoardSummary[] }>(
      `query ($page: Int!) {
        boards(limit: 100, page: $page) {
          id
          name
        }
      }`,
      { page },
    );
    if (result.boards.length === 0) break;
    all.push(...result.boards);
    if (result.boards.length < 100) break;
  }
  return all;
}

/** Finds boards whose name contains the query (case-insensitive), for resolving "the X project" from a Hebrew request. */
export async function findBoardsByName(query: string): Promise<MondayBoardSummary[]> {
  const boards = await listBoards();
  const needle = query.trim().toLowerCase();
  return boards.filter((b) => b.name.toLowerCase().includes(needle));
}

export interface MondayTaskSummary {
  id: string;
  name: string;
  state: string;
}

export async function listTasks(boardId: string = env.MONDAY_BOARD_ID ?? ""): Promise<MondayTaskSummary[]> {
  if (!boardId) throw new Error("No board id — set MONDAY_BOARD_ID or pass one explicitly");

  const first = await mondayClient.request<{
    boards: { items_page: { cursor: string | null; items: MondayTaskSummary[] } }[];
  }>(
    `query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 100) {
          cursor
          items { id name state }
        }
      }
    }`,
    { boardId },
  );

  const page = first.boards[0]?.items_page;
  if (!page) return [];

  const all = [...page.items];
  let cursor = page.cursor;
  while (cursor) {
    const next = await mondayClient.request<{
      next_items_page: { cursor: string | null; items: MondayTaskSummary[] };
    }>(
      `query ($cursor: String!) {
        next_items_page(cursor: $cursor, limit: 100) {
          cursor
          items { id name state }
        }
      }`,
      { cursor },
    );
    all.push(...next.next_items_page.items);
    cursor = next.next_items_page.cursor;
  }

  return all;
}

/**
 * "המשימות שלי" עבור סוכן ה-AI עברה ל-`src/ops/myWorkBrief.ts` (getMyWorkBrief) — נבנית מעל
 * fetchUserOpsTasks + buildDashboardViews, מסוננת לפי המשתמש האמיתי, לא לפי בעל הטוקן.
 * המימוש הישן (על MONDAY_BOARD_ID + ערך הקסם של Monday) הוסר לאחר החקירה של 2026-09-09.
 */

async function firstGroupId(boardId: string): Promise<string> {
  const result = await mondayClient.request<{ boards: { groups: { id: string }[] }[] }>(
    `query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        groups { id }
      }
    }`,
    { boardId },
  );
  const groupId = result.boards[0]?.groups[0]?.id;
  if (!groupId) throw new Error(`Board ${boardId} has no groups`);
  return groupId;
}

export async function createTask(itemName: string, boardId: string = env.MONDAY_BOARD_ID ?? "") {
  if (!boardId) throw new Error("No board id — set MONDAY_BOARD_ID or pass one explicitly");
  const groupId = await firstGroupId(boardId);
  const { create_item } = await mondayClient.operations.createItemOp({
    boardId,
    groupId,
    itemName,
  });
  return create_item;
}

async function statusColumn(boardId: string): Promise<{ id: string; labels: string[] }> {
  const result = await mondayClient.request<{
    boards: { columns: { id: string; type: string; settings_str: string }[] }[];
  }>(
    `query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        columns { id type settings_str }
      }
    }`,
    { boardId },
  );
  const column = result.boards[0]?.columns.find((c) => c.type === "status");
  if (!column) throw new Error(`לא נמצאה עמודת סטטוס בלוח ${boardId}`);
  const settings = JSON.parse(column.settings_str) as { labels: Record<string, string> };
  return { id: column.id, labels: Object.values(settings.labels) };
}

export async function updateTaskStatus(boardId: string, itemId: string, statusLabel: string) {
  const { id: columnId, labels } = await statusColumn(boardId);
  if (!labels.includes(statusLabel)) {
    throw new Error(`"${statusLabel}" אינו סטטוס חוקי בלוח הזה. אפשרויות תקינות: ${labels.join(", ")}`);
  }
  const result = await mondayClient.request<{ change_column_value: { id: string } }>(
    `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
        id
      }
    }`,
    { boardId, itemId, columnId, value: JSON.stringify({ label: statusLabel }) },
  );
  return result.change_column_value;
}

export async function deleteTask(itemId: string) {
  const result = await mondayClient.request<{ delete_item: { id: string } }>(
    `mutation ($itemId: ID!) {
      delete_item(item_id: $itemId) { id }
    }`,
    { itemId },
  );
  return result.delete_item;
}

async function peopleColumnId(boardId: string): Promise<string> {
  const result = await mondayClient.request<{ boards: { columns: { id: string; type: string }[] }[] }>(
    `query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        columns { id type }
      }
    }`,
    { boardId },
  );
  const column = result.boards[0]?.columns.find((c) => c.type === "people");
  if (!column) throw new Error(`לא נמצאה עמודת אחראי/אנשים בלוח ${boardId}`);
  return column.id;
}

export async function assignTask(boardId: string, itemId: string, userId: string) {
  const columnId = await peopleColumnId(boardId);
  const result = await mondayClient.request<{ change_column_value: { id: string } }>(
    `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
        id
      }
    }`,
    {
      boardId,
      itemId,
      columnId,
      value: JSON.stringify({ personsAndTeams: [{ id: Number(userId), kind: "person" }] }),
    },
  );
  return result.change_column_value;
}

async function dateColumnId(boardId: string): Promise<string> {
  const result = await mondayClient.request<{ boards: { columns: { id: string; type: string; title: string }[] }[] }>(
    `query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        columns { id type title }
      }
    }`,
    { boardId },
  );
  const columns = result.boards[0]?.columns.filter((c) => c.type === "date") ?? [];
  if (columns.length === 0) throw new Error(`לא נמצאה עמודת תאריך בלוח ${boardId}`);
  // Prefer a column titled like "due"/"תאריך לביצוע" over creation/closing date columns, if there's more than one.
  const preferred = columns.find((c) => /לביצוע|יעד|due/i.test(c.title));
  return (preferred ?? columns[0])!.id;
}

export async function setTaskDueDate(boardId: string, itemId: string, dateISO: string) {
  const columnId = await dateColumnId(boardId);
  const result = await mondayClient.request<{ change_column_value: { id: string } }>(
    `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
        id
      }
    }`,
    { boardId, itemId, columnId, value: JSON.stringify({ date: dateISO }) },
  );
  return result.change_column_value;
}

export async function addUpdate(itemId: string, body: string) {
  const result = await mondayClient.request<{ create_update: { id: string } }>(
    `mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }`,
    { itemId, body },
  );
  return result.create_update;
}
