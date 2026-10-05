/**
 * בדיקת חיבור add_monday_update/create_lead (WhatsApp, integrations/claude/tools.ts) ל-AgentTools
 * המשותפים (שלב 3B, תוכנית איחוד Web/WhatsApp, 2026-10-05).
 *
 * מוודאת:
 *  1. שני הכלים עדיין קיימים ב-tools.ts בשם/schema שה-WhatsApp model כבר מכיר — ללא שינוי.
 *  2. ADD_UPDATE_AGENT_TOOL/CREATE_LEAD_AGENT_TOOL (המיובאים ב-tools.ts בפועל) הם === האובייקטים
 *     ב-AGENT_TOOLS — **אותו אובייקט בזיכרון שגם ops/chat.ts (Web) משתמש בו**, לא עותק. זו ההוכחה
 *     המרכזית ל"לא ממומש מחדש ב-WhatsApp" — לא רק "קורא לפונקציה דומה".
 *  3. requireIdentifiedUser (הלוגיקה החדשה היחידה שנכתבה ב-tools.ts) מתנהגת נכון כפונקציה טהורה.
 *  4. permission handling: add_monday_update נשאר עם requiredPermission="task:update_own" —
 *     **אותו gate בדיוק כמו לפני Step 3B**, במפורש כדי לא להרחיב capability surface של WhatsApp
 *     כצד-תוצאה שקטה של ה-migration (הוחלט בביקורת נפרדת לאחר implementation ראשוני, ר'
 *     commit history). addUpdateToItem עדיין אוכפת ANY-of עשיר יותר (5 הרשאות) — כהגנה פנימית
 *     משותפת, לא כתחליף ל-gate החיצוני. create_lead ממשיך עם gate בודד זהה (lead:manage), כי
 *     זה תואם 1:1 ל-AgentTool.requiredPermission שלו ולא היה בו שום אי-התאמה מהתחלה.
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
  requireIdentifiedUser,
  ADD_UPDATE_AGENT_TOOL,
  CREATE_LEAD_AGENT_TOOL,
  type ToolContext,
} from "../src/integrations/claude/tools.js";
import { AGENT_TOOLS } from "../src/ops/agentTools.js";
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

  // ───────────────────────── 4. Permission handling — אותו gate בדיוק כמו לפני המעבר ─────────────────────────
  // הוחלט במפורש (audit לאחר Step 3B: "אל תרחיב capability surface בשקט") *לא* להסיר את ה-gate
  // הבודד הקיים — למרות ש-addUpdateToItem אוכפת ANY-of עשיר יותר (5 הרשאות) כהגנה פנימית. שני
  // ה-gates האלה מכוונים: tools.ts's gate = exposure+execution-time pre-check ב-orchestrator.ts
  // (לא שונה ממה שהיה), addUpdateToItem's gate = ה-business authorization הסופי (משותף, לא נוגע).
  logger.info("— permissions: אותו gate חיצוני כמו לפני Step 3B — אין הרחבת capability surface —");

  assert(
    addUpdateTool?.requiredPermission === "task:update_own",
    "add_monday_update: requiredPermission נשאר 'task:update_own' — אותו gate בדיוק כמו לפני המעבר ל-shared AgentTool",
  );
  assert(
    createLeadTool?.requiredPermission === "lead:manage",
    "create_lead: requiredPermission='lead:manage' תואם 1:1 ל-AGENT_TOOLS's create_lead.requiredPermission=['lead:manage']",
  );

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
