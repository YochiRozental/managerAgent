/**
 * Step 3F.3 (2026-10-07) — proves Web's create_lead consumes the shared ToolDefinition
 * infrastructure (src/ai/toolRegistry.ts) that WhatsApp has used since Step 3C, with zero
 * behavior change, and that nothing else (the other 8 AgentTool-backed Web tools, Web-local
 * tools, WhatsApp's 20-tool registry) was touched.
 *
 * Extended Step 3F.4 (2026-10-07): create_lead's temporary run() wrapper is gone — it's pushed
 * into Web's tools array as a bare ToolDefinition now, executed by runOpsChat's dual-path
 * dispatcher (executeToolCall's isSharedToolDefinition branch), which also adds the execution-
 * time isToolAllowedForUser re-check (defense-in-depth, matching WhatsApp's canUseTool) and the
 * actions.push UI effect via SHARED_TOOL_UI_EFFECT — a Web-only adapter table, not business logic
 * inside the shared ToolDefinition.
 *
 * Extended Step 3F.5A (2026-10-07): create_task converted the same way — the second proof case,
 * because unlike create_lead it also has refresh(). SHARED_TOOL_UI_EFFECT generalized from a
 * plain formatter function to {message, refresh?} so the dispatcher can run refresh() after
 * actions.push, only on success, without that being business logic inside the shared
 * ToolDefinition. Now only 7 of Web's 9 AgentTool-backed tools remain in the legacy run() shape.
 *
 * Does NOT call any live AI model — Anthropic credit is currently insufficient. All checks are
 * structural: object identity, schema equality, permission-decision equality across the real
 * role matrix, and source-level proof of the dispatcher's branching/actions.push/refresh
 * behavior (runOpsChat's executeToolCall closure isn't independently invokable without live
 * Monday/AI, so this is read from the actual source text rather than executed — documented
 * explicitly at each such check below).
 *
 *   npm run test:web-shared-tool-definition
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CREATE_LEAD_AGENT_TOOL as WEB_CREATE_LEAD_AGENT_TOOL,
  CREATE_LEAD_TOOL_DEFINITION,
  CREATE_TASK_AGENT_TOOL as WEB_CREATE_TASK_AGENT_TOOL,
  CREATE_TASK_TOOL_DEFINITION,
  MARK_DONE_AGENT_TOOL,
  MARK_DONE_TOOL_DEFINITION,
  SET_STATUS_AGENT_TOOL,
  SET_STATUS_TOOL_DEFINITION,
  ADD_NOTE_AGENT_TOOL,
  ADD_NOTE_TOOL_DEFINITION,
  REPORT_BLOCKER_AGENT_TOOL,
  REPORT_BLOCKER_TOOL_DEFINITION,
  ADD_UPDATE_AGENT_TOOL,
  ADD_UPDATE_TOOL_DEFINITION,
  CREATE_PROJECT_STAGE_AGENT_TOOL,
  CREATE_PROJECT_STAGE_TOOL_DEFINITION,
  REASSIGN_ITEM_AGENT_TOOL,
  REASSIGN_ITEM_TOOL_DEFINITION,
  WIRED_AGENT_TOOL_NAMES,
  WEB_CHAT_LOCAL_TOOL_NAMES,
  canCreateLead,
  canCreateTask,
  canManageProjectStages,
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
import { resolveUserByKey, userCan, type IdentifiedUser } from "../src/identity/index.js";
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

  // ───────────────────────── 1'. שלב 3F.4: create_lead נדחף כ-ToolDefinition גולמי, בלי run() wrapper ─────────────────────────
  logger.info("— שלב 3F.4: create_lead נדחף ישירות (tools.push(CREATE_LEAD_TOOL_DEFINITION)), אין יותר run() wrapper —");
  const pushSiteMatch = chatSource.match(/isToolAllowedForUser\(CREATE_LEAD_TOOL_DEFINITION, user\)\) \{[\s\S]*?\n {2}\}\n/);
  assert(!!pushSiteMatch, "נמצא בלוק ה-gate של create_lead ב-chat.ts");
  const pushSite = pushSiteMatch?.[0] ?? "";
  assert(
    /tools\.push\(CREATE_LEAD_TOOL_DEFINITION\)/.test(pushSite),
    "create_lead נדחף כאובייקט גולמי — tools.push(CREATE_LEAD_TOOL_DEFINITION), לא tools.push({name,...,run:...})",
  );
  assert(!pushSite.includes("run:"), "בלוק ה-push של create_lead לא מכיל יותר run: wrapper כלל");
  assert(!pushSite.includes("actions.push"), "actions.push עבר מהבלוק המקומי ל-dispatcher המשותף (executeToolCall) — לא נשאר כאן");

  // ───────────────────────── 6+7. actions.push/refresh — עברו ל-dispatchToolDefinition המשותף (Central Agent Core) ─────────────────────────
  // Central Agent Core unification (2026-10-07): executeToolCall ב-chat.ts כבר לא מכיל בעצמו
  // isToolAllowedForUser/tool.execute/טקסט דחיית-הרשאה — אלה עברו ל-src/ai/dispatcher.ts's
  // dispatchToolDefinition, הנבדק *ישירות* (לא רק ממקור) ב-test-shared-dispatcher.ts. מה שנשאר
  // ב-chat.ts כאן הוא רק: ה-branch בין ToolDefinition משותף ל-Web-local tool.run, וה-hooks
  // (actions.push/refresh/logging) שה-dispatcher המשותף קורא להם — זה מה שנבדק ממקור הקובץ.
  logger.info("— executeToolCall (chat.ts): כלי משותף עובר דרך dispatchToolDefinition, hooks ה-UI נשמרים —");
  const dispatcherMatch = chatSource.match(/executeToolCall: async \(call: NormToolCall\) => \{[\s\S]*?\n {6}\},\n/);
  assert(!!dispatcherMatch, "נמצא executeToolCall ב-chat.ts");
  const dispatcher = dispatcherMatch?.[0] ?? "";
  assert(dispatcher.includes("isSharedToolDefinition(tool)"), "ה-dispatcher מבדיל בין ToolDefinition משותף ל-Web-local ישן");
  assert(
    dispatcher.includes("dispatchToolDefinition(tool, input, { user }"),
    "כלי משותף מורץ דרך dispatchToolDefinition — אותו דיספצ'ר ש-WhatsApp's orchestrator.ts גם קורא לו",
  );
  assert(dispatcher.includes("tool.run(input)"), "ה-branch השני (Web-local tools) עדיין קורא ל-tool.run(input), בלי שינוי");
  assert(
    !dispatcher.includes("isToolAllowedForUser(tool, user)") && !dispatcher.includes("await tool.execute(input, { user })"),
    "chat.ts עצמו לא מבצע יותר permission-check/execute על כלי משותף ישירות — זה עבר ל-dispatcher המשותף (לא עוד implementation כפול)",
  );
  assert(dispatcher.includes("SHARED_TOOL_UI_EFFECT"), "ה-onExecuted hook מפעיל את SHARED_TOOL_UI_EFFECT (actions.push ל-UI) אחרי execute משותף");
  assert(
    dispatcher.indexOf("actions.push(uiEffect.message(") < dispatcher.indexOf("if (uiEffect.refresh) await refresh();"),
    "בתוך ה-onExecuted hook: actions.push(uiEffect.message) קודם, uiEffect.refresh אחריו — אותו סדר שהיה",
  );

  // ───────────────────────── 3+4. בדיקת הרשאה בזמן הרצה — קיימת (בתוך הדיספצ'ר המשותף), ודוחה נכון ─────────────────────────
  logger.info("— execution-time permission re-check: isToolAllowedForUser בזמן אמת (לא רק build-time) —");
  assert(
    !isToolAllowedForUser(CREATE_LEAD_TOOL_DEFINITION, goldi),
    "אם ה-dispatcher היה מבצע re-check על גולדי (אין lead:manage) — הוא היה דוחה: isToolAllowedForUser מחזיר false",
  );
  assert(
    isToolAllowedForUser(CREATE_LEAD_TOOL_DEFINITION, moti),
    "ולמוטי (lead:manage) — isToolAllowedForUser מחזיר true, ה-dispatcher היה ממשיך ל-execute",
  );
  assert(
    CREATE_LEAD_TOOL_DEFINITION.enforceExecutionTimePermission === undefined,
    "CREATE_LEAD_TOOL_DEFINITION: enforceExecutionTimePermission לא מוגדר ⇒ ברירת המחדל true חלה (ללא שינוי התנהגות)",
  );

  // ───────────────────────── 8. Web-local tools ממשיכים לרוץ דרך run(input), ללא שינוי ─────────────────────────
  // ה-branch השני (tool.run(input)) הוא מילה-במילה הקוד הישן — שום permission re-check/UI-effect
  // לא נוסף לו. ה-if-branch (isSharedToolDefinition) הוא היחיד שמאציל ל-dispatcher המשותף.
  logger.info("— Web-local tools: ה-branch השני (tool.run(input)) זהה לקוד הישן, בלי re-check/UI-effect חדשים —");
  const legacyBranchStart = dispatcher.indexOf("const before = actions.length;");
  assert(legacyBranchStart > -1, "נמצא תחילת ה-branch של Web-local tools (const before = actions.length;)");
  const legacyBranch = dispatcher.slice(legacyBranchStart);
  assert(legacyBranch.includes("tool.run(input)"), "ה-branch של Web-local tools קורא ל-tool.run(input) — ללא שינוי");
  assert(
    !legacyBranch.includes("isToolAllowedForUser") && !legacyBranch.includes("SHARED_TOOL_UI_EFFECT"),
    "ה-branch של Web-local tools לא מכיל permission re-check או UI-effect — אלה רק בכלים המשותפים",
  );

  // ═══════════════════════════ Step 3F.5A: create_task ═══════════════════════════

  // ───────────────────────── create_task: ToolDefinition אמיתי, אותו AgentTool backing ─────────────────────────
  logger.info("— Web's create_task: ToolDefinition אמיתי, אותו AgentTool backing בכל השלושה (Web/WhatsApp/registry) —");
  const registryCreateTask = AGENT_TOOLS.find((t) => t.name === "create_task")!;
  const whatsappCreateTask = getWhatsappTool("create_task")!;
  assert(WEB_CREATE_TASK_AGENT_TOOL === registryCreateTask, "chat.ts's CREATE_TASK_AGENT_TOOL === AGENT_TOOLS.find('create_task')");
  assert(
    CREATE_TASK_TOOL_DEFINITION.agentTool === registryCreateTask,
    "CREATE_TASK_TOOL_DEFINITION.agentTool === AGENT_TOOLS.find('create_task') — אותו אובייקט, לא עותק",
  );
  assert(CREATE_TASK_TOOL_DEFINITION.requiresConfirmation === false, "CREATE_TASK_TOOL_DEFINITION.requiresConfirmation === false");
  assert(
    CREATE_TASK_TOOL_DEFINITION.requiredPermission === undefined,
    "CREATE_TASK_TOOL_DEFINITION: אין requiredPermission עצמאי — מגיע במלואו מה-AgentTool (task:create/task:manage ANY-of)",
  );

  // ───────────────────────── 5. schema: זהה למה שהיה קודם ב-Web, וזהה (גם) ל-WhatsApp (אין narrowing כאן) ─────────────────────────
  logger.info("— schema: Web זהה למה שהיה קודם — וזהה גם ל-WhatsApp's create_task (בניגוד ל-create_lead, אין הבדל מכוון כאן) —");
  assert(
    CREATE_TASK_TOOL_DEFINITION.input_schema === WEB_CREATE_TASK_AGENT_TOOL.input_schema,
    "CREATE_TASK_TOOL_DEFINITION.input_schema === CREATE_TASK_AGENT_TOOL.input_schema — זה גם מה ש-Web חשף לפני 3F.5A",
  );
  assert(
    CREATE_TASK_TOOL_DEFINITION.input_schema === whatsappCreateTask.input_schema,
    "CREATE_TASK_TOOL_DEFINITION.input_schema === WhatsApp's create_task input_schema — אותו אובייקט, שני הערוצים (אין narrowing כמו ב-create_lead)",
  );

  // ───────────────────────── 3. permission decision — זהה ל-WhatsApp ול-canCreateTask הישן, לכל role ─────────────────────────
  logger.info("— permission decision: isToolAllowedForUser(Web) === isToolAllowedForUser(WhatsApp) === canCreateTask הישן, לכל role —");
  for (const user of [moti, dov, ruchama, goldi, yochi]) {
    const webDecision = isToolAllowedForUser(CREATE_TASK_TOOL_DEFINITION, user);
    const whatsappDecision = isToolAllowedForUser(whatsappCreateTask, user);
    const oldGateDecision = canCreateTask(user);
    assert(
      webDecision === whatsappDecision && webDecision === oldGateDecision,
      `create_task permission עבור ${user.key}: Web===WhatsApp===canCreateTask הישן (${webDecision})`,
    );
  }
  assert(isToolAllowedForUser(CREATE_TASK_TOOL_DEFINITION, null) === false, "create_task (Web): null user → false");

  // ───────────────────────── 2. execution מגיע ל-CREATE_TASK_AGENT_TOOL.execute ─────────────────────────
  logger.info("— execution: CREATE_TASK_TOOL_DEFINITION.execute עובר דרך requireIdentifiedUser, לא מריץ Monday על null —");
  {
    let threw = false;
    try {
      await CREATE_TASK_TOOL_DEFINITION.execute({ taskName: "בדיקה" }, { user: null });
    } catch (err) {
      threw = /חסר הקשר משתמש/.test((err as Error).message);
    }
    assert(threw, "CREATE_TASK_TOOL_DEFINITION.execute({user:null}) נדחה ע\"י requireIdentifiedUser — לא מגיע ל-Monday");
  }
  assert(
    CREATE_TASK_TOOL_DEFINITION.execute.toString().includes("CREATE_TASK_AGENT_TOOL.execute"),
    "CREATE_TASK_TOOL_DEFINITION.execute מפנה ל-CREATE_TASK_AGENT_TOOL.execute (מקור, לא Monday ישירות)",
  );

  // ───────────────────────── 1. create_task נדחף כ-ToolDefinition גולמי, בלי run() wrapper ─────────────────────────
  logger.info("— create_task נדחף ישירות (tools.push(CREATE_TASK_TOOL_DEFINITION)), אין יותר run() wrapper —");
  const taskPushSiteMatch = chatSource.match(/isToolAllowedForUser\(CREATE_TASK_TOOL_DEFINITION, user\)\) \{[\s\S]*?\n {2}\}\n/);
  assert(!!taskPushSiteMatch, "נמצא בלוק ה-gate של create_task ב-chat.ts");
  const taskPushSite = taskPushSiteMatch?.[0] ?? "";
  assert(
    /tools\.push\(CREATE_TASK_TOOL_DEFINITION\)/.test(taskPushSite),
    "create_task נדחף כאובייקט גולמי — tools.push(CREATE_TASK_TOOL_DEFINITION), לא tools.push({name,...,run:...})",
  );
  assert(!taskPushSite.includes("run:"), "בלוק ה-push של create_task לא מכיל יותר run: wrapper כלל");
  assert(
    !taskPushSite.includes("actions.push") && !taskPushSite.includes("refresh()"),
    "actions.push/refresh() עברו מהבלוק המקומי ל-dispatcher המשותף — לא נשארו כאן",
  );

  // ───────────────────────── 6+7+8. actions.push + refresh, בדיוק באותו סדר ורק בהצלחה ─────────────────────────
  logger.info("— SHARED_TOOL_UI_EFFECT: create_task עם refresh:true, create_lead בלי refresh —");
  // שלב 3F.5B: ה-map עבר לגור בתוך runOpsChat (כדי לסגור על findTask) — הסוגר (};) הוא עכשיו
  // מוזח ב-2 רווחים, לא בעמודה 0 כמו קודם.
  const uiEffectMapMatch = chatSource.match(/const SHARED_TOOL_UI_EFFECT: Record<string, SharedToolUiEffect> = \{[\s\S]*?\n {2}\};/);
  assert(!!uiEffectMapMatch, "נמצא SHARED_TOOL_UI_EFFECT ב-chat.ts");
  const uiEffectMap = uiEffectMapMatch?.[0] ?? "";
  // split על שם המפתח (לא regex עם [^}]*) — כי ה-message formatter עצמו מכיל `}` (סגירת
  // ${r.message} בתוך template literal), ש-[^}]* היה נתקל בו מוקדם מדי ומפסיק את ההתאמה.
  const [createLeadEntryText, createTaskEntryText] = uiEffectMap.split("create_task:");
  assert(/refresh:\s*true/.test(createTaskEntryText ?? ""), "SHARED_TOOL_UI_EFFECT.create_task: refresh:true (כמו ה-await refresh() הישן)");
  assert(!/refresh/.test(createLeadEntryText ?? ""), "SHARED_TOOL_UI_EFFECT.create_lead: אין refresh — נשאר בלי, כמו קודם");
  // סדר ההרצה (tool.execute → onExecuted/uiEffect.message → uiEffect.refresh, ואין refresh על
  // כשל/דחייה) הוא עכשיו architectural invariant של src/ai/dispatcher.ts's dispatchToolDefinition
  // עצמו — נבדק שם *ישירות* (קריאה אמיתית, לא קריאת מקור) ב-test-shared-dispatcher.ts, לא כאן.

  // ═══════════════════════════ Step 3F.5B: שאר 7 הכלים ═══════════════════════════
  // SHARED_TOOL_UI_EFFECT עבר לגור בתוך runOpsChat (כדי לסגור על findTask) — מחלצים את הטקסט
  // שלו ישירות ממקור הקובץ, כמו שכבר עשינו ל-dispatcher כולו ב-3F.4/3F.5A.
  const uiEffectMapMatch2 = chatSource.match(/const SHARED_TOOL_UI_EFFECT: Record<string, SharedToolUiEffect> = \{[\s\S]*?\n {2}\};/);
  assert(!!uiEffectMapMatch2, "נמצא SHARED_TOOL_UI_EFFECT (בתוך runOpsChat) ב-chat.ts");
  const uiEffectMap2 = uiEffectMapMatch2?.[0] ?? "";
  const UI_EFFECT_KEYS = [
    "create_lead",
    "create_task",
    "mark_done",
    "set_status",
    "add_note",
    "report_blocker",
    "add_update",
    "create_project_stage",
    "reassign_item",
  ];
  function extractUiEffectEntry(key: string): string {
    const start = uiEffectMap2.indexOf(`${key}:`);
    if (start === -1) return "";
    let end = uiEffectMap2.length;
    for (const k of UI_EFFECT_KEYS) {
      if (k === key) continue;
      const idx = uiEffectMap2.indexOf(`${k}:`, start + key.length + 1);
      if (idx !== -1 && idx < end) end = idx;
    }
    return uiEffectMap2.slice(start, end);
  }

  // ── הכלים ה"תמיד גלויים" (ללא build-time gate, לא היה ולא נוסף אחד): ──
  // mark_done/set_status/add_note/report_blocker/add_update
  logger.info("— mark_done/set_status/add_note/report_blocker/add_update: ToolDefinition, נדחפים ללא תנאי (כמו קודם) —");

  const alwaysVisible: [string, unknown, ToolDefinition, string, boolean][] = [
    ["mark_done", MARK_DONE_AGENT_TOOL, MARK_DONE_TOOL_DEFINITION, "✅ ", true],
    ["set_status", SET_STATUS_AGENT_TOOL, SET_STATUS_TOOL_DEFINITION, "↻ ", true],
    ["add_note", ADD_NOTE_AGENT_TOOL, ADD_NOTE_TOOL_DEFINITION, "✎ ", false],
    ["report_blocker", REPORT_BLOCKER_AGENT_TOOL, REPORT_BLOCKER_TOOL_DEFINITION, "🚧 ", true],
    ["add_update", ADD_UPDATE_AGENT_TOOL, ADD_UPDATE_TOOL_DEFINITION, "✎ הערה נוספה", false],
  ];

  for (const [name, agentTool, toolDef, expectedEmojiPrefix, expectedRefresh] of alwaysVisible) {
    const registryTool = AGENT_TOOLS.find((t) => t.name === name)!;
    assert((agentTool as { name: string }) === (registryTool as unknown), `${name}: chat.ts's AGENT_TOOL === AGENT_TOOLS.find('${name}')`);
    assert(toolDef.agentTool === registryTool, `${name}_TOOL_DEFINITION.agentTool === AGENT_TOOLS.find('${name}') — אותו אובייקט`);
    assert(toolDef.requiresConfirmation === false, `${name}_TOOL_DEFINITION.requiresConfirmation === false`);
    assert(
      toolDef.input_schema === (agentTool as { input_schema: unknown }).input_schema,
      `${name}_TOOL_DEFINITION.input_schema === ${name.toUpperCase()}_AGENT_TOOL.input_schema — לא שונה`,
    );
    assert(
      toolDef.execute.toString().includes(`${name.toUpperCase()}_AGENT_TOOL.execute`),
      `${name}_TOOL_DEFINITION.execute מפנה ל-${name.toUpperCase()}_AGENT_TOOL.execute (מקור)`,
    );

    // תיעוד מכוון: ה-ANY-of של ה-AgentTool הוא מקור האמת ל-execution-time re-check, אבל *לא*
    // משמש כ-build-time gate כאן — כי לפחות תפקיד אחד (finance/גולדי) שרואה את הכלי היום לא
    // מחזיק את ההרשאה (חוץ מ-add_update, שמכיל finance:manage ברשימה שלו וכן מכיל את כל 5
    // התפקידים — ר' audit 3F.5B). זו לא טעות, זו ה"discrepancy מתועד" שהתבקש.
    const goldiAllowedByAgentTool = isToolAllowedForUser(toolDef, goldi);
    if (name === "add_update") {
      assert(
        goldiAllowedByAgentTool,
        "add_update: גולדי *כן* מורשית לפי ה-ANY-of (finance:manage ברשימה) — מתאים, ANY-of מכיל את כל 5 התפקידים",
      );
    } else {
      assert(
        !goldiAllowedByAgentTool,
        `${name}: גולדי *לא* מורשית לפי ה-ANY-of של ה-AgentTool (רק task:update_own) — ` +
          `discrepancy מתועד: היא בכל זאת רואה את הכלי ב-tools[] (push ללא תנאי, ר' בדיקת המקור למטה), ` +
          `אבל authorize()'s הבדיקה הראשונה (task:update_own) זהה ל-ANY-of הזה — אותם אנשים נדחים משני המקורות`,
      );
    }
    // מוטי (owner) תמיד מורשה, מה שלא בדוק
    assert(isToolAllowedForUser(toolDef, moti), `${name}: מוטי (owner) מורשה לפי ה-ANY-of`);

    // UI effect: טקסט/emoji + refresh, מדויק כמו שהיה
    const entry = extractUiEffectEntry(name);
    assert(entry.length > 0, `${name}: יש entry ב-SHARED_TOOL_UI_EFFECT`);
    assert(entry.includes(expectedEmojiPrefix), `${name}: ה-UI effect כולל את ה-emoji/prefix המקורי ("${expectedEmojiPrefix}")`);
    if (expectedRefresh) {
      assert(/refresh:\s*true/.test(entry), `${name}: SHARED_TOOL_UI_EFFECT מכיל refresh:true (כמו ה-await refresh() הישן)`);
    } else {
      assert(!/refresh/.test(entry), `${name}: SHARED_TOOL_UI_EFFECT לא מכיל refresh — נשאר בלי, כמו קודם`);
    }
  }

  // בדיקת null — בטוחה, לא מגיעה ל-Monday (requireIdentifiedUser זורק קודם)
  for (const [name, , toolDef] of alwaysVisible) {
    let threw = false;
    try {
      await toolDef.execute({ itemId: "0" }, { user: null });
    } catch (err) {
      threw = /חסר הקשר משתמש/.test((err as Error).message);
    }
    assert(threw, `${name}_TOOL_DEFINITION.execute({user:null}) נדחה ע"י requireIdentifiedUser — לא מגיע ל-Monday`);
  }

  // אימות מקור: חמשת הכלים נדחפים *ללא* עטיפת if (isToolAllowedForUser(...)) — בדיוק כמו שהיה
  // (unconditional). אם מישהו בעתיד "יתקן" את זה ויוסיף gate — זו בדיוק ה-regression שנבדקת כאן.
  logger.info("— אימות מקור: 5 הכלים נדחפים ללא תנאי (לא עברו ל-gate, בכוונה) —");
  const unconditionalBlockMatch = chatSource.match(/MARK_DONE_TOOL_DEFINITION,[\s\S]*?ADD_UPDATE_TOOL_DEFINITION,/);
  assert(!!unconditionalBlockMatch, "נמצא הבלוק הרציף של 5 ה-TOOL_DEFINITION-ים ב-tools[]");
  const unconditionalBlock = unconditionalBlockMatch?.[0] ?? "";
  assert(!unconditionalBlock.includes("if ("), "הבלוק הרציף הזה לא עטוף ב-if (...) — דחיפה ללא תנאי, כמו קודם");

  // ── הכלים שעברו gate (מוכח זהה לישן): create_project_stage, reassign_item ──
  logger.info("— create_project_stage/reassign_item: gate עבר ל-isToolAllowedForUser, מוכח זהה לישן, לכל role —");

  const gatedTools: [string, unknown, ToolDefinition, (u: IdentifiedUser) => boolean, string][] = [
    ["create_project_stage", CREATE_PROJECT_STAGE_AGENT_TOOL, CREATE_PROJECT_STAGE_TOOL_DEFINITION, canManageProjectStages, "🆕 "],
    [
      "reassign_item",
      REASSIGN_ITEM_AGENT_TOOL,
      REASSIGN_ITEM_TOOL_DEFINITION,
      (u) => userCan(u, "task:manage") || userCan(u, "lead:manage") || userCan(u, "project:manage"),
      "👤 ",
    ],
  ];

  for (const [name, agentTool, toolDef, oldGate, expectedEmojiPrefix] of gatedTools) {
    const registryTool = AGENT_TOOLS.find((t) => t.name === name)!;
    assert((agentTool as { name: string }) === (registryTool as unknown), `${name}: chat.ts's AGENT_TOOL === AGENT_TOOLS.find('${name}')`);
    assert(toolDef.agentTool === registryTool, `${name}_TOOL_DEFINITION.agentTool === AGENT_TOOLS.find('${name}')`);
    assert(toolDef.requiresConfirmation === false, `${name}_TOOL_DEFINITION.requiresConfirmation === false`);
    assert(
      toolDef.input_schema === (agentTool as { input_schema: unknown }).input_schema,
      `${name}_TOOL_DEFINITION.input_schema === ${name.toUpperCase()}_AGENT_TOOL.input_schema`,
    );
    assert(
      toolDef.execute.toString().includes(`${name.toUpperCase()}_AGENT_TOOL.execute`),
      `${name}_TOOL_DEFINITION.execute מפנה ל-${name.toUpperCase()}_AGENT_TOOL.execute (מקור)`,
    );

    for (const user of [moti, dov, ruchama, goldi, yochi]) {
      const newDecision = isToolAllowedForUser(toolDef, user);
      const oldDecision = oldGate(user);
      assert(newDecision === oldDecision, `${name} permission עבור ${user.key}: gate חדש === gate ישן (${newDecision})`);
    }
    assert(isToolAllowedForUser(toolDef, null) === false, `${name}: null user → false`);

    // null-execute safety
    let threw = false;
    try {
      await toolDef.execute({ itemId: "0", name: "x", project: "x", person: "x" }, { user: null });
    } catch (err) {
      threw = /חסר הקשר משתמש/.test((err as Error).message);
    }
    assert(threw, `${name}_TOOL_DEFINITION.execute({user:null}) נדחה ע"י requireIdentifiedUser`);

    // build-time gate verification ממקור
    const gateMatch = chatSource.match(new RegExp(`isToolAllowedForUser\\(${name.toUpperCase()}_TOOL_DEFINITION, user\\)\\) \\{[\\s\\S]*?\\n {2}\\}\\n`));
    assert(!!gateMatch, `נמצא ה-build-time gate של ${name} ב-chat.ts (isToolAllowedForUser)`);
    assert(
      (gateMatch?.[0] ?? "").includes(`tools.push(${name.toUpperCase()}_TOOL_DEFINITION)`),
      `${name}: tools.push(${name.toUpperCase()}_TOOL_DEFINITION) — אובייקט גולמי, בלי run() wrapper`,
    );

    // UI effect
    const entry = extractUiEffectEntry(name);
    assert(entry.length > 0, `${name}: יש entry ב-SHARED_TOOL_UI_EFFECT`);
    assert(entry.includes(expectedEmojiPrefix), `${name}: ה-UI effect כולל את ה-emoji המקורי ("${expectedEmojiPrefix}")`);
    assert(!/refresh/.test(entry), `${name}: אין refresh — נשאר כמו קודם`);
  }

  // ───────────────────────── כל 9 ה-AgentTool-backed tools הם עכשיו ToolDefinition ─────────────────────────
  logger.info("— כל 9 ה-AgentTool-backed tools של Web הם עכשיו ToolDefinition (0 נותרו ב-run() הישן) —");
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
    "WIRED_AGENT_TOOL_NAMES: עדיין בדיוק 9 הכלים — לא נוסף/הוסר אחד (הרשימה עצמה לא השתנתה, רק ה-wiring הפנימי)",
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

  // ───────────────────────── 12. WhatsApp's 20-tool registry — ללא שינוי ─────────────────────────
  logger.info("— WhatsApp: 20 כלים, create_lead/create_task עדיין מחוברים נכון —");
  assert(whatsappTools.length === 20, `WhatsApp tools array === 20, בפועל ${whatsappTools.length}`);
  assert(
    whatsappCreateLead.agentTool === registryCreateLead,
    "WhatsApp's create_lead: agentTool עדיין === ל-registry — 3F.5A לא נגע בקובץ tools.ts's כלים",
  );
  assert(
    whatsappCreateLead.requiredPermission === undefined,
    "WhatsApp's create_lead: עדיין אין requiredPermission עצמאי (Step 3C) — לא השתנה",
  );
  assert(
    whatsappCreateTask.agentTool === registryCreateTask,
    "WhatsApp's create_task: agentTool עדיין === ל-registry — 3F.5A לא נגע בקובץ tools.ts's כלים",
  );
  assert(
    whatsappCreateTask.requiredPermission === undefined,
    "WhatsApp's create_task: עדיין אין requiredPermission עצמאי (Step 3C) — לא השתנה",
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
