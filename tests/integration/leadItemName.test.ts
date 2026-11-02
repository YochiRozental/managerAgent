/**
 * שם פריט הליד = שם הפרויקט/הליד (טופס הצ'אט, 2026-11-02): ודא שיצירה, ווצאפ, קישור איש קשר, חיפוש ועדכון ליד
 * ממשיכים לעבוד. mondayClient.request מודבק (אותו דפוס כמו leadContact.test.ts) — לעולם לא נוגעים ב-Monday האמיתי.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mondayClient } from "../../src/integrations/monday/client.js";
import { searchLeadsAndDeals } from "../../src/integrations/monday/crmRead.js";
import {
  createLead,
  leadSearchScore,
  searchLeadRecords,
  updateLeadContactColumns,
} from "../../src/integrations/monday/leads.js";

type Call = { query: string; variables?: Record<string, unknown> };
const original = mondayClient.request.bind(mondayClient);
const calls: Call[] = [];

function fakeMonday(handler: (c: Call) => unknown) {
  calls.length = 0;
  (mondayClient as unknown as { request: typeof mondayClient.request }).request = (async (query: string, variables?: Record<string, unknown>) => {
    const c = { query, variables };
    calls.push(c);
    return handler(c);
  }) as typeof mondayClient.request;
}
afterEach(() => {
  (mondayClient as unknown as { request: typeof mondayClient.request }).request = original;
});

const createdColumns = () => JSON.parse(String(calls[0]!.variables?.columnValues ?? "{}")) as Record<string, any>;

describe("createLead — שם הפריט ועמודות איש הקשר", () => {
  const create = () => ({ create_item: { id: "1", name: "x" } });

  it("itemName מפורש → שם הפריט; איש הקשר נשמר בעמודות (משם האוטומציה הקיימת יוצרת ומקשרת אותו)", async () => {
    fakeMonday(create);
    await createLead({ itemName: "בית פרטי ברמת גן", firstName: "דנה", lastName: "בן דוד", phone: "0501234567", email: "d@x.co", product: "בית ספר" });
    expect(calls[0]!.variables?.itemName).toBe("בית פרטי ברמת גן");
    const cv = createdColumns();
    expect(cv).toMatchObject({ text_mknr5f59: "דנה", text_mknrtghs: "בן דוד", color5__1: { label: "בית ספר" } });
    expect(cv.phone__1.phone).toBe("0501234567");
    expect(cv.email__1.email).toBe("d@x.co");
  });

  it("בלי itemName (WhatsApp / אתר) → כמו תמיד: שם איש הקשר; ואם אין — שם המוסד", async () => {
    fakeMonday(create);
    await createLead({ firstName: "ישראל", lastName: "לסיצין" });
    expect(calls[0]!.variables?.itemName).toBe("ישראל לסיצין");
    await createLead({ institutionName: "עמותת בדיקה" });
    expect(calls[1]!.variables?.itemName).toBe("עמותת בדיקה");
  });

  it("ווצאפ שונה מהנייד → עמודת הווצאפ בלבד, בלי תיבת '?מקבל ווצאפ' (אוטומציה מעתיקה את הנייד כשהיא מסומנת)", async () => {
    fakeMonday(create);
    await createLead({ itemName: "x", firstName: "א", phone: "0501111111", whatsapp: "0522222222" });
    const cv = createdColumns();
    expect(cv.phone_mm0mbhwj).toEqual({ phone: "0522222222", countryShortName: "IL" });
    expect("boolean_mm0m3q0p" in cv).toBe(false);
  });

  it("ווצאפ זהה לנייד → תיבת הסימון בלבד", async () => {
    fakeMonday(create);
    await createLead({ itemName: "x", firstName: "א", phone: "0501111111", whatsappSameAsPhone: true });
    const cv = createdColumns();
    expect(cv.boolean_mm0m3q0p).toEqual({ checked: "true" });
    expect("phone_mm0mbhwj" in cv).toBe(false);
  });

  it("לא נכתבות עמודות ווצאפ בכלל כשלא ניתן ווצאפ (אין / לא מולא)", async () => {
    fakeMonday(create);
    await createLead({ itemName: "x", firstName: "א", phone: "0501111111" });
    const cv = createdColumns();
    expect("phone_mm0mbhwj" in cv).toBe(false);
    expect("boolean_mm0m3q0p" in cv).toBe(false);
    expect("email__1" in cv).toBe(false);
  });
});

describe("חיפוש לידים אחרי שינוי שם הפריט", () => {
  const cv = (id: string, text: string | null) => ({ id, text });
  const lead = (id: string, name: string, first?: string, last?: string, inst?: string) => ({
    id,
    name,
    column_values: [
      cv("text_mknr5f59", first ?? null),
      cv("text_mknrtghs", last ?? null),
      cv("text_mm6q8vxy", inst ?? null),
      cv("multiple_person__1", null),
      cv("color__1", "ליד חדש"),
    ],
  });
  const ITEMS = [
    lead("1", "בית פרטי ברמת גן", "דנה", "בן דוד"), // שם פרויקט (הפורמט החדש)
    lead("2", "ישראל לסיצין", "ישראל", "לסיצין"), // שם איש קשר (הפורמט הישן)
    lead("3", "בית כנסת בנס ציונה", "ברק", undefined, "קהילת נס ציונה"),
    lead("4", "משהו אחר לגמרי", "אבי", "כהן"),
  ];
  const page = () => ({ boards: [{ items_page: { cursor: null, items: ITEMS } }] });
  const names = (r: { name: string }[]) => r.map((x) => x.name);

  it("searchLeadRecords: ליד ששמו שם פרויקט נמצא לפי שם הפרויקט, לפי שם איש הקשר ולפי שם המוסד", async () => {
    fakeMonday(page);
    expect(names(await searchLeadRecords("ברמת גן"))).toEqual(["בית פרטי ברמת גן"]);
    expect(names(await searchLeadRecords("דנה בן דוד"))).toEqual(["בית פרטי ברמת גן"]);
    expect(names(await searchLeadRecords("קהילת נס ציונה"))).toEqual(["בית כנסת בנס ציונה"]);
  });

  it("searchLeadRecords: ליד בפורמט הישן (שם = איש קשר) נמצא בדיוק כמו קודם, ושאילתה לא קשורה לא מחזירה כלום", async () => {
    fakeMonday(page);
    expect(names(await searchLeadRecords("לסיצין"))).toEqual(["ישראל לסיצין"]);
    expect(await searchLeadRecords("לא קיים בכלל")).toEqual([]);
  });

  it("searchLeadsAndDeals (find_lead_or_deal של מוטי): אותו דבר — גם לפי איש קשר", async () => {
    fakeMonday(() => ({ boards: [{ items_page: { cursor: null, items: ITEMS } }] }));
    const byContact = await searchLeadsAndDeals("דנה בן דוד");
    expect(byContact.filter((m) => m.board === "לידים").map((m) => m.name)).toContain("בית פרטי ברמת גן");
    const byProject = await searchLeadsAndDeals("בית פרטי ברמת גן");
    expect(byProject[0]!.name).toBe("בית פרטי ברמת גן");
    // השאילתה מבקשת גם את עמודות איש הקשר
    expect(calls[0]!.query).toContain("text_mknr5f59");
  });

  it("leadSearchScore: התאמה מלאה = 100; חפיפת מילים חלקית בין שדות; ריק = 0", () => {
    const f = { name: "בית פרטי", contactFirst: "דנה", contactLast: "בן דוד" };
    expect(leadSearchScore(f, "דנה בן דוד", ["דנה", "בן", "דוד"])).toBe(100);
    expect(leadSearchScore(f, "דנה פרטי", ["דנה", "פרטי"])).toBe(2);
    expect(leadSearchScore(f, "זזזזז", ["זזזזז"])).toBe(0);
  });
});

describe("עדכון ליד קיים לא נוגע בשם הפריט", () => {
  it("updateLeadContactColumns כותב רק עמודות איש קשר — בלי name", async () => {
    fakeMonday(() => ({ change_multiple_column_values: { id: "9" } }));
    await updateLeadContactColumns("9", { phone: "0533116061", firstName: "ישראל" });
    const cv = JSON.parse(String(calls[0]!.variables?.columnValues));
    expect(Object.keys(cv).sort()).toEqual(["phone__1", "text_mknr5f59"]);
    expect("name" in cv).toBe(false);
  });
});
