/**
 * קריאת בורדי ה-CRM לצורך מנוע הבקרה: לידים, עסקאות (פייפליין המכירות) וגבייה.
 * IDs של עמודות מ-get_board_info (2026-09-06). קריאה בלבד.
 */

import { mondayRequest } from "./client.js";

const HOST = "https://gottlieb-league.monday.com";

export const BOARD_LEADS = "1550734525";
export const BOARD_DEALS = "1550734529";
export const BOARD_COLLECTION = "1550734546";
export const BOARD_PAYMENTS = "1550734569"; // תת-פריטים של גבייה

const REL = `... on BoardRelationValue { display_value linked_item_ids } ... on MirrorValue { display_value } ... on CreationLogValue { created_at }`;

type RawCV = {
  id: string;
  text: string | null;
  display_value?: string | null;
  created_at?: string | null;
  linked_item_ids?: string[] | null;
};
type RawItem = { id: string; name: string; column_values: RawCV[] };

function cv(vals: RawCV[], id: string): string {
  const v = vals.find((c) => c.id === id);
  return (v?.display_value || v?.created_at || v?.text || "").trim();
}
function dateOnly(text: string): string | undefined {
  const m = text.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : undefined;
}

async function pageAll(query: (cursor: string | null) => string): Promise<RawItem[]> {
  const first = await mondayRequest<{
    boards: { items_page: { cursor: string | null; items: RawItem[] } }[];
  }>(query(null));
  const page = first.boards[0]?.items_page;
  const items: RawItem[] = page ? [...page.items] : [];
  let cursor = page?.cursor ?? null;
  while (cursor) {
    const next = await mondayRequest<{ next_items_page: { cursor: string | null; items: RawItem[] } }>(
      `query { next_items_page(cursor: "${cursor}", limit: 200) { cursor items { id name column_values(ids: ${CV_IDS}) { id text ${REL} } } } }`,
    );
    items.push(...next.next_items_page.items);
    cursor = next.next_items_page.cursor;
  }
  return items;
}

// עמודות שנמשכות לכל שלושת הבורדים הראשיים (איחוד — לא כל אחת קיימת בכל בורד, וזה בסדר)
const CV_IDS = `["multiple_person__1", "person", "color__1", "status", "date__1", "color1__1", "color5__1", "color04__1", "date8__1", "pulse_log__1", "creation_log__1", "link_to___________1", "lookup64__1", "formula_mkkr1egj", "board_relation_mkqpq309"]`;

function linkedIds(vals: RawCV[], id: string): string[] {
  return vals.find((c) => c.id === id)?.linked_item_ids ?? [];
}

// ---------------------------------------------------------------------------

export interface Lead {
  itemId: string;
  name: string;
  owner: string;
  status: string;
  source: string;
  product: string;
  reminderDate?: string;
  createdDate?: string;
  /** האם הליד מקושר לעסקה בבורד העסקאות (board_relation_mkqpq309) */
  hasDeal: boolean;
  url: string;
}

const LEAD_CLOSED = new Set(["לא רלוונטי", "נסגר בהצלחה"]);

export async function fetchOpenLeads(): Promise<Lead[]> {
  const items = await pageAll(
    () =>
      `query { boards(ids: [${BOARD_LEADS}]) { items_page(limit: 200) { cursor items { id name column_values(ids: ${CV_IDS}) { id text ${REL} } } } } }`,
  );
  const out: Lead[] = [];
  for (const it of items) {
    const status = cv(it.column_values, "color__1");
    if (LEAD_CLOSED.has(status)) continue;
    out.push({
      itemId: it.id,
      name: it.name,
      owner: cv(it.column_values, "multiple_person__1"),
      status,
      source: cv(it.column_values, "color1__1"),
      product: cv(it.column_values, "color5__1"),
      reminderDate: dateOnly(cv(it.column_values, "date__1")),
      createdDate: dateOnly(cv(it.column_values, "pulse_log__1")),
      hasDeal: linkedIds(it.column_values, "board_relation_mkqpq309").length > 0,
      url: `${HOST}/boards/${BOARD_LEADS}/pulses/${it.id}`,
    });
  }
  return out;
}

export interface Deal {
  itemId: string;
  name: string;
  owner: string;
  stage: string;
  closeChance: string;
  reminderDate?: string;
  expectedClose?: string;
  createdDate?: string;
  url: string;
}

const DEAL_CLOSED = new Set([
  "נחתם",
  "לא נסגר-ללא חיבור ללב",
  "לא ניתן לביצוע - פרוייקט סגור",
  "מוקפא", // הוקפא במכוון — לא רודפים
]);

export async function fetchOpenDeals(): Promise<Deal[]> {
  const items = await pageAll(
    () =>
      `query { boards(ids: [${BOARD_DEALS}]) { items_page(limit: 200) { cursor items { id name column_values(ids: ${CV_IDS}) { id text ${REL} } } } } }`,
  );
  const out: Deal[] = [];
  for (const it of items) {
    const stage = cv(it.column_values, "color__1");
    if (DEAL_CLOSED.has(stage)) continue;
    out.push({
      itemId: it.id,
      name: it.name,
      owner: cv(it.column_values, "multiple_person__1"),
      stage,
      closeChance: cv(it.column_values, "color04__1"),
      reminderDate: dateOnly(cv(it.column_values, "date__1")),
      expectedClose: dateOnly(cv(it.column_values, "date8__1")),
      createdDate: dateOnly(cv(it.column_values, "pulse_log__1")),
      url: `${HOST}/boards/${BOARD_DEALS}/pulses/${it.id}`,
    });
  }
  return out;
}

/** לידים שנוצרו מאז תאריך נתון (ISO) — לדוח השבועי. */
export function leadsCreatedSince(leads: Lead[], sinceIso: string): Lead[] {
  const since = sinceIso.slice(0, 10);
  return leads.filter((l) => l.createdDate && l.createdDate >= since);
}

export interface Signing {
  name: string;
  date: string;
  amount: string;
  owner: string;
}

/** עסקאות שנחתמו מאז תאריך נתון (לפי "תאריך סגירה בפועל" date4__1). */
export async function fetchSigningsSince(sinceIso: string): Promise<Signing[]> {
  const since = sinceIso.slice(0, 10);
  const items = await pageAllSel(
    BOARD_DEALS,
    `["color__1", "date4__1", "numeric__1", "multiple_person__1"]`,
  );
  const out: Signing[] = [];
  for (const it of items) {
    if (cv(it.column_values, "color__1") !== "נחתם") continue;
    const d = dateOnly(cv(it.column_values, "date4__1"));
    if (!d || d < since) continue;
    out.push({
      name: it.name,
      date: d,
      amount: cv(it.column_values, "numeric__1"),
      owner: cv(it.column_values, "multiple_person__1"),
    });
  }
  return out;
}

async function pageAllSel(boardId: string, cvIds: string): Promise<RawItem[]> {
  const q = (c: string | null) =>
    c
      ? `query { next_items_page(cursor: "${c}", limit: 200) { cursor items { id name column_values(ids: ${cvIds}) { id text ${REL} } } } }`
      : `query { boards(ids: [${boardId}]) { items_page(limit: 200) { cursor items { id name column_values(ids: ${cvIds}) { id text ${REL} } } } } }`;
  const first = await mondayRequest<{ boards: { items_page: { cursor: string | null; items: RawItem[] } }[] }>(q(null));
  const page = first.boards[0]?.items_page;
  const items: RawItem[] = page ? [...page.items] : [];
  let cursor = page?.cursor ?? null;
  while (cursor) {
    const next = await mondayRequest<{ next_items_page: { cursor: string | null; items: RawItem[] } }>(q(cursor));
    items.push(...next.next_items_page.items);
    cursor = next.next_items_page.cursor;
  }
  return items;
}

export interface CrmMatch {
  board: "לידים" | "עסקאות";
  itemId: string;
  name: string;
  status: string;
  owner: string;
  reminderDate?: string;
  createdDate?: string;
  extra?: string;
  url: string;
}

/** מחפש ליד או עסקה לפי שם — בכל הסטטוסים (כולל סגורים/מוקפאים), לחיפוש ישיר מהצ'אט. */
export async function searchLeadsAndDeals(query: string): Promise<CrmMatch[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const rule = `{ column_id: "name", compare_value: "${q.replace(/"/g, "")}", operator: contains_text }`;
  const sel = `id name column_values(ids: ${CV_IDS}) { id text ${REL} }`;

  const [leadRes, dealRes] = await Promise.all([
    mondayRequest<{ boards: { items_page: { items: RawItem[] } }[] }>(
      `query { boards(ids: [${BOARD_LEADS}]) { items_page(limit: 25, query_params: { rules: [${rule}] }) { items { ${sel} } } } }`,
    ).catch(() => ({ boards: [{ items_page: { items: [] } }] })),
    mondayRequest<{ boards: { items_page: { items: RawItem[] } }[] }>(
      `query { boards(ids: [${BOARD_DEALS}]) { items_page(limit: 25, query_params: { rules: [${rule}] }) { items { ${sel} } } } }`,
    ).catch(() => ({ boards: [{ items_page: { items: [] } }] })),
  ]);

  const out: CrmMatch[] = [];
  for (const it of leadRes.boards[0]?.items_page.items ?? []) {
    out.push({
      board: "לידים",
      itemId: it.id,
      name: it.name,
      status: cv(it.column_values, "color__1"),
      owner: cv(it.column_values, "multiple_person__1"),
      reminderDate: dateOnly(cv(it.column_values, "date__1")),
      createdDate: dateOnly(cv(it.column_values, "pulse_log__1")),
      extra: cv(it.column_values, "color5__1") || undefined,
      url: `${HOST}/boards/${BOARD_LEADS}/pulses/${it.id}`,
    });
  }
  for (const it of dealRes.boards[0]?.items_page.items ?? []) {
    out.push({
      board: "עסקאות",
      itemId: it.id,
      name: it.name,
      status: cv(it.column_values, "color__1"),
      owner: cv(it.column_values, "multiple_person__1"),
      reminderDate: dateOnly(cv(it.column_values, "date__1")),
      createdDate: dateOnly(cv(it.column_values, "pulse_log__1")),
      extra: cv(it.column_values, "color04__1") || undefined,
      url: `${HOST}/boards/${BOARD_DEALS}/pulses/${it.id}`,
    });
  }
  return out;
}

export interface Payment {
  itemId: string;
  name: string;
  status: string;
  amount: string;
  dueDate?: string;
  paidDate?: string;
}
export interface CollectionItem {
  itemId: string;
  name: string;
  owner: string;
  status: string;
  project: string;
  projectOwner: string;
  remaining: string;
  url: string;
  payments: Payment[];
}

const COLLECTION_CLOSED = new Set(["נשלחה חשבונית", "גבייה שבוטלה"]);
const PAYMENT_DONE = new Set(["שולם נשלחה חשבונית", "שולם-ממתין למס/קבלה", "בוטל"]);

export async function fetchOpenCollections(): Promise<CollectionItem[]> {
  const sel = `id name
    column_values(ids: ["person", "status", "link_to___________1", "lookup64__1", "formula_mkkr1egj"]) { id text ${REL} }
    subitems { id name column_values(ids: ["status", "numbers__1", "date0", "date__1"]) { id text } }`;

  const first = await mondayRequest<{
    boards: {
      items_page: {
        cursor: string | null;
        items: (RawItem & { subitems: RawItem[] })[];
      };
    }[];
  }>(`query { boards(ids: [${BOARD_COLLECTION}]) { items_page(limit: 200) { cursor items { ${sel} } } } }`);

  const page = first.boards[0]?.items_page;
  const items = page ? [...page.items] : [];
  let cursor = page?.cursor ?? null;
  while (cursor) {
    const next = await mondayRequest<{
      next_items_page: { cursor: string | null; items: (RawItem & { subitems: RawItem[] })[] };
    }>(`query { next_items_page(cursor: "${cursor}", limit: 200) { cursor items { ${sel} } } }`);
    items.push(...next.next_items_page.items);
    cursor = next.next_items_page.cursor;
  }

  const out: CollectionItem[] = [];
  for (const it of items) {
    const status = cv(it.column_values, "status");
    if (COLLECTION_CLOSED.has(status)) continue;
    const payments: Payment[] = (it.subitems ?? []).map((s) => ({
      itemId: s.id,
      name: s.name,
      status: cv(s.column_values, "status"),
      amount: cv(s.column_values, "numbers__1"),
      dueDate: dateOnly(cv(s.column_values, "date0")),
      paidDate: dateOnly(cv(s.column_values, "date__1")),
    }));
    out.push({
      itemId: it.id,
      name: it.name,
      owner: cv(it.column_values, "person"),
      status,
      project: cv(it.column_values, "link_to___________1"),
      projectOwner: cv(it.column_values, "lookup64__1"),
      remaining: cv(it.column_values, "formula_mkkr1egj"),
      url: `${HOST}/boards/${BOARD_COLLECTION}/pulses/${it.id}`,
      payments: payments.filter((p) => !PAYMENT_DONE.has(p.status)),
    });
  }
  return out;
}
