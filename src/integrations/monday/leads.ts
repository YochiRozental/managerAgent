import { mondayClient } from "./client.js";

const LEADS_BOARD_ID = "1550734525";
const NEW_LEAD_GROUP_ID = "topics";

export const LEAD_SOURCE_OPTIONS = [
  "פה לאוזן",
  "הפניה",
  "קמפיין",
  "לא ידוע",
  "לקוח מפנה",
  "לא הוגדר",
  "כנס",
  "פייסבוק",
  "אינסטגרם",
  "וובינר",
  "גוגל",
  "לקוח חוזר",
  "מכרזים",
  "אתר",
] as const;

export const LEAD_PRODUCT_OPTIONS = [
  "אדריכלות בניה חדשה",
  "מעונות יום",
  "שינוי תבע",
  "עיצוב פנים - ליווי מלא",
  "אדריכלות ליזמויות",
  "עיצוב פנים - תכניות בלבד",
  "הום סטיילינג",
  "בית כנסת בניה חדשה",
  "אדריכלות - תוספות",
  "השקעות",
  "ליסינג",
  "תוספת לבית כנסת",
] as const;

export interface CreateLeadInput {
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  source?: (typeof LEAD_SOURCE_OPTIONS)[number];
  product?: (typeof LEAD_PRODUCT_OPTIONS)[number];
  referredBy?: string;
}

export async function createLead(input: CreateLeadInput) {
  const columnValues: Record<string, unknown> = {
    text_mknr5f59: input.firstName,
  };
  if (input.lastName) columnValues.text_mknrtghs = input.lastName;
  if (input.phone) columnValues.phone__1 = { phone: input.phone, countryShortName: "IL" };
  if (input.email) columnValues.email__1 = { email: input.email, text: input.email };
  if (input.source) columnValues.color1__1 = { label: input.source };
  if (input.product) columnValues.color5__1 = { label: input.product };
  if (input.referredBy) columnValues.text2__1 = input.referredBy;

  const itemName = [input.firstName, input.lastName].filter(Boolean).join(" ");

  const result = await mondayClient.request<{ create_item: { id: string; name: string } }>(
    `mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
        id
        name
      }
    }`,
    {
      boardId: LEADS_BOARD_ID,
      groupId: NEW_LEAD_GROUP_ID,
      itemName,
      columnValues: JSON.stringify(columnValues),
    },
  );
  return result.create_item;
}
