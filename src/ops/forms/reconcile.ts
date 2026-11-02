/**
 * התאמת מצב אחרי ניתוק: האם ניסיון קודם של אותו טופס כבר יצר את הפריט ב-Monday (ה-Action נקטע לפני שהחזיר,
 * או שהשרת קרס לפני ה-checkpoint). אין ל-Monday מפתח idempotency ליצירה, לכן מחפשים פריט שנוצר מאז תחילת
 * הניסיון הראשון בלוח היעד, באותו שם. מימוש קריאה-בלבד. כשל בחיפוש → זורק (הקורא לא יוצר מחדש "בעיוור").
 */

import { LEADS_BOARD_ID } from "../../integrations/monday/leads.js";
import { BOARD_GENERAL_TASKS, BOARD_PROJECT_STAGES, BOARD_PROJECT_STAGE_TASKS } from "../../integrations/monday/opsRead.js";
import { mondayRequest } from "../../integrations/monday/client.js";
import type { FormKind, FormValues } from "./types.js";

export interface ExistingItem {
  itemId: string;
  name: string;
}

export type FindCreatedFn = (kind: FormKind, values: FormValues, sinceMs: number) => Promise<ExistingItem[]>;

const CLOCK_SKEW_MS = 60_000;

/** הלוח שבו הפריט נוצר + השם שנכתב לו, לפי סוג הטופס. null = אין פריט Monday (התחייבות). */
export function targetFor(kind: FormKind, v: FormValues): { boardId: string; name: string } | null {
  switch (kind) {
    case "lead":
      return { boardId: LEADS_BOARD_ID, name: v.projectName ?? "" };
    case "task":
      return { boardId: v.scope === "stage" ? BOARD_PROJECT_STAGE_TASKS : BOARD_GENERAL_TASKS, name: v.taskName ?? "" };
    case "stage":
      return { boardId: BOARD_PROJECT_STAGES, name: v.name ?? "" };
    case "commitment":
      return null;
  }
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** 30 הפריטים האחרונים שנוצרו בלוח; מחזיר את אלה בשם הנתון שנוצרו מאז sinceMs. */
export const findCreatedInMonday: FindCreatedFn = async (kind, values, sinceMs) => {
  const target = targetFor(kind, values);
  if (!target || !target.name.trim()) return [];
  const res = await mondayRequest<{ boards: { items_page: { items: { id: string; name: string; created_at: string }[] } }[] }>(
    `query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 30, query_params: { order_by: [{ column_id: "__creation_log__", direction: desc }] }) {
          items { id name created_at }
        }
      }
    }`,
    { boardId: target.boardId },
  );
  const items = res.boards[0]?.items_page.items;
  if (!items) throw new Error("לא התקבלה רשימת פריטים מהלוח");
  return items
    .filter((it) => norm(it.name) === norm(target.name) && Date.parse(it.created_at) >= sinceMs - CLOCK_SKEW_MS)
    .map((it) => ({ itemId: it.id, name: it.name }));
};
