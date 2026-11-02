/**
 * איש הקשר המקושר לליד (לוח "אנשי קשר 📞" 1550734528). איש הקשר נוצר ומקושר ע"י אוטומציית Monday קיימת בכל יצירת
 * ליד (ר' leads.ts) — כאן רק קריאה של האיש המקושר וכתיבה לעמודותיו הקיימות. **לעולם לא יוצרים איש קשר.**
 */

import { mondayRequest } from "./client.js";

export const CONTACTS_BOARD_ID = "1550734528";
/** עמודת הקישור בלוח הלידים → אנשי קשר */
export const LEAD_CONTACT_RELATION_COLUMN = "board_relation_mkqawpy8";
/** עמודת הקישור בלוח אנשי הקשר → לידים (הכיוון ההפוך) */
const CONTACT_LEADS_RELATION_COLUMN = "board_relation_mkpddf6n";

export const CONTACT_COLUMNS = {
  phone: "phone__1", // "פלאפון"
  email: "email__1",
  whatsapp: "phone_mm0mjb42", // "ווצאפ"
} as const;

export interface ContactState {
  id: string;
  name: string;
  phone: string;
  email: string;
  whatsapp: string;
  /** לידים שמקושרים לאיש הקשר הזה (כולל הליד הנוכחי) — איש קשר משותף לכמה לידים לא נדרס */
  leadIds: string[];
}

/** מזהי אנשי הקשר המקושרים לליד (ריק = האוטומציה עוד לא יצרה/קישרה, או שלא חלה על הליד). */
export async function getLeadLinkedContactIds(leadItemId: string): Promise<string[]> {
  const res = await mondayRequest<{ items: { column_values: { id: string; linked_item_ids?: string[] | null }[] }[] }>(
    `query ($id: [ID!]) { items(ids: $id) { column_values(ids: ["${LEAD_CONTACT_RELATION_COLUMN}"]) { id ... on BoardRelationValue { linked_item_ids } } } }`,
    { id: [leadItemId] },
  );
  return res.items[0]?.column_values.find((c) => c.id === LEAD_CONTACT_RELATION_COLUMN)?.linked_item_ids ?? [];
}

export async function getContactState(contactId: string): Promise<ContactState | null> {
  const res = await mondayRequest<{
    items: { id: string; name: string; column_values: { id: string; text: string | null; linked_item_ids?: string[] | null }[] }[];
  }>(
    `query ($id: [ID!]) { items(ids: $id) { id name column_values(ids: ["${CONTACT_COLUMNS.phone}", "${CONTACT_COLUMNS.email}", "${CONTACT_COLUMNS.whatsapp}", "${CONTACT_LEADS_RELATION_COLUMN}"]) { id text ... on BoardRelationValue { linked_item_ids } } } }`,
    { id: [contactId] },
  );
  const it = res.items[0];
  if (!it) return null;
  const col = (id: string) => it.column_values.find((c) => c.id === id);
  return {
    id: it.id,
    name: it.name,
    phone: (col(CONTACT_COLUMNS.phone)?.text ?? "").trim(),
    email: (col(CONTACT_COLUMNS.email)?.text ?? "").trim(),
    whatsapp: (col(CONTACT_COLUMNS.whatsapp)?.text ?? "").trim(),
    leadIds: col(CONTACT_LEADS_RELATION_COLUMN)?.linked_item_ids ?? [],
  };
}

/** כתיבה אחת (change_multiple_column_values) לעמודות הקיימות של איש הקשר. */
export async function updateContactColumns(contactId: string, columnValues: Record<string, unknown>): Promise<void> {
  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
    }`,
    { boardId: CONTACTS_BOARD_ID, itemId: contactId, columnValues: JSON.stringify(columnValues) },
  );
}
