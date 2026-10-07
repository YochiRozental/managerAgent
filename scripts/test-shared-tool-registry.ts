/**
 * Central Agent Core unification — Step 3F.6 (2026-10-07): direct, non-live tests of the new
 * shared AgentTool-backed ToolDefinition construction mechanism (src/ai/sharedTools.ts) —
 * buildSharedToolDefinition + filterSharedToolsForUser — plus cross-channel parity for the 5
 * AgentTools present on BOTH Web and WhatsApp (create_task, create_lead, mark_done, set_status,
 * add_update), replacing the nine hand-authored ops/chat.ts wrapper objects and the five
 * hand-authored integrations/claude/tools.ts wrapper objects that preceded this step.
 *
 * Unlike the old per-channel wrapper objects (whose `.execute` bodies had to be proven correct by
 * reading toString() source text, since every wrapper was hand-written), buildSharedToolDefinition
 * is itself a plain function — its execute wiring (requireIdentifiedUser → optional
 * transformInput → agentTool.execute) is proven here by direct invocation with spies, not by
 * sniffing generated closures' source text.
 *
 *   npm run test:shared-tool-registry
 */

import { buildSharedToolDefinition, filterSharedToolsForUser, requireAgentTool, type SharedToolVisibilityEntry } from "../src/ai/sharedTools.js";
import type { AgentTool, AgentToolContext } from "../src/ops/agentTools.js";
import type { ToolContext } from "../src/ai/toolRegistry.js";
import {
  CREATE_TASK_TOOL_DEFINITION as WEB_CREATE_TASK,
  CREATE_LEAD_TOOL_DEFINITION as WEB_CREATE_LEAD,
  MARK_DONE_TOOL_DEFINITION as WEB_MARK_DONE,
  SET_STATUS_TOOL_DEFINITION as WEB_SET_STATUS,
  ADD_UPDATE_TOOL_DEFINITION as WEB_ADD_UPDATE,
  CREATE_TASK_AGENT_TOOL,
  CREATE_LEAD_AGENT_TOOL,
  MARK_DONE_AGENT_TOOL,
  SET_STATUS_AGENT_TOOL,
  ADD_UPDATE_AGENT_TOOL,
  WEB_SHARED_TOOL_VISIBILITY,
  WIRED_AGENT_TOOL_NAMES,
} from "../src/ops/chat.js";
import { tools as whatsappTools, getTool as getWhatsappTool, toAnthropicTools } from "../src/integrations/claude/tools.js";
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

const moti = resolveUserByKey("moti")!; // owner
const dov = resolveUserByKey("dov")!; // project_manager
const ruchama = resolveUserByKey("ruchama")!; // planner
const goldi = resolveUserByKey("goldi")!; // finance
const yochi = resolveUserByKey("yochi")!; // admin
const ALL_ROLES = [moti, dov, ruchama, goldi, yochi];

function fakeAgentTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: "fake_tool",
    description: "fake description",
    input_schema: { type: "object", properties: { x: { type: "string" } } },
    requiredPermission: ["finance:manage"],
    execute: async () => ({ called: true }),
    ...overrides,
  };
}

async function main() {
  // ═══════════════════════ buildSharedToolDefinition — unit behavior ═══════════════════════
  logger.info("— buildSharedToolDefinition: ללא projection, כל השדות נופלים ל-AgentTool's own values —");
  {
    const agentTool = fakeAgentTool();
    const def = buildSharedToolDefinition(agentTool);
    assert(def.name === agentTool.name, "name === agentTool.name (ללא projection)");
    assert(def.description === agentTool.description, "description === agentTool.description");
    assert(def.input_schema === agentTool.input_schema, "input_schema === agentTool.input_schema (אותו אובייקט, לא עותק)");
    assert(def.requiresConfirmation === false, "requiresConfirmation === false (קבוע, כל כלי AgentTool-backed קיים הוא false)");
    assert(def.requiredPermission === undefined, "requiredPermission undefined ללא projection — ANY-of המלא של ה-AgentTool חל");
    assert(def.agentTool === agentTool, "agentTool === האובייקט שהועבר, לא עותק");
  }

  logger.info("— buildSharedToolDefinition: עם projection, רק השדות שהוצהרו נדרסים —");
  {
    const agentTool = fakeAgentTool();
    const customSchema = { type: "object", properties: { y: { type: "number" } } };
    const def = buildSharedToolDefinition(agentTool, {
      name: "renamed_tool",
      input_schema: customSchema,
      requiredPermission: "task:update_own",
    });
    assert(def.name === "renamed_tool", "name נדרס ע״י projection.name");
    assert(def.description === agentTool.description, "description לא הוצהר ב-projection ⇒ נופל ל-agentTool.description");
    assert(def.input_schema === customSchema, "input_schema נדרס ע״י projection.input_schema");
    assert(def.requiredPermission === "task:update_own", "requiredPermission נדרס ע״י projection.requiredPermission");
    assert(def.agentTool === agentTool, "agentTool תמיד האובייקט המקורי — projection לא יכול לשנות את ה-backing");
  }

  logger.info("— buildSharedToolDefinition.execute: requireIdentifiedUser רץ קודם, agentTool.execute לא רץ אם user=null —");
  {
    let agentExecuteCalled = false;
    const agentTool = fakeAgentTool({
      execute: async () => {
        agentExecuteCalled = true;
        return { ok: true };
      },
    });
    const def = buildSharedToolDefinition(agentTool);
    let threw = false;
    try {
      await def.execute({}, { user: null } as ToolContext);
    } catch (err) {
      threw = /חסר הקשר משתמש/.test((err as Error).message);
    }
    assert(threw, "execute({user:null}) נדחה ע״י requireIdentifiedUser");
    assert(!agentExecuteCalled, "agentTool.execute לא רץ בכלל כש-user=null — requireIdentifiedUser חוסם לפני");
  }

  logger.info("— buildSharedToolDefinition.execute: בלי transformInput, ה-input מגיע ל-agentTool.execute ללא שינוי —");
  {
    let received: unknown = "unset";
    const agentTool = fakeAgentTool({
      execute: async (input: Record<string, unknown>) => {
        received = input;
        return { ok: true };
      },
    });
    const def = buildSharedToolDefinition(agentTool);
    await def.execute({ a: 1 }, { user: moti });
    assert(deepEqual(received, { a: 1 }), "input מגיע כפי שהוא, בלי transformInput");
  }

  logger.info("— buildSharedToolDefinition.execute: עם transformInput, ה-input עובר דרכו לפני agentTool.execute —");
  {
    let received: unknown = "unset";
    let receivedUser: IdentifiedUser | null = null;
    const agentTool = fakeAgentTool({
      execute: async (input: Record<string, unknown>, ctx: AgentToolContext) => {
        received = input;
        receivedUser = ctx.user;
        return { ok: true };
      },
    });
    const def = buildSharedToolDefinition(agentTool, {
      transformInput: (input) => ({ ...input, transformed: true }),
    });
    await def.execute({ a: 1 }, { user: dov });
    assert(deepEqual(received, { a: 1, transformed: true }), "transformInput רץ על ה-input לפני agentTool.execute (בדיוק כמו WhatsApp's normalizeTaskSource)");
    assert(receivedUser === dov, "ה-user המזוהה (לא ה-ctx הגולמי) מועבר ל-agentTool.execute — requireIdentifiedUser עשה את ה-narrowing");
  }

  // ═══════════════════════ filterSharedToolsForUser — unit behavior ═══════════════════════
  logger.info("— filterSharedToolsForUser: 'always' תמיד נכנס, 'gated' נופל ל-isToolAllowedForUser —");
  {
    const alwaysTool = buildSharedToolDefinition(fakeAgentTool({ name: "always_tool", requiredPermission: ["finance:manage"] }));
    const gatedTool = buildSharedToolDefinition(fakeAgentTool({ name: "gated_tool", requiredPermission: ["finance:manage"] }));
    const entries: SharedToolVisibilityEntry[] = [
      { tool: alwaysTool, visibility: "always" },
      { tool: gatedTool, visibility: "gated" },
    ];
    const forRuchama = filterSharedToolsForUser(entries, ruchama); // ruchama has no finance:manage
    assert(forRuchama.includes(alwaysTool), "'always': רוחמה מקבלת אותו גם בלי finance:manage");
    assert(!forRuchama.includes(gatedTool), "'gated': רוחמה לא מקבלת אותו — אין לה finance:manage");
    const forGoldi = filterSharedToolsForUser(entries, goldi); // goldi has finance:manage
    assert(forGoldi.includes(alwaysTool) && forGoldi.includes(gatedTool), "גולדי (יש לה finance:manage) מקבלת את שניהם");
    const forNull = filterSharedToolsForUser(entries, null);
    assert(forNull.includes(alwaysTool) && !forNull.includes(gatedTool), "user=null: 'always' עדיין נכנס, 'gated' נדחה");
  }

  // ═══════════════════════ requireAgentTool ═══════════════════════
  logger.info("— requireAgentTool: אותו אובייקט בכל קריאה, זורק הודעה מדויקת עם שם הערוץ אם חסר —");
  {
    const a = requireAgentTool("create_lead", "Web");
    const b = requireAgentTool("create_lead", "WhatsApp");
    assert(a === b, "requireAgentTool('create_lead', ...) מחזיר את אותו אובייקט בלי תלות בשם הערוץ — ה-registry הוא אחד");
    let threw = false;
    try {
      requireAgentTool("no_such_tool_xyz", "Web");
    } catch (err) {
      threw = (err as Error).message.includes("חיבור Web שבור");
    }
    assert(threw, "requireAgentTool זורק עם שם הערוץ שהועבר בהודעת השגיאה, בדיוק כמו קודם");
  }

  // ═══════════════════════ Cross-channel parity — 5 AgentTools present on BOTH channels ═══════════════════════
  logger.info("— create_task: Web ו-WhatsApp חושפים את ה-AgentTool 'כמו שהוא' (אין projection בשני הצדדים) —");
  {
    const wa = getWhatsappTool("create_task")!;
    assert(WEB_CREATE_TASK.name === wa.name && wa.name === "create_task", "name זהה בשני הערוצים");
    assert(WEB_CREATE_TASK.description === wa.description, "description זהה (שני הצדדים ללא projection)");
    assert(WEB_CREATE_TASK.input_schema === wa.input_schema, "input_schema זהה (===, אותו אובייקט — אין narrowing בשני הצדדים)");
    assert(WEB_CREATE_TASK.agentTool === wa.agentTool && wa.agentTool === CREATE_TASK_AGENT_TOOL, "אותו AgentTool backing משני הצדדים");
    assert(WEB_CREATE_TASK.requiredPermission === undefined && wa.requiredPermission === undefined, "אין requiredPermission עצמאי בשני הצדדים — ANY-of מלא");
    assert(WEB_CREATE_TASK.requiresConfirmation === false && wa.requiresConfirmation === false, "requiresConfirmation false בשני הצדדים");
  }

  logger.info("— mark_done/set_status: Web ו-WhatsApp חושפים schema/name/description זהים; רק WhatsApp מוסיף transformInput —");
  for (const [webDef, waName, agentTool] of [
    [WEB_MARK_DONE, "mark_done", MARK_DONE_AGENT_TOOL],
    [WEB_SET_STATUS, "set_status", SET_STATUS_AGENT_TOOL],
  ] as const) {
    const wa = getWhatsappTool(waName)!;
    assert(webDef.name === wa.name, `${waName}: name זהה`);
    assert(webDef.description === wa.description, `${waName}: description זהה`);
    assert(webDef.input_schema === wa.input_schema, `${waName}: input_schema זהה (===)`);
    assert(webDef.agentTool === wa.agentTool && wa.agentTool === agentTool, `${waName}: אותו AgentTool backing`);
    assert(webDef.requiredPermission === undefined && wa.requiredPermission === undefined, `${waName}: אין requiredPermission עצמאי בשני הצדדים`);
  }

  logger.info("— create_lead: Web (8 שדות, כולל assignee) מול WhatsApp (7 שדות, בלי assignee) — הבדל מכוון, לא נעלם —");
  {
    const wa = getWhatsappTool("create_lead")!;
    assert(WEB_CREATE_LEAD.name === wa.name && wa.name === "create_lead", "name זהה (רק ה-schema/description משתנים)");
    assert(WEB_CREATE_LEAD.description !== wa.description, "description *שונה* במכוון (WhatsApp מנוסח קצר יותר)");
    assert(WEB_CREATE_LEAD.input_schema !== wa.input_schema, "input_schema *שונה* אובייקט (לא ===) — projection נפרד ב-WhatsApp");
    const webProps = Object.keys((WEB_CREATE_LEAD.input_schema as { properties: Record<string, unknown> }).properties).sort();
    const waProps = Object.keys((wa.input_schema as { properties: Record<string, unknown> }).properties).sort();
    assert(webProps.join(",") === "assignee,email,firstName,lastName,phone,product,referredBy,source", "Web: 8 שדות כולל assignee");
    assert(waProps.join(",") === "email,firstName,lastName,phone,product,referredBy,source", "WhatsApp: 7 שדות בלי assignee");
    assert(WEB_CREATE_LEAD.agentTool === wa.agentTool && wa.agentTool === CREATE_LEAD_AGENT_TOOL, "אותו AgentTool backing — ההבדל הוא רק ב-projection, לא בזהות העסקית");
    assert(WEB_CREATE_LEAD.requiredPermission === undefined && wa.requiredPermission === undefined, "אין requiredPermission עצמאי בשני הצדדים — ANY-of מלא (['lead:manage']) חל בשניהם");
    assert(WEB_CREATE_LEAD.requiresConfirmation === false && wa.requiresConfirmation === false, "requiresConfirmation false בשני הצדדים");
  }

  logger.info("— add_update (Web) מול add_monday_update (WhatsApp): שם/schema/requiredPermission שונים במכוון —");
  {
    const wa = getWhatsappTool("add_monday_update")!;
    assert(WEB_ADD_UPDATE.name === "add_update" && wa.name === "add_monday_update", "שמות *שונים* במכוון — WhatsApp model מכיר add_monday_update, לא add_update");
    assert(WEB_ADD_UPDATE.agentTool === wa.agentTool && wa.agentTool === ADD_UPDATE_AGENT_TOOL, "אותו AgentTool backing — זהות עסקית אחת, שתי חשיפות");
    assert(WEB_ADD_UPDATE.requiredPermission === undefined, "Web: אין requiredPermission עצמאי — ANY-of המלא (5 הרשאות) חל");
    assert(wa.requiredPermission === "task:update_own", "WhatsApp: requiredPermission='task:update_own' — צמצום מכוון של ה-ANY-of (audit Step 3B: לא להרחיב capability surface בשקט)");
    const webProps = Object.keys((WEB_ADD_UPDATE.input_schema as { properties: Record<string, unknown> }).properties).sort();
    const waProps = Object.keys((wa.input_schema as { properties: Record<string, unknown> }).properties).sort();
    assert(webProps.join(",") === "body,itemId,label", "Web: 3 שדות (כולל label, ל-actions.push התצוגתי)");
    assert(waProps.join(",") === "body,itemId", "WhatsApp: 2 שדות (בלי label — לא היה ולא נחשף)");
    assert(WEB_ADD_UPDATE.requiresConfirmation === false && wa.requiresConfirmation === false, "requiresConfirmation false בשני הצדדים");
  }

  // ═══════════════════════ WEB_SHARED_TOOL_VISIBILITY — הטבלה המוצהרת ═══════════════════════
  logger.info("— WEB_SHARED_TOOL_VISIBILITY: 9 entries, 5 always / 4 gated, זהה ל-WIRED_AGENT_TOOL_NAMES —");
  assert(WEB_SHARED_TOOL_VISIBILITY.length === 9, `WEB_SHARED_TOOL_VISIBILITY: 9 entries (בפועל ${WEB_SHARED_TOOL_VISIBILITY.length})`);
  const alwaysNames = WEB_SHARED_TOOL_VISIBILITY.filter((e) => e.visibility === "always").map((e) => e.tool.name).sort();
  const gatedNames = WEB_SHARED_TOOL_VISIBILITY.filter((e) => e.visibility === "gated").map((e) => e.tool.name).sort();
  assert(
    deepEqual(alwaysNames, ["add_note", "add_update", "mark_done", "report_blocker", "set_status"].sort()),
    `visibility='always' === 5 הכלים ההיסטוריים (בפועל: ${alwaysNames.join(",")})`,
  );
  assert(
    deepEqual(gatedNames, ["create_lead", "create_project_stage", "create_task", "reassign_item"].sort()),
    `visibility='gated' === 4 הכלים (בפועל: ${gatedNames.join(",")})`,
  );
  assert(
    deepEqual([...WIRED_AGENT_TOOL_NAMES].sort(), [...alwaysNames, ...gatedNames].sort()),
    "WEB_SHARED_TOOL_VISIBILITY מכסה בדיוק את WIRED_AGENT_TOOL_NAMES — לא חסר/עודף כלי",
  );

  // ═══════════════════════ Web visibility parity — exactly the same tool names per role as before ═══════════════════════
  logger.info("— Web: filterSharedToolsForUser(WEB_SHARED_TOOL_VISIBILITY, user) מחזיר בדיוק את אותם שמות כלים לכל role —");
  function expectedWebSharedNames(user: IdentifiedUser): string[] {
    const names = ["mark_done", "set_status", "add_note", "report_blocker", "add_update"]; // "always" — כל role
    if (userCan(user, "task:create") || userCan(user, "task:manage")) names.push("create_task");
    if (userCan(user, "lead:manage")) names.push("create_lead");
    if (userCan(user, "project:manage")) names.push("create_project_stage");
    if (userCan(user, "task:manage") || userCan(user, "lead:manage") || userCan(user, "project:manage")) names.push("reassign_item");
    return names.sort();
  }
  for (const user of ALL_ROLES) {
    const actual = filterSharedToolsForUser(WEB_SHARED_TOOL_VISIBILITY, user).map((t) => t.name).sort();
    assert(deepEqual(actual, expectedWebSharedNames(user)), `Web shared tool names עבור ${user.key}: תואם לחישוב מקורות-האמת (${actual.join(",")})`);
  }
  {
    const actual = filterSharedToolsForUser(WEB_SHARED_TOOL_VISIBILITY, null).map((t) => t.name).sort();
    assert(deepEqual(actual, ["add_note", "add_update", "mark_done", "report_blocker", "set_status"].sort()), "Web, user=null: רק 5 ה'always' — 4 ה'gated' נדחים (isToolAllowedForUser(...,null)===false)");
  }

  // ═══════════════════════ WhatsApp visibility parity — unchanged uniform filter ═══════════════════════
  logger.info("— WhatsApp: toAnthropicTools(user) עדיין חושף בדיוק 5 ה-AgentTool-backed tools הנכונים לכל role (ללא שינוי) —");
  function expectedWhatsappSharedNames(user: IdentifiedUser): string[] {
    const names: string[] = ["mark_done", "set_status"]; // task:update_own
    if (!userCan(user, "task:update_own")) names.length = 0;
    if (userCan(user, "task:create") || userCan(user, "task:manage")) names.push("create_task");
    if (userCan(user, "lead:manage")) names.push("create_lead");
    if (userCan(user, "task:update_own")) names.push("add_monday_update");
    return names.sort();
  }
  for (const user of ALL_ROLES) {
    const visible = new Set(toAnthropicTools(user).map((t) => t.name));
    const actual = ["mark_done", "set_status", "create_task", "create_lead", "add_monday_update"].filter((n) => visible.has(n)).sort();
    assert(deepEqual(actual, expectedWhatsappSharedNames(user)), `WhatsApp shared tool names עבור ${user.key}: תואם לחישוב מקורות-האמת (${actual.join(",") || "(none)"})`);
  }
  assert(whatsappTools.length === 20, `WhatsApp: עדיין בדיוק 20 כלים כולל (בפועל ${whatsappTools.length}) — 3F.6 לא הוסיף/הסיר כלי`);

  if (failures > 0) {
    logger.error(`\n${failures} בדיקות נכשלו ❌`);
    process.exit(1);
  }
  logger.info("\nכל בדיקות ה-shared-tool-registry עברו ✅");
}

main().catch((err) => {
  logger.error(err, "כשל לא צפוי בהרצת הבדיקות");
  process.exit(1);
});
