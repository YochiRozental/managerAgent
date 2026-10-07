/**
 * Step 3F.3 (2026-10-07) — proves Web's create_lead now genuinely consumes the shared
 * ToolDefinition infrastructure (src/ai/toolRegistry.ts) that WhatsApp has used since Step 3C,
 * with zero behavior change, and that nothing else (the other 8 AgentTool-backed Web tools,
 * Web-local tools, WhatsApp's 20-tool registry) was touched.
 *
 * Does NOT call any live AI model — Anthropic credit is currently insufficient. All checks are
 * structural: object identity, schema equality, permission-decision equality across the real
 * role matrix, and source-level proof of the actions.push/no-refresh side effect (runOpsChat's
 * tool-building closure isn't independently invokable without live Monday/AI, so this is read
 * from the actual source text rather than executed — documented explicitly below).
 *
 *   npm run test:web-shared-tool-definition
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CREATE_LEAD_AGENT_TOOL as WEB_CREATE_LEAD_AGENT_TOOL,
  CREATE_LEAD_TOOL_DEFINITION,
  CREATE_TASK_AGENT_TOOL,
  MARK_DONE_AGENT_TOOL,
  SET_STATUS_AGENT_TOOL,
  ADD_NOTE_AGENT_TOOL,
  REPORT_BLOCKER_AGENT_TOOL,
  ADD_UPDATE_AGENT_TOOL,
  CREATE_PROJECT_STAGE_AGENT_TOOL,
  REASSIGN_ITEM_AGENT_TOOL,
  WIRED_AGENT_TOOL_NAMES,
  WEB_CHAT_LOCAL_TOOL_NAMES,
  canCreateLead,
} from "../src/ops/chat.js";
import { AGENT_TOOLS } from "../src/ops/agentTools.js";
import {
  isToolAllowedForUser,
  type ToolDefinition,
} from "../src/ai/toolRegistry.js";
import {
  tools as whatsappTools,
  getTool as getWhatsappTool,
  CREATE_LEAD_AGENT_TOOL as WHATSAPP_CREATE_LEAD_AGENT_TOOL,
} from "../src/integrations/claude/tools.js";
import { resolveUserByKey, type IdentifiedUser } from "../src/identity/index.js";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const chatSource = readFileSync(join(__dirname, "..", "src", "ops", "chat.ts"), "utf-8");

const moti = resolveUserByKey("moti")!; // owner
const dov = resolveUserByKey("dov")!; // project_manager — lead:manage
const ruchama = resolveUserByKey("ruchama")!; // planner — no lead:manage
const goldi = resolveUserByKey("goldi")!; // finance — no lead:manage
const yochi = resolveUserByKey("yochi")!; // admin

async function main() {
  // ───────────────────────── 1+2. Web create_lead הוא ToolDefinition אמיתי, AgentTool backing זהה ─────────────────────────
  logger.info("— Web's create_lead: ToolDefinition אמיתי, אותו AgentTool backing בכל השלושה (Web/WhatsApp/registry) —");

  const registryCreateLead = AGENT_TOOLS.find((t) => t.name === "create_lead")!;
  assert(WEB_CREATE_LEAD_AGENT_TOOL === registryCreateLead, "chat.ts's CREATE_LEAD_AGENT_TOOL === AGENT_TOOLS.find('create_lead')");
  assert(WHATSAPP_CREATE_LEAD_AGENT_TOOL === registryCreateLead, "tools.ts's CREATE_LEAD_AGENT_TOOL === AGENT_TOOLS.find('create_lead')");
  assert(
    CREATE_LEAD_TOOL_DEFINITION.agentTool === registryCreateLead,
    "CREATE_LEAD_TOOL_DEFINITION.agentTool === AGENT_TOOLS.find('create_lead') — אותו אובייקט, לא עותק",
  );
  assert(
    CREATE_LEAD_TOOL_DEFINITION.requiresConfirmation === false,
    "CREATE_LEAD_TOOL_DEFINITION.requiresConfirmation === false",
  );
  assert(
    CREATE_LEAD_TOOL_DEFINITION.requiredPermission === undefined,
    "CREATE_LEAD_TOOL_DEFINITION: אין requiredPermission עצמאי — מגיע במלואו מה-AgentTool (בדיוק כמו WhatsApp's create_lead, Step 3C)",
  );

  // ───────────────────────── 4. schema זהה לפני/אחרי ─────────────────────────
  // הערה: Web ו-WhatsApp מציגים למודל *schemas שונים במכוון* לכלי הזה, מאז שלב 3B — WhatsApp
  // חושף 7 שדות (בלי assignee, כדי לשמר את ה-contract שה-WhatsApp model הכיר לפני המעבר),
  // Web חושף את כל 8 שדות ה-AgentTool (כולל assignee) — וזה *לא* השתנה ב-3F.3. ה-"schema זהה
  // לפני/אחרי" הנדרש כאן הוא זהות ה-Web schema לעצמו (לפני/אחרי 3F.3), לא זהות בין הערוצים.
  logger.info("— schema: Web זהה למה שהיה קודם (8 שדות, כולל assignee) — לא השתנה ב-3F.3 —");
  const whatsappCreateLead = getWhatsappTool("create_lead")!;
  assert(
    CREATE_LEAD_TOOL_DEFINITION.input_schema === WEB_CREATE_LEAD_AGENT_TOOL.input_schema,
    "CREATE_LEAD_TOOL_DEFINITION.input_schema === CREATE_LEAD_AGENT_TOOL.input_schema (לא שונה, לא עותק) — זה גם מה ש-Web חשף לפני 3F.3",
  );
  const propNames = Object.keys(
    (CREATE_LEAD_TOOL_DEFINITION.input_schema as { properties: Record<string, unknown> }).properties,
  ).sort();
  assert(
    propNames.join(",") === "assignee,email,firstName,lastName,phone,product,referredBy,source",
    "Web schema: 8 שדות (כולל assignee) — זהה למה ש-Web חשף גם לפני 3F.3 (לא הוחלף ב-schema הצר של WhatsApp)",
  );
  const whatsappPropNames = Object.keys(
    (whatsappCreateLead.input_schema as { properties: Record<string, unknown> }).properties,
  ).sort();
  assert(
    whatsappPropNames.join(",") === "email,firstName,lastName,phone,product,referredBy,source",
    "WhatsApp schema: עדיין 7 שדות (בלי assignee) — ה-contract המכוון משלב 3B לא השתנה ב-3F.3",
  );

  // ───────────────────────── 3. permission decision — זהה ל-WhatsApp ול-canCreateLead הישן, לכל role ─────────────────────────
  logger.info("— permission decision: isToolAllowedForUser(Web) === isToolAllowedForUser(WhatsApp) === canCreateLead הישן, לכל role —");
  for (const user of [moti, dov, ruchama, goldi, yochi]) {
    const webDecision = isToolAllowedForUser(CREATE_LEAD_TOOL_DEFINITION, user);
    const whatsappDecision = isToolAllowedForUser(whatsappCreateLead, user);
    const oldGateDecision = canCreateLead(user);
    assert(
      webDecision === whatsappDecision && webDecision === oldGateDecision,
      `create_lead permission עבור ${user.key}: Web===WhatsApp===canCreateLead הישן (${webDecision})`,
    );
  }
  assert(
    isToolAllowedForUser(CREATE_LEAD_TOOL_DEFINITION, null) === false,
    "create_lead (Web): null user → false, בדיוק כמו WhatsApp",
  );

  // ───────────────────────── 5. execution מגיע לאותו AgentTool.execute (דרך requireIdentifiedUser) ─────────────────────────
  logger.info("— execution: CREATE_LEAD_TOOL_DEFINITION.execute עובר דרך requireIdentifiedUser, לא מריץ Monday על null —");
  {
    let threw = false;
    try {
      await CREATE_LEAD_TOOL_DEFINITION.execute({ firstName: "בדיקה" }, { user: null });
    } catch (err) {
      threw = /חסר הקשר משתמש/.test((err as Error).message);
    }
    assert(threw, "CREATE_LEAD_TOOL_DEFINITION.execute({user:null}) נדחה ע\"י requireIdentifiedUser — לא מגיע ל-Monday");
  }
  assert(
    CREATE_LEAD_TOOL_DEFINITION.execute.toString().includes("CREATE_LEAD_AGENT_TOOL.execute"),
    "CREATE_LEAD_TOOL_DEFINITION.execute מפנה ל-CREATE_LEAD_AGENT_TOOL.execute (מקור, לא Monday ישירות)",
  );
  assert(
    !CREATE_LEAD_TOOL_DEFINITION.execute.toString().includes("createLead(") &&
      !CREATE_LEAD_TOOL_DEFINITION.execute.toString().includes("mondayRequest"),
    "CREATE_LEAD_TOOL_DEFINITION.execute: אין הפניה ישירה ל-Monday write functions",
  );

  // ───────────────────────── 6+7. actions.push נשמר, אין refresh() — הוכחה ממקור הקוד ─────────────────────────
  // runOpsChat's tool-building closure אינו ניתן להרצה עצמאית בלי Monday/AI חיים — ההוכחה היחידה
  // הבטוחה כרגע היא קריאת המקור עצמו (לא live run). ר' docstring בראש הקובץ.
  logger.info("— actions.push/no-refresh (הוכחה ממקור הקוד, לא הרצה חיה — ר' מגבלת credit) —");
  const createLeadBlockMatch = chatSource.match(
    /isToolAllowedForUser\(CREATE_LEAD_TOOL_DEFINITION, user\)\) \{[\s\S]*?\n {2}\}\n/,
  );
  assert(!!createLeadBlockMatch, "נמצא בלוק ה-create_lead ב-chat.ts (isToolAllowedForUser gate)");
  const block = createLeadBlockMatch?.[0] ?? "";
  assert(block.includes("actions.push"), "בלוק create_lead ב-chat.ts כולל actions.push — תופעת הלוואי נשמרה");
  assert(!block.includes("refresh()"), "בלוק create_lead ב-chat.ts לא כולל refresh() — נשמר כמו שהיה (ללא refresh)");
  assert(block.includes("CREATE_LEAD_TOOL_DEFINITION.execute"), "בלוק create_lead קורא ל-CREATE_LEAD_TOOL_DEFINITION.execute (לא ל-AgentTool ישירות)");

  // ───────────────────────── 8. שאר 8 ה-AgentTools של Web — ללא שינוי ─────────────────────────
  logger.info("— שאר 8 ה-AgentTools המחוברים ל-Web — עדיין AgentTool גולמי, לא הומרו ל-ToolDefinition —");
  const otherEight: [string, unknown][] = [
    ["create_task", CREATE_TASK_AGENT_TOOL],
    ["mark_done", MARK_DONE_AGENT_TOOL],
    ["set_status", SET_STATUS_AGENT_TOOL],
    ["add_note", ADD_NOTE_AGENT_TOOL],
    ["report_blocker", REPORT_BLOCKER_AGENT_TOOL],
    ["add_update", ADD_UPDATE_AGENT_TOOL],
    ["create_project_stage", CREATE_PROJECT_STAGE_AGENT_TOOL],
    ["reassign_item", REASSIGN_ITEM_AGENT_TOOL],
  ];
  for (const [name, tool] of otherEight) {
    const t = tool as { name: string; requiredPermission: unknown; execute: unknown };
    assert(t.name === name, `${name}: עדיין AgentTool גולמי (יש .name, לא ToolDefinition עטוף)`);
    assert(
      !("requiresConfirmation" in (t as object)) && !("agentTool" in (t as object)),
      `${name}: לא הפך ל-ToolDefinition (אין requiresConfirmation/agentTool על האובייקט עצמו) — AgentTool גולמי כמו קודם`,
    );
  }
  assert(
    deepEqual(
      [...WIRED_AGENT_TOOL_NAMES].sort(),
      [
        "add_note",
        "add_update",
        "create_lead",
        "create_project_stage",
        "create_task",
        "mark_done",
        "reassign_item",
        "report_blocker",
        "set_status",
      ].sort(),
    ),
    "WIRED_AGENT_TOOL_NAMES: עדיין בדיוק 9 הכלים (כולל create_lead) — לא נוסף/הוסר אחד",
  );

  // ───────────────────────── 9. Web-local tools — ללא שינוי ─────────────────────────
  logger.info("— WEB_CHAT_LOCAL_TOOL_NAMES — ללא שינוי —");
  assert(
    deepEqual(
      [...WEB_CHAT_LOCAL_TOOL_NAMES].sort(),
      [
        "get_today_tasks",
        "find_task",
        "record_commitment",
        "list_my_commitments",
        "close_commitment",
        "reply_done",
        "reply_progress",
        "reply_finishing_today",
        "reply_defer",
        "reply_waiting",
        "reply_blocked",
        "reply_await_manager",
        "reply_not_relevant",
        "office_overview",
        "person_status",
        "project_status",
        "list_findings",
        "sales_and_collection",
        "find_lead_or_deal",
      ].sort(),
    ),
    "WEB_CHAT_LOCAL_TOOL_NAMES: עדיין בדיוק 19 הכלים המקומיים, ללא שינוי",
  );

  // ───────────────────────── 10. WhatsApp's 20-tool registry — ללא שינוי ─────────────────────────
  logger.info("— WhatsApp: 20 כלים, create_lead עדיין מחובר נכון —");
  assert(whatsappTools.length === 20, `WhatsApp tools array === 20, בפועל ${whatsappTools.length}`);
  assert(
    whatsappCreateLead.agentTool === registryCreateLead,
    "WhatsApp's create_lead: agentTool עדיין === ל-registry — 3F.3 לא נגע בקובץ tools.ts's כלים",
  );
  assert(
    whatsappCreateLead.requiredPermission === undefined,
    "WhatsApp's create_lead: עדיין אין requiredPermission עצמאי (Step 3C) — לא השתנה ב-3F.3",
  );

  if (failures > 0) {
    logger.error(`\n${failures} בדיקות נכשלו ❌`);
    process.exit(1);
  }
  logger.info("\nכל בדיקות ה-web-shared-tool-definition עברו ✅");
}

main().catch((err) => {
  logger.error(err, "כשל לא צפוי בהרצת הבדיקות");
  process.exit(1);
});
