/**
 * בדיקות ל-find_lead / update_lead_contact + הרחבת create_lead (institutionName) — 2026-10-08.
 *
 * רקע (audit 2026-10-08): תקלת production — ליד "ויז'שניץ מונסי עמנואל" נוצר, אך כשהגיעו בהמשך
 * פרטי איש קשר (שם/טלפון/מייל) לא הייתה שום דרך לעדכן את עמודות הליד הקיים: רק create_lead
 * (יצירה בלבד, יוצר כפילות אם נקרא שוב) ו-add_update (הערת טקסט, לא עמודה). הסוכן אף ביקש מחדש
 * טלפון שכבר נמסר. התיקון: שתי פעולות AgentTool משותפות חדשות (find_lead/update_lead_contact,
 * ops/agentTools.ts) + עמודת institutionName נפרדת לשם עמותה/קהילה/מוסד (text_mm6q8vxy) כדי
 * שלא תיכתב בטעות לתוך שם איש הקשר (text_mknr5f59).
 *
 * כל הבדיקות כאן ב-ops/actions.ts (שכבת הלוגיקה העסקית) + leads.ts (שכבת הכתיבה הגולמית) עם
 * deps מוזרקים/mondayClient.request מודבק זמנית — **לעולם לא נוגעות ב-Monday האמיתי**. אין
 * קריאת AI בכלל כאן (זו שכבת הכלים/הפעולות, לא המודל).
 *
 *   npm run test:lead-contact
 */

import "dotenv/config";
import { resolveUserByKey } from "../src/identity/index.js";
import {
  createLeadAction,
  findLeadAction,
  updateLeadContactAction,
  type CreateLeadDeps,
  type FindLeadDeps,
  type UpdateLeadContactDeps,
} from "../src/ops/actions.js";
import { agentToolsForUser } from "../src/ops/agentTools.js";
import {
  createLead,
  updateLeadContactColumns,
  type LeadRecord,
  type UpdateLeadContactInput,
} from "../src/integrations/monday/leads.js";
import { mondayClient } from "../src/integrations/monday/client.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
function check(label: string, cond: boolean, extra = "") {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
}

async function expectRejects(label: string, fn: () => Promise<unknown>, messageIncludes: string) {
  try {
    await fn();
    check(label, false, "לא זרק שגיאה בכלל");
  } catch (err) {
    const msg = (err as Error).message;
    check(label, msg.includes(messageIncludes), `הודעה בפועל: "${msg}"`);
  }
}

const RUN_TAG = Date.now();

const moti = resolveUserByKey("moti")!; // owner — lead:manage + view:all_work (bypass record-level scope)
const dov = resolveUserByKey("dov")!; // project_manager — lead:manage, אין view:all_work
const eitan = resolveUserByKey("eitan")!; // project_manager — lead:manage, אין view:all_work
const ruchama = resolveUserByKey("ruchama")!; // planner — אין lead:manage
const goldi = resolveUserByKey("goldi")!; // finance — אין lead:manage

async function main() {
  // ───────────────────────── 1. create_lead: ליד עמותה בלי שם איש קשר ─────────────────────────
  {
    const created: Record<string, unknown>[] = [];
    const r = await createLeadAction(
      dov,
      { institutionName: `ויז'שניץ מונסי עמנואל ${RUN_TAG}` },
      { createLead: async (input) => { created.push(input as unknown as Record<string, unknown>); return { id: "lead1", name: String(input.institutionName) }; } } satisfies CreateLeadDeps,
    );
    check("ליד-עמותה בלי שם איש קשר: נוצר בהצלחה (לא חוסם על מידע חלקי)", r.ok && !r.deduped);
    check(
      "institutionName עבר ל-createLead, firstName נשאר undefined (לא נדרס בטעות עם שם העמותה)",
      created.length === 1 &&
        created[0]!.institutionName === `ויז'שניץ מונסי עמנואל ${RUN_TAG}` &&
        created[0]!.firstName === undefined,
    );
    check("הודעת ההצלחה מזכירה את שם הליד שנוצר", r.message.includes("נוצר ליד"));
  }

  // ───────────────────────── 2. create_lead: בלי firstName וגם בלי institutionName → נדחה ─────────────────────────
  await expectRejects(
    "create_lead בלי firstName ובלי institutionName → נדחה עם שגיאה ברורה (לא יוצר ליד בלי שם)",
    () => createLeadAction(dov, {}, {} satisfies CreateLeadDeps),
    "חסר שם לליד",
  );

  // ───────────────────────── 3. רגרסיה: create_lead עם כל פרטי הקשר בקריאה אחת (כמו קודם) ─────────────────────────
  {
    const created: Record<string, unknown>[] = [];
    const r = await createLeadAction(
      dov,
      { firstName: `ישראל${RUN_TAG}`, lastName: "לסיצין", phone: "0533116061", email: "viznitze2026@gmail.com" },
      { createLead: async (input) => { created.push(input as unknown as Record<string, unknown>); return { id: "lead2", name: "ישראל לסיצין" }; } } satisfies CreateLeadDeps,
    );
    check("רגרסיה: create_lead עם פרטי קשר מלאים בקריאה אחת — עדיין עובד כמו קודם", r.ok && !r.deduped, `r=${JSON.stringify(r)}`);
    check(
      "רגרסיה: firstName/lastName/phone/email כולם עברו ללא שינוי",
      !!created[0] &&
        created[0]!.firstName === `ישראל${RUN_TAG}` &&
        created[0]!.lastName === "לסיצין" &&
        created[0]!.phone === "0533116061" &&
        created[0]!.email === "viznitze2026@gmail.com" &&
        created[0]!.institutionName === undefined,
    );
  }

  // ───────────────────────── 4. אין כפילות לידים — retry עם קלט זהה מזוהה כ-dedup ─────────────────────────
  {
    let createCalls = 0;
    const deps: CreateLeadDeps = {
      createLead: async (input) => {
        createCalls++;
        return { id: `idem-${RUN_TAG}`, name: String(input.institutionName) };
      },
    };
    const input = { institutionName: `עמותה אידמפוטנטית ${RUN_TAG}` };
    const first = await createLeadAction(eitan, input, deps);
    const second = await createLeadAction(eitan, input, deps);
    check("אין כפילות: הקריאה הראשונה יצרה בפועל", first.ok && !first.deduped);
    check("אין כפילות: הקריאה השנייה (retry, קלט זהה) זוהתה כ-dedup", second.ok && second.deduped);
    check("אין כפילות: אותו itemId בשתי הפעמים", first.itemId === second.itemId);
    check("אין כפילות: createLead האמיתי נקרא פעם אחת בלבד", createCalls === 1, `בפועל: ${createCalls}`);
  }

  // ───────────────────────── 5. זרימה מלאה: ליד-עמותה → איש קשר → טלפון → מייל, כולם על אותו ליד ─────────────────────────
  // מדמה מאגר Monday זעיר בזיכרון כדי להוכיח ששלושת העדכונים חוזרים לאותו itemId ושכל עדכון חלקי
  // משאיר את מה שנכתב קודם (לא דורס), בלי לגעת ב-Monday האמיתי.
  {
    const leadStore: LeadRecord = {
      itemId: "9999",
      name: `ויז'שניץ מונסי עמנואל ${RUN_TAG}`,
      status: "ליד חדש",
      ownerIds: [dov.mondayUserId!],
      ownerNames: dov.name,
      institutionName: `ויז'שניץ מונסי עמנואל ${RUN_TAG}`,
      contactFirstName: undefined,
      contactLastName: undefined,
      phone: undefined,
      email: undefined,
      url: "https://gottlieb-league.monday.com/boards/1550734525/pulses/9999",
    };
    const updateCalls: UpdateLeadContactInput[] = [];
    const findDeps: FindLeadDeps = {
      searchLeadRecords: async (q) => (leadStore.name.includes(q) || (leadStore.institutionName ?? "").includes(q) ? [leadStore] : []),
    };
    const updateDeps: UpdateLeadContactDeps = {
      getLeadRecordById: async (id) => (id === leadStore.itemId ? { ...leadStore } : null),
      updateLeadContactColumns: async (_id, fields) => {
        updateCalls.push(fields);
        if (fields.firstName !== undefined) leadStore.contactFirstName = fields.firstName || undefined;
        if (fields.lastName !== undefined) leadStore.contactLastName = fields.lastName || undefined;
        if (fields.institutionName !== undefined) leadStore.institutionName = fields.institutionName || undefined;
        if (fields.phone !== undefined) leadStore.phone = fields.phone || undefined;
        if (fields.email !== undefined) leadStore.email = fields.email || undefined;
        return Object.keys(fields) as (keyof UpdateLeadContactInput)[];
      },
    };

    const found = await findLeadAction(dov, { query: "ויז'שניץ" }, findDeps);
    check(
      "find_lead מאתר את הליד הקיים לפי שם העמותה (לא יוצר חדש, לא מנחש itemId)",
      found.matches.length === 1 && found.matches[0]!.itemId === "9999",
    );

    const r1 = await updateLeadContactAction(dov, { itemId: "9999", firstName: "ישראל", lastName: "לסיצין" }, updateDeps);
    check("עדכון 1 (איש קשר): הצליח, עודכנו רק firstName/lastName", r1.ok && r1.updatedFields.slice().sort().join(",") === "firstName,lastName");
    check("עדכון 1: נכתב בפועל ל'מאגר' — contactFirstName/contactLastName", leadStore.contactFirstName === "ישראל" && leadStore.contactLastName === "לסיצין");
    check("עדכון 1: institutionName לא נגע (עדיין שם העמותה, לא נדרס)", leadStore.institutionName === `ויז'שניץ מונסי עמנואל ${RUN_TAG}`);

    const r2 = await updateLeadContactAction(dov, { itemId: "9999", phone: "0533116061" }, updateDeps);
    check("עדכון 2 (טלפון): הצליח, עודכן רק phone", r2.ok && r2.updatedFields.join(",") === "phone");
    check("עדכון 2: הטלפון נכתב בפועל", leadStore.phone === "0533116061");
    check("עדכון 2 (partial update משמר שדות קודמים): שם איש הקשר מעדכון 1 עדיין קיים", leadStore.contactFirstName === "ישראל");
    check("עדכון 2: המייל עדיין לא קיים (עוד לא עודכן)", leadStore.email === undefined);

    const r3 = await updateLeadContactAction(dov, { itemId: "9999", email: "viznitze2026@gmail.com" }, updateDeps);
    check("עדכון 3 (מייל): הצליח, עודכן רק email", r3.ok && r3.updatedFields.join(",") === "email");
    check("עדכון 3: המייל נכתב בפועל", leadStore.email === "viznitze2026@gmail.com");
    check("עדכון 3 (partial update משמר שדות קודמים): הטלפון מעדכון 2 עדיין קיים", leadStore.phone === "0533116061");
    check("עדכון 3: אף קריאה לא כללה create_lead מחדש — 3 updateLeadContactColumns, 0 כפילויות", updateCalls.length === 3);
    check("הודעת הצלחה מדויקת: מזכירה את השדה שעודכן (email) ואת פעולת העדכון", r3.message.includes("email") && r3.message.includes("עודכנו"));
  }

  // ───────────────────────── 6. חיפוש עמום / אפס תוצאות — לא מנחש, מחזיר את המצב כמו שהוא ─────────────────────────
  {
    const twoMatches: LeadRecord[] = [
      { itemId: "101", name: "שלב 3", status: "", ownerIds: [dov.mondayUserId!], ownerNames: dov.name, url: "u1" },
      { itemId: "102", name: "שלב 3 - תשלום", status: "", ownerIds: [dov.mondayUserId!], ownerNames: dov.name, url: "u2" },
    ];
    const ambiguous = await findLeadAction(dov, { query: "שלב 3" }, { searchLeadRecords: async () => twoMatches });
    check("חיפוש עמום: find_lead מחזיר את כל ההתאמות בלי לבחור אחת לבד (ההחלטה איזו — על הקורא/המודל)", ambiguous.matches.length === 2);

    const none = await findLeadAction(dov, { query: "לא קיים בכלל" }, { searchLeadRecords: async () => [] });
    check("אפס תוצאות: find_lead מחזיר matches ריק, לא שגיאה", none.matches.length === 0);
  }
  await expectRejects("find_lead בלי query → נדחה", () => findLeadAction(dov, { query: "" }, {}), "חסרה מילת חיפוש");

  // ───────────────────────── 7. הרשאה על רמת הרשומה (record-level) — lead:manage לבדה לא מספיקה ─────────────────────────
  {
    const eitansLead: LeadRecord = {
      itemId: "777",
      name: "ליד של איתן",
      status: "",
      ownerIds: [eitan.mondayUserId!],
      ownerNames: eitan.name,
      url: "u",
    };

    const found = await findLeadAction(dov, { query: "ליד" }, { searchLeadRecords: async () => [eitansLead] });
    check(
      "record-level: דוב (lead:manage, לא owner/admin) לא רואה ליד שהוא לא אחראי עליו — אפילו שהחיפוש 'מצא' אותו",
      found.matches.length === 0,
    );

    const foundByOwner = await findLeadAction(eitan, { query: "ליד" }, { searchLeadRecords: async () => [eitansLead] });
    check("record-level: איתן (אחראי בפועל על הליד) כן רואה אותו", foundByOwner.matches.length === 1);

    const foundByMoti = await findLeadAction(moti, { query: "ליד" }, { searchLeadRecords: async () => [eitansLead] });
    check("record-level: מוטי (owner) עוקף — רואה לידים של כל אחד", foundByMoti.matches.length === 1);

    await expectRejects(
      "record-level: דוב מנסה לעדכן ליד של איתן (לא שלו) → נדחה",
      () =>
        updateLeadContactAction(dov, { itemId: "777", phone: "0501111111" }, {
          getLeadRecordById: async () => eitansLead,
          updateLeadContactColumns: async () => ["phone"],
        }),
      "לא משויך אליך",
    );

    {
      const updateCalls: UpdateLeadContactInput[] = [];
      const r = await updateLeadContactAction(moti, { itemId: "777", phone: "0501111111" }, {
        getLeadRecordById: async () => eitansLead,
        updateLeadContactColumns: async (_id, fields) => {
          updateCalls.push(fields);
          return ["phone"];
        },
      });
      check("record-level: מוטי (owner) כן יכול לעדכן ליד של איתן — bypass", r.ok && updateCalls.length === 1);
    }
  }

  // ───────────────────────── 8. אין הרשאת lead:manage כלל ─────────────────────────
  await expectRejects("גולדי (finance, אין lead:manage) מנסה find_lead → נדחה", () => findLeadAction(goldi, { query: "x" }, {}), "הרשאה לנהל לידים");
  await expectRejects(
    "גולדי מנסה update_lead_contact → נדחה",
    () => updateLeadContactAction(goldi, { itemId: "9999", phone: "x" }, {}),
    "הרשאה לנהל לידים",
  );

  // ───────────────────────── 9. ולידציית קלט ב-update_lead_contact ─────────────────────────
  await expectRejects(
    "update_lead_contact עם itemId לא תקין (לא מספרי) → נדחה לפני כל קריאה ל-Monday",
    () => updateLeadContactAction(dov, { itemId: "abc" }, {}),
    "מזהה ליד לא תקין",
  );
  await expectRejects(
    "update_lead_contact על ליד שלא נמצא (getLeadRecordById מחזיר null) → שגיאה ברורה",
    () => updateLeadContactAction(dov, { itemId: "123456" }, { getLeadRecordById: async () => null }),
    "לא מצאתי ליד",
  );
  await expectRejects(
    "update_lead_contact בלי אף שדה לעדכון → נדחה (לא קריאה ריקה ל-Monday)",
    () =>
      updateLeadContactAction(dov, { itemId: "9999" }, {
        getLeadRecordById: async () => ({
          itemId: "9999",
          name: "x",
          status: "",
          ownerIds: [dov.mondayUserId!],
          ownerNames: dov.name,
          url: "u",
        }),
      }),
    "לא נתת שום פרט",
  );

  // ───────────────────────── 10. כשל אמיתי ב-Monday מתפשט — לא "מצליח בשקט" ─────────────────────────
  await expectRejects(
    "update_lead_contact: אם הכתיבה ל-Monday נכשלת (Rate limit וכו') — השגיאה מתפשטת, לא נדווח הצלחה",
    () =>
      updateLeadContactAction(dov, { itemId: "9999", phone: "0500000000" }, {
        getLeadRecordById: async () => ({
          itemId: "9999",
          name: "x",
          status: "",
          ownerIds: [dov.mondayUserId!],
          ownerNames: dov.name,
          url: "u",
        }),
        updateLeadContactColumns: async () => {
          throw new Error("Monday rate limit — נסה שוב");
        },
      }),
    "Monday rate limit",
  );

  // ───────────────────────── 11. חשיפת הכלים (registry המשותף — הבסיס לשני הערוצים) ─────────────────────────
  {
    const dovNames = agentToolsForUser(dov).map((t) => t.name);
    check("דוב (lead:manage) רואה find_lead", dovNames.includes("find_lead"));
    check("דוב (lead:manage) רואה update_lead_contact", dovNames.includes("update_lead_contact"));
    const goldiNames = agentToolsForUser(goldi).map((t) => t.name);
    check("גולדי (אין lead:manage) לא רואה find_lead", !goldiNames.includes("find_lead"));
    check("גולדי לא רואה update_lead_contact", !goldiNames.includes("update_lead_contact"));
    const ruchamaNames = agentToolsForUser(ruchama).map((t) => t.name);
    check("רוחמה (planner, אין lead:manage) לא רואה find_lead/update_lead_contact", !ruchamaNames.includes("find_lead") && !ruchamaNames.includes("update_lead_contact"));
  }

  // ───────────────────────── 12. leads.ts: המבנה שנשלח ל-Monday בפועל (mondayClient.request מודבק זמנית) ─────────────────────────
  // leads.ts קורא ל-mondayClient.request/mondayRequest ישירות (בלי DI) — בדיוק כמו כל שאר שכבת
  // ה-integrations/monday/*. כדי לבדוק את ה-payload המדויק בלי לגעת ב-Monday האמיתי, מדביקים
  // זמנית את mondayClient.request (אותו דפוס monkey-patch כמו test-web-shared-tool-definition.ts's
  // proveDelegatesToAgentTool), תופסים את ה-variables, ומשחזרים את המקור תמיד ב-finally.
  logger.info("— leads.ts: ה-column_values/column_values JSON שנשלח בפועל ל-Monday —");
  {
    const original = mondayClient.request.bind(mondayClient);
    const capturedRef: { current: { query: string; variables?: Record<string, unknown> } | null } = { current: null };
    (mondayClient as unknown as { request: typeof mondayClient.request }).request = (async (query: string, variables?: Record<string, unknown>) => {
      capturedRef.current = { query, variables };
      return { create_item: { id: "fake1", name: "fake" } };
    }) as typeof mondayClient.request;
    try {
      await createLead({ institutionName: "עמותת בדיקה" });
      const cv = JSON.parse(String(capturedRef.current?.variables?.columnValues ?? "{}"));
      check("createLead(institutionName בלבד): text_mm6q8vxy נכתב", cv.text_mm6q8vxy === "עמותת בדיקה");
      check("createLead(institutionName בלבד): text_mknr5f59 (שם איש קשר) לא נכתב בכלל — לא נדרס בטעות", !("text_mknr5f59" in cv));
    } finally {
      (mondayClient as unknown as { request: typeof mondayClient.request }).request = original;
    }
  }

  // updateLeadContactColumns משתמש ב-mondayRequest (עטיפת retry מעל mondayClient.request) — אותו
  // monkey-patch עובד כי mondayRequest קורא ל-mondayClient.request בפנים.
  {
    const original = mondayClient.request.bind(mondayClient);
    const capturedRef: { current: { query: string; variables?: Record<string, unknown> } | null } = { current: null };
    (mondayClient as unknown as { request: typeof mondayClient.request }).request = (async (query: string, variables?: Record<string, unknown>) => {
      capturedRef.current = { query, variables };
      return { change_multiple_column_values: { id: "9999" } };
    }) as typeof mondayClient.request;
    try {
      const updated = await updateLeadContactColumns("9999", { phone: "0533116061", email: "viznitze2026@gmail.com" });
      check("updateLeadContactColumns: שימוש ב-change_multiple_column_values", (capturedRef.current?.query ?? "").includes("change_multiple_column_values"));
      const cv = JSON.parse(String(capturedRef.current?.variables?.columnValues ?? "{}"));
      check("updateLeadContactColumns: phone__1 בפורמט הנכון ({phone,countryShortName})", cv.phone__1?.phone === "0533116061" && cv.phone__1?.countryShortName === "IL");
      check("updateLeadContactColumns: email__1 בפורמט הנכון ({email,text})", cv.email__1?.email === "viznitze2026@gmail.com" && cv.email__1?.text === "viznitze2026@gmail.com");
      check("updateLeadContactColumns: רק phone+email נכתבו, לא institutionName/firstName/lastName (partial update אמיתי)", Object.keys(cv).sort().join(",") === "email__1,phone__1");
      check("updateLeadContactColumns: מחזיר את רשימת השדות שעודכנו בפועל", updated.sort().join(",") === "email,phone");
    } finally {
      (mondayClient as unknown as { request: typeof mondayClient.request }).request = original;
    }
  }

  await expectRejects(
    "updateLeadContactColumns בלי שום שדה → נדחה לפני כל קריאה ל-Monday",
    () => updateLeadContactColumns("9999", {}),
    "לא התקבל שום פרט",
  );

  logger.info(failed === 0 ? "\n✅ כל הבדיקות עברו" : `\n❌ ${failed} בדיקות נכשלו`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  logger.error({ err }, "test-lead-contact נכשל עם שגיאה לא צפויה");
  process.exit(1);
});
