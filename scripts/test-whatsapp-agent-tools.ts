/**
 * בדיקת חיבור add_monday_update/create_lead (WhatsApp, integrations/claude/tools.ts) ל-AgentTools
 * המשותפים (שלב 3B, 2026-10-05) + ביטול כפילות בדיקת ההרשאות (שלב 3C, 2026-10-07) + mark_done/
 * set_status (שלב 3D, 2026-10-07) + create_task (שלב 3E, 2026-10-07) — כל אחד domain action
 * נוסף, אותו דפוס בדיוק: agentTool link, אין requiredPermission עצמאי (אלא אם יש gate קיים
 * לשמר, כמו add_monday_update), legacy primitive מקביל (אם קיים) נשאר ללא שינוי כ-fallback.
 *
 * מוודאת:
 *  1. שני הכלים עדיין קיימים ב-tools.ts בשם/schema שה-WhatsApp model כבר מכיר — ללא שינוי.
 *  2. ADD_UPDATE_AGENT_TOOL/CREATE_LEAD_AGENT_TOOL (המיובאים ב-tools.ts בפועל) הם === האובייקטים
 *     ב-AGENT_TOOLS — **אותו אובייקט בזיכרון שגם ops/chat.ts (Web) משתמש בו**, לא עותק. זו ההוכחה
 *     המרכזית ל"לא ממומש מחדש ב-WhatsApp" — לא רק "קורא לפונקציה דומה".
 *  3. requireIdentifiedUser (הלוגיקה החדשה היחידה שנכתבה ב-tools.ts) מתנהגת נכון כפונקציה טהורה.
 *  4. permission handling (שלב 3C): שני הכלים נושאים agentTool (קישור גנרי ל-AgentTool המשותף).
 *     add_monday_update שומר requiredPermission="task:update_own" — **אותה תוצאה בדיוק כמו לפני
 *     Step 3B** (הוחלט בביקורת נפרדת: "אל תרחיב capability surface בשקט"), אבל עכשיו מבוטא
 *     כצמצום *נבדק* (subset) של ANY-of ה-AgentTool, לא כהשוואה עצמאית שרק קורה להסכים איתו.
 *     create_lead מאבד את requiredPermission העצמאי שלו לחלוטין — ה-ANY-of היחיד שחל הוא
 *     AgentTool.requiredPermission (כיום הסינגלטון ['lead:manage'], זהה למה שהיה).
 *  4b. structural delegation: מוכיחה עם AgentTool מדומה (לא AGENT_TOOLS האמיתי) שהבדיקה בפועל
 *      *קוראת* מ-tool.agentTool.requiredPermission בזמן אמת, ולא רק "קורה" להחזיר את אותה תוצאה.
 *  5. idempotency/default-assignee/ANY-of permissions של create_lead/add_update עצמם *לא* נבדקים
 *     מחדש כאן — הם כבר מכוסים ביסודיות ב-test-agent-tools.ts (שלבים 2C/2D) מול *אותה* AgentTool
 *     objects בדיוק (הוכח בסעיף 2) — בדיקה חוזרת הייתה redundant, לא תוספת ביטחון.
 *
 * *** לא מפעילה שום .execute() אמיתי על ADD_UPDATE_AGENT_TOOL/CREATE_LEAD_AGENT_TOOL — הם
 * קשורים לפונקציות production האמיתיות (addUpdateToItem/createLeadAction, בלי deps מוזרקים),
 * אז הרצתם האמיתית הייתה פוגעת ב-Monday live. ההוכחה היחידה הבטוחה לזהות המנגנון היא
 * object identity (===), לא הרצה. ***
 *
 *   npm run test:whatsapp-agent-tools
 */

import {
  tools as whatsappTools,
  getTool,
  toAnthropicTools,
  isToolAllowedForUser,
  requireIdentifiedUser,
  ADD_UPDATE_AGENT_TOOL,
  CREATE_LEAD_AGENT_TOOL,
  MARK_DONE_AGENT_TOOL,
  SET_STATUS_AGENT_TOOL,
  CREATE_TASK_AGENT_TOOL,
  normalizeTaskSource,
  type ToolContext,
  type ToolDefinition,
} from "../src/integrations/claude/tools.js";
import { AGENT_TOOLS, type AgentTool } from "../src/ops/agentTools.js";
import { resolveUserByKey } from "../src/identity/index.js";
import { logger } from "../src/utils/logger.js";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) logger.info(`✅ ${msg}`);
  else {
    failures++;
    logger.error(`❌ ${msg}`);
  }
}
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function registryTool(name: string) {
  const t = AGENT_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`AgentTool "${name}" לא נמצא ב-registry`);
  return t;
}

const moti = resolveUserByKey("moti")!; // owner — יש לו הכל
const goldi = resolveUserByKey("goldi")!; // finance: view:own_work, view:finance, finance:manage, report:hours — *אין* task:update_own
const ruchama = resolveUserByKey("ruchama")!; // planner — אין lead:manage

async function main() {
  // ───────────────────────── 1. הכלים קיימים ב-tools.ts, name/schema ללא שינוי ─────────────────────────
  logger.info("— add_monday_update/create_lead: קיימים ב-tools.ts, schema ללא שינוי —");

  const addUpdateTool = getTool("add_monday_update");
  assert(!!addUpdateTool, "add_monday_update עדיין קיים ב-tools.ts");
  assert(
    deepEqual(addUpdateTool?.input_schema, {
      type: "object",
      properties: {
        itemId: { type: "string", description: "מזהה הפריט" },
        body: { type: "string", description: "תוכן התגובה" },
      },
      required: ["itemId", "body"],
    }),
    "add_monday_update.input_schema זהה למה שה-WhatsApp model הכיר לפני המעבר (ללא label)",
  );
  assert(addUpdateTool?.requiresConfirmation === false, "add_monday_update.requiresConfirmation ללא שינוי (false)");

  const createLeadTool = getTool("create_lead");
  assert(!!createLeadTool, "create_lead עדיין קיים ב-tools.ts");
  assert(createLeadTool?.name === "create_lead", "create_lead.name ללא שינוי");
  const createLeadProps = Object.keys(
    (createLeadTool?.input_schema as { properties: Record<string, unknown> }).properties,
  ).sort();
  assert(
    createLeadProps.join(",") === "email,firstName,lastName,phone,product,referredBy,source",
    "create_lead.input_schema זהה למה שה-WhatsApp model הכיר (7 שדות, בלי assignee)",
  );
  assert(
    deepEqual((createLeadTool?.input_schema as { required: string[] }).required, ["firstName"]),
    "create_lead.required === ['firstName'], ללא שינוי",
  );
  assert(createLeadTool?.requiresConfirmation === false, "create_lead.requiresConfirmation ללא שינוי (false)");

  // ───────────────────────── 2. Object identity — אותו AgentTool בדיוק כמו Web ─────────────────────────
  logger.info("— object identity: tools.ts (WhatsApp) === AGENT_TOOLS (אותו registry ש-Web משתמש בו) —");

  assert(
    ADD_UPDATE_AGENT_TOOL === registryTool("add_update"),
    "tools.ts's ADD_UPDATE_AGENT_TOOL === AGENT_TOOLS.find('add_update') — אותו אובייקט, לא עותק",
  );
  assert(
    CREATE_LEAD_AGENT_TOOL === registryTool("create_lead"),
    "tools.ts's CREATE_LEAD_AGENT_TOOL === AGENT_TOOLS.find('create_lead') — אותו אובייקט, לא עותק",
  );
  // כבר מוכח ב-test-agent-tools.ts ש-ops/chat.ts's CREATE_LEAD_AGENT_TOOL/ADD_UPDATE_AGENT_TOOL
  // === AGENT_TOOLS.find(...) גם הם — ולכן, ע"פ טרנזיטיביות של ===, שלושתם (Web, WhatsApp,
  // registry) הם *פיזית אותו אובייקט אחד*, לא שלושה implementations דומים.
  assert(
    ADD_UPDATE_AGENT_TOOL.execute === registryTool("add_update").execute,
    "גם ה-execute function reference עצמו זהה (===) — לא רק המעטפת",
  );
  assert(
    CREATE_LEAD_AGENT_TOOL.execute === registryTool("create_lead").execute,
    "גם ה-execute function reference עצמו זהה (===) — לא רק המעטפת",
  );

  // ───────────────────────── 3. requireIdentifiedUser — פונקציה טהורה, בלי Monday ─────────────────────────
  logger.info("— requireIdentifiedUser: פונקציה טהורה —");

  assert(requireIdentifiedUser({ user: moti } as ToolContext) === moti, "requireIdentifiedUser מחזיר את המשתמש בלי שינוי");
  {
    let threw = false;
    try {
      requireIdentifiedUser({ user: null } as ToolContext);
    } catch (err) {
      threw = /חסר הקשר משתמש/.test((err as Error).message);
    }
    assert(threw, "requireIdentifiedUser({user:null}) זורק שגיאה ברורה, לא מתרסק/ממשיך בשקט");
  }

  // ───────────────────────── 4. Permission handling — אותה תוצאה בדיוק כמו לפני Step 3C ─────────────────────────
  // הוחלט במפורש (audit לאחר Step 3B: "אל תרחיב capability surface בשקט") *לא* להסיר את ה-gate
  // הבודד של add_monday_update — למרות ש-addUpdateToItem אוכפת ANY-of עשיר יותר (5 הרשאות)
  // כהגנה פנימית. Step 3C לא משנה את ההחלטה הזו — הוא רק מבטל את הכפילות המבנית: עכשיו יש מקום
  // יחיד (isToolAllowedForUser, tools.ts) שמחשב את ההרשאה, במקום שתי השוואות נפרדות (כאן +
  // orchestrator.ts's canUseTool הישן) שרק "קרה" להן להסכים.
  logger.info("— permissions: אותה תוצאה בדיוק כמו לפני Step 3C — אין הרחבת capability surface —");

  assert(
    addUpdateTool?.agentTool === ADD_UPDATE_AGENT_TOOL,
    "add_monday_update.agentTool === ADD_UPDATE_AGENT_TOOL — הקישור הגנרי לכלי המשותף קיים",
  );
  assert(
    addUpdateTool?.requiredPermission === "task:update_own",
    "add_monday_update: requiredPermission נשאר 'task:update_own' — צמצום מכוון של ANY-of ה-AgentTool, לא שונה",
  );
  assert(
    !!addUpdateTool?.agentTool?.requiredPermission.includes("task:update_own"),
    "add_monday_update: ה-צמצום הוא subset תקין של ANY-of ה-AgentTool (ולא הרשאה שהוא לא מכיר כלל)",
  );
  assert(
    createLeadTool?.agentTool === CREATE_LEAD_AGENT_TOOL,
    "create_lead.agentTool === CREATE_LEAD_AGENT_TOOL — הקישור הגנרי לכלי המשותף קיים",
  );
  assert(
    createLeadTool?.requiredPermission === undefined,
    "create_lead: אין יותר requiredPermission עצמאי כאן — מגיע במלואו מ-AgentTool.requiredPermission",
  );
  assert(
    deepEqual(createLeadTool?.agentTool?.requiredPermission, ["lead:manage"]),
    "create_lead: ה-ANY-of היחיד שחל הוא AGENT_TOOLS's create_lead.requiredPermission=['lead:manage'] — זהה למה שהיה כ-requiredPermission בודד לפני Step 3C",
  );

  // ───────────────────────── 4b. הוכחת structural delegation — לא רק 'קורה' להסכים ─────────────────────────
  // משנים את ה-ANY-of של AgentTool מדומה (לא נוגעים ב-AGENT_TOOLS האמיתי) ומוכיחים ש-
  // isToolAllowedForUser בפועל *קורא* ממנו, בשני הכיוונים (מרשה הרשאה חדשה / חוסם הרשאה שהוסרה) —
  // לא רק מקבל תוצאה שמתאימה כי מישהו שמר על שני מקורות מסונכרנים ביד.
  logger.info("— structural delegation: isToolAllowedForUser קורא בפועל מ-tool.agentTool, לא מקבילה מקרית —");

  {
    const fakeAgentTool: AgentTool = { ...CREATE_LEAD_AGENT_TOOL, requiredPermission: ["finance:manage"] };
    const fakeToolDef: ToolDefinition = { ...createLeadTool!, agentTool: fakeAgentTool, requiredPermission: undefined };
    assert(
      isToolAllowedForUser(fakeToolDef, goldi),
      "כשה-AgentTool המדומה מוחלף ל-ANY-of=['finance:manage'] — גולדי (יש לה finance:manage, אין lead:manage) מקבלת גישה: ההרשאה נקראת בזמן אמת מה-AgentTool, לא מ-cache/קבוע כפול",
    );
    assert(
      !isToolAllowedForUser(fakeToolDef, ruchama),
      "ואילו רוחמה (אין לה finance:manage) לא מקבלת גישה לאותו fakeToolDef — אותה קריאה חוזרת, תוצאה שונה לפי ANY-of בזמן אמת",
    );
  }
  {
    // אותה הוכחה על add_monday_update, כאן עם requiredPermission override קיים: מציגה שה-override
    // גובר על ה-AgentTool (בכוונה — זה הצמצום המכוון), ולא שה-AgentTool פשוט מתעלם ממנו.
    const fakeAgentTool: AgentTool = { ...ADD_UPDATE_AGENT_TOOL, requiredPermission: ["finance:manage"] };
    const fakeToolDefWithOverride: ToolDefinition = { ...addUpdateTool!, agentTool: fakeAgentTool };
    assert(
      !isToolAllowedForUser(fakeToolDefWithOverride, goldi),
      "עם requiredPermission='task:update_own' מוצהר, גולדי (finance:manage בלבד) *לא* מקבלת גישה גם אם ה-AgentTool המדומה כן מכיר finance:manage — ה-override מצמצם, לא רק ANY-of גולמי",
    );
  }

  // Regression guard: גולדי (finance:manage, *אין* task:update_own) — addUpdateToItem/AgentTool
  // *היו* מרשים לה (finance:manage הוא אחת מחמש ההרשאות התקינות שם), אבל ה-gate החיצוני ב-
  // tools.ts נשאר מכוון יותר בכוונה: היא לא רואה/לא מורשית להשתמש ב-add_monday_update דרך
  // WhatsApp — בדיוק כמו לפני ה-migration. אם בדיקה הזו תיכשל בעתיד (goldiTools כן מכיל את הכלי),
  // זה סימן שמישהו הרחיב את capability surface של WhatsApp בלי החלטה מפורשת — תפסיק ותבדוק.
  const goldiTools = toAnthropicTools(goldi).map((t) => t.name);
  assert(
    !goldiTools.includes("add_monday_update"),
    "גולדי (finance:manage, בלי task:update_own) לא רואה add_monday_update — ללא הרחבת capability surface לעומת לפני ה-migration",
  );
  assert(
    !goldiTools.includes("create_lead"),
    "גולדי לא רואה create_lead (אין lead:manage) — ה-gate הבודד הקיים ממשיך לעבוד נכון",
  );

  // מוטי (owner) — רואה את שניהם, כרגיל.
  const motiTools = toAnthropicTools(moti).map((t) => t.name);
  assert(motiTools.includes("add_monday_update") && motiTools.includes("create_lead"), "מוטי (owner) רואה את שניהם");

  // רוחמה (planner) — יש לה task:update_own (רואה add_monday_update), אין lead:manage (לא רואה create_lead).
  const ruchamaTools = toAnthropicTools(ruchama).map((t) => t.name);
  assert(ruchamaTools.includes("add_monday_update"), "רוחמה (task:update_own) רואה add_monday_update");
  assert(!ruchamaTools.includes("create_lead"), "רוחמה (אין lead:manage) לא רואה create_lead");

  // ───────────────────────── 6. mark_done/set_status (שלב 3D) — domain actions חדשים, לא legacy ─────────────────────────
  logger.info("— mark_done/set_status: domain actions אמיתיים מגובים ב-AgentTool, לא Monday primitive —");

  const markDoneTool = getTool("mark_done");
  const setStatusTool = getTool("set_status");
  assert(!!markDoneTool, "mark_done קיים ב-tools.ts (WhatsApp)");
  assert(!!setStatusTool, "set_status קיים ב-tools.ts (WhatsApp)");
  assert(
    MARK_DONE_AGENT_TOOL === registryTool("mark_done"),
    "tools.ts's MARK_DONE_AGENT_TOOL === AGENT_TOOLS.find('mark_done') — אותו אובייקט שגם Web משתמש בו",
  );
  assert(
    SET_STATUS_AGENT_TOOL === registryTool("set_status"),
    "tools.ts's SET_STATUS_AGENT_TOOL === AGENT_TOOLS.find('set_status') — אותו אובייקט שגם Web משתמש בו",
  );
  assert(
    MARK_DONE_AGENT_TOOL.execute === registryTool("mark_done").execute,
    "mark_done: execute function reference זהה (===) — לא רק המעטפת",
  );
  assert(
    SET_STATUS_AGENT_TOOL.execute === registryTool("set_status").execute,
    "set_status: execute function reference זהה (===) — לא רק המעטפת",
  );
  assert(
    deepEqual(markDoneTool?.input_schema, MARK_DONE_AGENT_TOOL.input_schema),
    "mark_done.input_schema ב-WhatsApp === ל-AgentTool.input_schema בדיוק (source of truth, לא הומצא schema חדש)",
  );
  assert(
    deepEqual(setStatusTool?.input_schema, SET_STATUS_AGENT_TOOL.input_schema),
    "set_status.input_schema ב-WhatsApp === ל-AgentTool.input_schema בדיוק",
  );
  assert(markDoneTool?.requiresConfirmation === false, "mark_done.requiresConfirmation === false");
  assert(setStatusTool?.requiresConfirmation === false, "set_status.requiresConfirmation === false");

  // ───────────────────────── 7. permissions (mark_done/set_status) — דרך agentTool, Step 3C ─────────────────────────
  logger.info("— mark_done/set_status: הרשאות מגיעות מה-AgentTool (Step 3C), אין gate שלישי —");

  assert(markDoneTool?.agentTool === MARK_DONE_AGENT_TOOL, "mark_done.agentTool === MARK_DONE_AGENT_TOOL");
  assert(setStatusTool?.agentTool === SET_STATUS_AGENT_TOOL, "set_status.agentTool === SET_STATUS_AGENT_TOOL");
  assert(
    markDoneTool?.requiredPermission === undefined,
    "mark_done: אין requiredPermission עצמאי — אין gate קיים לשמר (כלי חדש), מגיע במלואו מה-AgentTool",
  );
  assert(
    setStatusTool?.requiredPermission === undefined,
    "set_status: אין requiredPermission עצמאי, אותה סיבה",
  );
  assert(
    deepEqual(MARK_DONE_AGENT_TOOL.requiredPermission, ["task:update_own"]) &&
      deepEqual(SET_STATUS_AGENT_TOOL.requiredPermission, ["task:update_own"]),
    "שני ה-AgentTools מכריזים על task:update_own בלבד (סינגלטון) — ה-ANY-of היחיד שחל",
  );

  const goldiToolsAfter = toAnthropicTools(goldi).map((t) => t.name);
  assert(
    !goldiToolsAfter.includes("mark_done") && !goldiToolsAfter.includes("set_status"),
    "גולדי (אין task:update_own) לא רואה mark_done/set_status",
  );
  const motiToolsAfter = toAnthropicTools(moti).map((t) => t.name);
  assert(
    motiToolsAfter.includes("mark_done") && motiToolsAfter.includes("set_status"),
    "מוטי (owner) רואה את שני הכלים החדשים",
  );
  const ruchamaToolsAfter = toAnthropicTools(ruchama).map((t) => t.name);
  assert(
    ruchamaToolsAfter.includes("mark_done") && ruchamaToolsAfter.includes("set_status"),
    "רוחמה (task:update_own) רואה את שני הכלים החדשים",
  );

  // ───────────────────────── 8. mark_done/set_status מפעילים את authorize() האמיתי של ops/actions ─────────────────────────
  // לא מוקאים — doUpdateTask/doIsOwnItem בברירת המחדל הם הפונקציות האמיתיות (updateTask/isOwnItem,
  // ops/actions.ts). גולדי נדחית בשער ה-permission הראשון של authorize() (userCan(task:update_own))
  // — עוד לפני ownership/assertManagesItemProject. ה-ownership/project-scope המלא (isOwnItem →
  // task:manage → assertManagesItemProject) כבר מוכח ביסודיות ב-test-agent-tools.ts מול *אותם*
  // AgentTool objects בדיוק (סעיף 2/6 למעלה מוכיח === טרנזיטיבי) — לא כופלים את העומק כאן.
  logger.info("— mark_done/set_status (WhatsApp): authorize() האמיתי של ops/actions מופעל, לא מדומה —");

  {
    let threw = false;
    try {
      await markDoneTool!.execute({ itemId: "999999", source: "general" }, { user: goldi });
    } catch (err) {
      threw = /הרשאה/.test((err as Error).message);
    }
    assert(threw, "mark_done (WhatsApp): גולדי נדחית ע\"י authorize() האמיתי — בלי קריאת Monday בכלל");
  }
  {
    let threw = false;
    try {
      await setStatusTool!.execute({ itemId: "999999", source: "general", status: "x" }, { user: goldi });
    } catch (err) {
      threw = /הרשאה/.test((err as Error).message);
    }
    assert(threw, "set_status (WhatsApp): גולדי נדחית ע\"י authorize() האמיתי — בלי קריאת Monday בכלל");
  }
  {
    // requireIdentifiedUser חל גם כאן — ctx.user=null נדחה לפני שמגיעים ל-AgentTool בכלל.
    let threw = false;
    try {
      await markDoneTool!.execute({ itemId: "999999", source: "general" }, { user: null });
    } catch (err) {
      threw = /חסר הקשר משתמש/.test((err as Error).message);
    }
    assert(threw, "mark_done (WhatsApp): user=null נדחה ע\"י requireIdentifiedUser לפני כל Monday/AgentTool");
  }

  // ───────────────────────── 9. normalizeTaskSource — מיפוי כינויים, פונקציה טהורה, בלי Monday ─────────────────────────
  // "office"/"project" הם source values שחוזרים מ-list_my_work (ops/myWorkBrief.ts) — לא ערכים
  // חוקיים ל-AgentTool (general/project_stage). נבדק ישירות כפונקציה טהורה — לא דרך execute() —
  // כדי לא להפעיל isOwnItem/Monday אמיתי (גם moti, כבעלים, עובר דרך isOwnItem לפני ה-bypass).
  logger.info("— normalizeTaskSource: תרגום office/project → general/project_stage (פונקציה טהורה) —");
  assert(
    normalizeTaskSource({ itemId: "1", source: "office" }).source === "general",
    "normalizeTaskSource: 'office' → 'general'",
  );
  assert(
    normalizeTaskSource({ itemId: "1", source: "project" }).source === "project_stage",
    "normalizeTaskSource: 'project' → 'project_stage'",
  );
  assert(
    normalizeTaskSource({ itemId: "1", source: "general" }).source === "general",
    "normalizeTaskSource: 'general' (כבר תקין) נשאר ללא שינוי",
  );
  assert(
    normalizeTaskSource({ itemId: "1", source: "project_stage" }).source === "project_stage",
    "normalizeTaskSource: 'project_stage' (כבר תקין) נשאר ללא שינוי",
  );
  assert(
    normalizeTaskSource({ itemId: "1" }).source === undefined,
    "normalizeTaskSource: אין source בכלל → לא ממציא אחד, מחזיר כמו שהיה",
  );

  // ───────────────────────── 10. create_task (שלב 3E) — domain action חדש, לא legacy ─────────────────────────
  logger.info("— create_task: domain action אמיתי מגובה ב-AgentTool, לא Monday primitive —");

  const createTaskTool = getTool("create_task");
  assert(!!createTaskTool, "create_task קיים ב-tools.ts (WhatsApp)");
  assert(
    CREATE_TASK_AGENT_TOOL === registryTool("create_task"),
    "tools.ts's CREATE_TASK_AGENT_TOOL === AGENT_TOOLS.find('create_task') — אותו אובייקט שגם Web משתמש בו",
  );
  assert(
    CREATE_TASK_AGENT_TOOL.execute === registryTool("create_task").execute,
    "create_task: execute function reference זהה (===) — לא רק המעטפת",
  );
  assert(
    deepEqual(createTaskTool?.input_schema, CREATE_TASK_AGENT_TOOL.input_schema),
    "create_task.input_schema ב-WhatsApp === ל-AgentTool.input_schema בדיוק (source of truth, לא הומצא schema חדש)",
  );
  assert(createTaskTool?.requiresConfirmation === false, "create_task.requiresConfirmation === false");
  assert(createTaskTool?.agentTool === CREATE_TASK_AGENT_TOOL, "create_task.agentTool === CREATE_TASK_AGENT_TOOL");
  assert(
    createTaskTool?.requiredPermission === undefined,
    "create_task: אין requiredPermission עצמאי — אין gate קיים לשמר (כלי חדש), מגיע במלואו מה-AgentTool",
  );
  assert(
    deepEqual([...CREATE_TASK_AGENT_TOOL.requiredPermission].sort(), ["task:create", "task:manage"]),
    "create_task: ANY-of מוצהר = task:create/task:manage — זהה בתוצאה ל-canCreateTask(user) ב-chat.ts",
  );

  // permission matrix — זהה לכל תפקיד קיים (task:manage⊇task:create ב-roles.ts לכל תפקיד שיש לו
  // את הראשון, אז ANY-of לא משנה כלום בפועל מול gate בודד "task:create" שהיה קיים ב-
  // create_monday_task — ר' audit נפרד).
  const goldiCreateTools = toAnthropicTools(goldi).map((t) => t.name);
  assert(!goldiCreateTools.includes("create_task"), "גולדי (אין task:create/task:manage) לא רואה create_task");
  const motiCreateTools = toAnthropicTools(moti).map((t) => t.name);
  assert(motiCreateTools.includes("create_task"), "מוטי (owner) רואה create_task");
  const ruchamaCreateTools = toAnthropicTools(ruchama).map((t) => t.name);
  assert(ruchamaCreateTools.includes("create_task"), "רוחמה (task:create) רואה create_task");

  // authorize() האמיתי של createTaskAction (ops/actions.ts) מופעל, לא מדומה — גולדי נדחית בשער
  // ה-permission של tools.ts/isToolAllowedForUser עוד לפני שמגיעים ל-execute בכלל (toAnthropicTools
  // כבר הראה זאת למעלה); user=null נדחה ע"י requireIdentifiedUser לפני כל Monday/AgentTool.
  {
    let threw = false;
    try {
      await createTaskTool!.execute({ taskName: "בדיקה" }, { user: null });
    } catch (err) {
      threw = /חסר הקשר משתמש/.test((err as Error).message);
    }
    assert(threw, "create_task (WhatsApp): user=null נדחה ע\"י requireIdentifiedUser לפני כל Monday/AgentTool");
  }

  // ───────────────────────── 11. update_monday_task_status / create_monday_task — legacy fallbacks, ללא שום שינוי ─────────────────────────
  logger.info("— update_monday_task_status / create_monday_task: legacy fallbacks — snapshot ללא שינוי —");

  const legacyStatusTool = getTool("update_monday_task_status");
  assert(!!legacyStatusTool, "update_monday_task_status עדיין קיים ב-tools.ts");
  assert(legacyStatusTool?.agentTool === undefined, "update_monday_task_status: אין agentTool — נשאר Monday primitive עצמאי, לא חובר ל-registry");
  assert(legacyStatusTool?.requiredPermission === "task:update_own", "update_monday_task_status: requiredPermission ללא שינוי");
  assert(legacyStatusTool?.requiresConfirmation === false, "update_monday_task_status: requiresConfirmation ללא שינוי (false)");
  assert(
    deepEqual(legacyStatusTool?.input_schema, {
      type: "object",
      properties: {
        boardId: { type: "string", description: "מזהה הלוח" },
        itemId: { type: "string", description: "מזהה המשימה" },
        statusLabel: { type: "string", description: "שם הסטטוס החדש (חייב להתאים לאחת האפשרויות הקיימות בלוח)" },
      },
      required: ["boardId", "itemId", "statusLabel"],
    }),
    "update_monday_task_status.input_schema זהה בדיוק למה שהיה לפני Step 3D (boardId+itemId+statusLabel)",
  );
  assert(
    legacyStatusTool!.execute.toString().includes("updateTaskStatus"),
    "update_monday_task_status.execute עדיין קורא ל-updateTaskStatus (monday/tasks.ts) ישירות — לא עבר ל-AgentTool",
  );

  const legacyCreateTool = getTool("create_monday_task");
  assert(!!legacyCreateTool, "create_monday_task עדיין קיים ב-tools.ts");
  assert(legacyCreateTool?.agentTool === undefined, "create_monday_task: אין agentTool — נשאר Monday primitive עצמאי, לא חובר ל-registry");
  assert(legacyCreateTool?.requiredPermission === "task:create", "create_monday_task: requiredPermission ללא שינוי");
  assert(legacyCreateTool?.requiresConfirmation === false, "create_monday_task: requiresConfirmation ללא שינוי (false)");
  assert(
    deepEqual(legacyCreateTool?.input_schema, {
      type: "object",
      properties: {
        boardId: { type: "string", description: "מזהה הלוח שאליו להוסיף את המשימה" },
        itemName: { type: "string", description: "שם המשימה" },
      },
      required: ["boardId", "itemName"],
    }),
    "create_monday_task.input_schema זהה בדיוק למה שהיה לפני Step 3E (boardId+itemName)",
  );
  assert(
    legacyCreateTool!.execute.toString().includes("createTask"),
    "create_monday_task.execute עדיין קורא ל-createTask (monday/tasks.ts) ישירות — לא עבר ל-AgentTool",
  );

  // ───────────────────────── 12. אין direct Monday write בתוך mark_done/set_status/create_task (WhatsApp) ─────────────────────────
  logger.info("— mark_done/set_status/create_task (WhatsApp): אין Monday write ישיר בתוך ה-adapter עצמו —");
  for (const [name, tool] of [
    ["mark_done", markDoneTool],
    ["set_status", setStatusTool],
    ["create_task", createTaskTool],
  ] as const) {
    const src = tool!.execute.toString();
    assert(
      !src.includes("updateTaskStatus") &&
        !src.includes("createTask(") &&
        !src.includes("mondayRequest") &&
        !src.includes("mondayClient"),
      `${name} (WhatsApp adapter): אין הפניה ישירה ל-Monday write functions — רק AgentTool.execute (ops/actions.ts)`,
    );
  }

  // ───────────────────────── 13. ספירת כלים — 17 ישנים + 3 חדשים = 20 ─────────────────────────
  logger.info("— whatsappTools array: 17 ישנים + 3 חדשים —");
  const OLD_17_TOOL_NAMES = [
    "list_monday_boards",
    "find_monday_board",
    "list_monday_tasks",
    "list_my_work",
    "create_monday_task",
    "update_monday_task_status",
    "set_monday_task_due_date",
    "delete_monday_task",
    "find_monday_user",
    "assign_monday_task",
    "add_monday_update",
    "create_lead",
    "list_calendar_events",
    "create_calendar_event",
    "update_calendar_event",
    "delete_calendar_event",
    "send_meeting_summary_email",
  ];
  const currentNames = whatsappTools.map((t) => t.name);
  const missingOld = OLD_17_TOOL_NAMES.filter((n) => !currentNames.includes(n));
  assert(missingOld.length === 0, `כל 17 הכלים הישנים עדיין קיימים (חסרים: ${missingOld.join(",") || "none"})`);
  assert(
    currentNames.includes("mark_done") && currentNames.includes("set_status") && currentNames.includes("create_task"),
    "שלושת הכלים החדשים (mark_done/set_status/create_task) נוכחים",
  );
  assert(
    whatsappTools.length === 20,
    `מספר הכלים הכולל ב-WhatsApp === 20 (17 ישנים + mark_done + set_status + create_task), בפועל ${whatsappTools.length}`,
  );

  if (failures > 0) {
    logger.error(`\n${failures} בדיקות נכשלו ❌`);
    process.exit(1);
  }
  logger.info("\nכל בדיקות ה-whatsapp-agent-tools עברו ✅");
}

main().catch((err) => {
  logger.error(err, "כשל לא צפוי בהרצת הבדיקות");
  process.exit(1);
});
