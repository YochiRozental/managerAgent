import { mondayClient, mondayRequest } from "./client.js";

export const LEADS_BOARD_ID = "1550734525";
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
  /** שם פרטי של *איש הקשר* (אדם) — לא שם עמותה/קהילה/מוסד. אופציונלי כש-institutionName ניתן במקום. */
  firstName?: string;
  lastName?: string;
  /** שם העמותה/הקהילה/המוסד (text_mm6q8vxy) — נפרד משם איש הקשר. למשל "ויז'שניץ מונסי עמנואל". */
  institutionName?: string;
  phone?: string;
  email?: string;
  source?: (typeof LEAD_SOURCE_OPTIONS)[number];
  product?: (typeof LEAD_PRODUCT_OPTIONS)[number];
  referredBy?: string;
  /** מזהה משתמש Monday שיוגדר כאחראי/ת (multiple_person__1). בלי זה — ליד נוצר בלי אחראי. */
  assigneeId?: string;
}

/**
 * יוצר ליד מיידית, גם עם מידע חלקי (למשל רק שם עמותה, בלי איש קשר עדיין) — החלטת מוצר
 * (2026-10-08): לא לחכות לפרטי קשר מלאים. יש להעביר firstName ו/או institutionName (נבדק
 * ב-createLeadAction, לא כאן — leads.ts הוא שכבת כתיבה גרידא, בלי ולידציה עסקית).
 */
export async function createLead(input: CreateLeadInput) {
  const columnValues: Record<string, unknown> = {};
  if (input.firstName) columnValues.text_mknr5f59 = input.firstName;
  if (input.lastName) columnValues.text_mknrtghs = input.lastName;
  if (input.institutionName) columnValues.text_mm6q8vxy = input.institutionName;
  if (input.phone) columnValues.phone__1 = { phone: input.phone, countryShortName: "IL" };
  if (input.email) columnValues.email__1 = { email: input.email, text: input.email };
  if (input.source) columnValues.color1__1 = { label: input.source };
  if (input.product) columnValues.color5__1 = { label: input.product };
  if (input.referredBy) columnValues.text2__1 = input.referredBy;
  if (input.assigneeId) {
    columnValues.multiple_person__1 = { personsAndTeams: [{ id: Number(input.assigneeId), kind: "person" }] };
  }

  // שם הפריט: עדיף שם איש קשר (ספציפי יותר) — אם אין, שם העמותה/קהילה — אם אין גם את זה, נופל
  // ל"ליד חדש" (לא אמור לקרות בפועל: createLeadAction מחייב לפחות אחד מהשניים לפני הקריאה לכאן).
  const itemName = [input.firstName, input.lastName].filter(Boolean).join(" ") || input.institutionName || "ליד חדש";

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

// ---------------------------------------------------------------------------
// עדכון/איתור ליד קיים (2026-10-08) — סוגר את הפער שגרם לתקלת "ויז'שניץ מונסי עמנואל": פרטי קשר
// שמגיעים בהודעת המשך על ליד שכבר נוצר צריכים לעדכן את עמודות הליד הקיים, לא להיכתב כהערת טקסט
// ולא ליצור ליד כפול. ר' audit 2026-10-08 (חקירת התקלה) + CLAUDE.md.
// ---------------------------------------------------------------------------

export interface UpdateLeadContactInput {
  firstName?: string;
  lastName?: string;
  institutionName?: string;
  phone?: string;
  email?: string;
}

/** שם השדה הלוגי (לדיווח "מה עודכן בפועל") → עמודת Monday המתאימה. */
const CONTACT_COLUMN_BY_FIELD: Record<keyof UpdateLeadContactInput, string> = {
  firstName: "text_mknr5f59",
  lastName: "text_mknrtghs",
  institutionName: "text_mm6q8vxy",
  phone: "phone__1",
  email: "email__1",
};

/**
 * מעדכן רק את השדות שבאמת ניתנו (אחרים נשארים כפי שהיו — Monday לא נוגע בעמודה שלא מופיעה
 * ב-column_values). זורק אם הכתיבה נכשלה — לעולם לא "מצליח בשקט" חלקית: change_multiple_column_values
 * היא כתיבה אחת ל-Monday, אם היא זרקה שום שדה לא נכתב.
 */
export async function updateLeadContactColumns(
  itemId: string,
  input: UpdateLeadContactInput,
): Promise<(keyof UpdateLeadContactInput)[]> {
  const columnValues: Record<string, unknown> = {};
  const updatedFields: (keyof UpdateLeadContactInput)[] = [];

  if (input.firstName !== undefined) {
    columnValues[CONTACT_COLUMN_BY_FIELD.firstName] = input.firstName;
    updatedFields.push("firstName");
  }
  if (input.lastName !== undefined) {
    columnValues[CONTACT_COLUMN_BY_FIELD.lastName] = input.lastName;
    updatedFields.push("lastName");
  }
  if (input.institutionName !== undefined) {
    columnValues[CONTACT_COLUMN_BY_FIELD.institutionName] = input.institutionName;
    updatedFields.push("institutionName");
  }
  if (input.phone !== undefined) {
    columnValues[CONTACT_COLUMN_BY_FIELD.phone] = input.phone ? { phone: input.phone, countryShortName: "IL" } : null;
    updatedFields.push("phone");
  }
  if (input.email !== undefined) {
    columnValues[CONTACT_COLUMN_BY_FIELD.email] = input.email ? { email: input.email, text: input.email } : null;
    updatedFields.push("email");
  }

  if (updatedFields.length === 0) throw new Error("לא התקבל שום פרט קשר לעדכון");

  await mondayRequest(
    `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
    }`,
    { boardId: LEADS_BOARD_ID, itemId, columnValues: JSON.stringify(columnValues) },
  );

  return updatedFields;
}

export interface LeadRecord {
  itemId: string;
  name: string;
  status: string;
  /** מזהי Monday של כל מי שמופיע ב"אחראי/ת" (multiple_person__1) — מקור האמת ל"הליד הזה שלי". */
  ownerIds: string[];
  /** טקסט תצוגה ("דוב שפירא") — Monday ממלא את זה אוטומטית לעמודת people. */
  ownerNames: string;
  institutionName?: string;
  contactFirstName?: string;
  contactLastName?: string;
  phone?: string;
  email?: string;
  url: string;
}

const LEAD_RECORD_CV_IDS = `["multiple_person__1","color__1","text_mknr5f59","text_mknrtghs","text_mm6q8vxy","phone__1","email__1"]`;
const LEAD_RECORD_SELECTION = `id name column_values(ids: ${LEAD_RECORD_CV_IDS}) { id text ... on PeopleValue { persons_and_teams { id } } }`;
const MONDAY_HOST = "https://gottlieb-league.monday.com";

interface RawLeadCV {
  id: string;
  text: string | null;
  persons_and_teams?: { id: string }[] | null;
}
interface RawLeadItem {
  id: string;
  name: string;
  column_values: RawLeadCV[];
}

function cleanText(v: string | null | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t || undefined;
}

function toLeadRecord(it: RawLeadItem): LeadRecord {
  const col = (id: string) => it.column_values.find((c) => c.id === id);
  const ownerCol = col("multiple_person__1");
  return {
    itemId: it.id,
    name: it.name,
    status: cleanText(col("color__1")?.text) ?? "",
    ownerIds: (ownerCol?.persons_and_teams ?? []).map((p) => String(p.id)),
    ownerNames: cleanText(ownerCol?.text) ?? "",
    contactFirstName: cleanText(col("text_mknr5f59")?.text),
    contactLastName: cleanText(col("text_mknrtghs")?.text),
    institutionName: cleanText(col("text_mm6q8vxy")?.text),
    phone: cleanText(col("phone__1")?.text),
    email: cleanText(col("email__1")?.text),
    url: `${MONDAY_HOST}/boards/${LEADS_BOARD_ID}/pulses/${it.id}`,
  };
}

/** שולף ליד בודד לפי itemId. null אם לא נמצא (לא זורק — ההחלטה "אין כזה ליד" היא של הקורא). */
export async function getLeadRecordById(itemId: string): Promise<LeadRecord | null> {
  const res = await mondayRequest<{ items: RawLeadItem[] }>(
    `query ($id: [ID!]) { items(ids: $id) { ${LEAD_RECORD_SELECTION} } }`,
    { id: [itemId] },
  );
  const item = res.items[0];
  return item ? toLeadRecord(item) : null;
}

function normalizeLeadQuery(s: string): string {
  return s
    .replace(/["'`״׳,.\-–—()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * מחפש לידים לפי שם — מושך את כל הלוח ומדרג בהתאמה (שמות ב-Monday מלאים בקיצורים/מירכאות,
 * חיפוש טקסט מדויק מפספס). 138 פריטים כיום (2026-10-08) — עמוד אחד; פאג'ינציה ל-cursor
 * (crmRead.ts's pageAll) לא נדרשת כאן כי items_page(limit:200) כבר מכסה את כל הבורד, אבל
 * ה-cursor נבדק ונמשך בכל זאת למקרה שהבורד יגדל.
 */
export async function searchLeadRecords(query: string): Promise<LeadRecord[]> {
  const q = normalizeLeadQuery(query);
  if (q.length < 2) return [];
  const words = q.split(" ").filter((w) => w.length >= 2);

  const first = await mondayRequest<{ boards: { items_page: { cursor: string | null; items: RawLeadItem[] } }[] }>(
    `query { boards(ids: [${LEADS_BOARD_ID}]) { items_page(limit: 200) { cursor items { ${LEAD_RECORD_SELECTION} } } } }`,
  );
  const page = first.boards[0]?.items_page;
  const items: RawLeadItem[] = page ? [...page.items] : [];
  let cursor = page?.cursor ?? null;
  while (cursor) {
    const next = await mondayRequest<{ next_items_page: { cursor: string | null; items: RawLeadItem[] } }>(
      `query { next_items_page(cursor: "${cursor}", limit: 200) { cursor items { ${LEAD_RECORD_SELECTION} } } }`,
    );
    items.push(...next.next_items_page.items);
    cursor = next.next_items_page.cursor;
  }

  const score = (name: string): number => {
    const n = normalizeLeadQuery(name);
    if (n.includes(q)) return 100;
    return words.reduce((s, w) => s + (n.includes(w) ? 1 : 0), 0);
  };

  const scored = items.map((it) => ({ it, s: score(it.name) }));
  const exact = scored.filter((x) => x.s >= 100);
  const strong = scored.filter((x) => x.s > 0 && x.s >= words.length && x.s < 100);
  const pool = exact.length ? exact : strong.length ? strong : scored.filter((x) => x.s > 0);

  return pool
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
    .map((x) => toLeadRecord(x.it));
}
