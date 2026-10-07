/**
 * בדיקת חיבור add_monday_update/create_lead (WhatsApp, integrations/claude/tools.ts) ל-AgentTools
 * המשותפים (שלב 3B, 2026-10-05) + ביטול כפילות בדיקת ההרשאות (שלב 3C, 2026-10-07).
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

function main() {
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

  // ───────────────────────── 5. אין שום implementation כפול שנשאר בשימוש ─────────────────────────
  logger.info("— whatsappTools array עקבי —");
  assert(whatsappTools.length === 17, "מספר הכלים הכולל ב-WhatsApp נשאר 17 (לא נוסף/הוסר כלי)");

  if (failures > 0) {
    logger.error(`\n${failures} בדיקות נכשלו ❌`);
    process.exit(1);
  }
  logger.info("\nכל בדיקות ה-whatsapp-agent-tools עברו ✅");
}

main();
