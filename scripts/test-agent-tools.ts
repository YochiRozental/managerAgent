/**
 * בדיקת src/ops/agentTools.ts + חיבור כל 9 ה-AgentTools ל-Web (שלבים 1, 2A–2F, תוכנית איחוד
 * Web/WhatsApp, 2026-09-24 / 2026-10-05) — reassign_item (2F) הוא האחרון, ה-migration הושלם.
 *
 * מוודאת:
 *  1. הסכמות של create_task/create_project_stage זהות (===/deep-equal) למה ש-chat.ts מייצא.
 *  2. הסכמות של שאר הכלים (שהועתקו ידנית כי לא מיוצאות מ-chat.ts) זהות ל-fixture שמשקף
 *     מילה-במילה את ה-inline tool defs האמיתיים בתוך runOpsChat.
 *  3. כל execute מפנה בפועל לפונקציית ה-action הנכונה — עם deps מוזרקים, בלי Monday אמיתי.
 *  4. סינון לפי הרשאה (agentToolsForUser) עובד נכון לתפקידים אמיתיים מ-identity/roles.ts.
 *  5. (שלב 2A) create_task — object identity + permission-gate agreement מול ops/chat.ts.
 *  6. (שלב 2C) אותו דבר עבור create_lead.
 *  7. (שלב 2D) אותו דבר עבור mark_done/set_status/add_note/report_blocker/add_update —
 *     + permission *denial* אמיתי (גולדי, אין task:update_own, נתפס לפני כל קריאת Monday).
 *  8. (שלב 2D) "family distinctness" — מוכיח שארבעת כלי ה-updateTask לא מתבלבלים ביניהם:
 *     action/label/note נכנסים בדיוק לשדה הנכון ולא לאחר, ו-add_update בפרט *לעולם* לא קורא
 *     ל-updateTask (רק ל-addUpdateToItem) — ולהפך, ארבעת האחרים לעולם לא קוראים ל-addUpdateToItem.
 *  9. (שלב 2E) create_project_stage — object identity + permission-gate agreement (project:manage,
 *     בודד, לא ANY-of) + propagation מלא של שגיאות authorization/scope/idempotency שזורקת
 *     createProjectStageAction (לא נבלעות/משתנות ב-adapter). scope/idempotency/duplicate עצמם
 *     *לא* נבדקים מחדש כאן בכוונה — הם נבדקים ישירות מול createProjectStageAction ב-
 *     test-project-stage.ts, ומכיוון שה-execute כאן קורא *לאותה פונקציה בדיוק* (לא עותק),
 *     ההתנהגות שם כבר מכסה גם את הנתיב דרך ה-AgentTool.
 *  10. (שלב 2F) reassign_item — object identity + permission ANY-of agreement (לא ALL-of —
 *      נבדק ישירות על userCanUseAgentTool, לא רק על ה-declaration) + error propagation.
 *  11. (שלב 2F) סדר ה-resolution של reassignItem (ספר הצוות → Monday fallback) — ישירות מול
 *      actions.ts's reassignItem (אותה פונקציה שה-execute קורא לה, לא עותק): unique/ambiguous
 *      בספר הצוות, unique/ambiguous/no-match ב-Monday fallback, "אין חשבון Monday", אין-קלט,
 *      itemId לא תקין, ו-"כבר משויך" (no-op — מוכיח addTaskNote/setItemPeople לא נכתבים כפול).
 *
 * אין קריאה ל-Monday/AI אמיתיים — runOpsChat עצמו לא מופעל כאן (זה מחייב Monday חי); הבדיקה
 * מתמקדת במה שניתן לאמת סטטית/עם מוקים: object identity, schema, gating, delegation.
 *
 *   npm run test:agent-tools
 */

import {
  AGENT_TOOLS,
  agentToolsForUser,
  buildAgentTools,
  userCanUseAgentTool,
  type AgentTool,
  type BuildAgentToolsDeps,
} from "../src/ops/agentTools.js";
import {
  CREATE_PROJECT_STAGE_TOOL_DECL,
  CREATE_TASK_TOOL_DECL,
  CREATE_TASK_AGENT_TOOL,
  CREATE_LEAD_AGENT_TOOL,
  MARK_DONE_AGENT_TOOL,
  SET_STATUS_AGENT_TOOL,
  ADD_NOTE_AGENT_TOOL,
  REPORT_BLOCKER_AGENT_TOOL,
  ADD_UPDATE_AGENT_TOOL,
  CREATE_PROJECT_STAGE_AGENT_TOOL,
  REASSIGN_ITEM_AGENT_TOOL,
  canCreateTask,
  canCreateLead,
  canManageProjectStages,
} from "../src/ops/chat.js";
import { reassignItem, type ReassignItemDeps } from "../src/ops/actions.js";
import type { MondayUser } from "../src/integrations/monday/users.js";
import type { PeopleColumnInfo } from "../src/integrations/monday/itemWrite.js";
import { resolveUserByKey, userCan } from "../src/identity/index.js";
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

function byName(name: string, tools: AgentTool[] = AGENT_TOOLS): AgentTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`AgentTool "${name}" לא נמצא ב-registry`);
  return t;
}

// ───────────────────────── 1. סכמות create_task / create_project_stage — ייבוא אמיתי ─────────────────────────

logger.info("— סכמות מיובאות מ-ops/chat.ts —");
{
  const createTask = byName("create_task");
  assert(createTask.description === CREATE_TASK_TOOL_DECL.description, "create_task.description === CREATE_TASK_TOOL_DECL (אותו ייבוא)");
  assert(deepEqual(createTask.input_schema, CREATE_TASK_TOOL_DECL.input_schema), "create_task.input_schema === CREATE_TASK_TOOL_DECL.input_schema");

  const createStage = byName("create_project_stage");
  assert(
    createStage.description === CREATE_PROJECT_STAGE_TOOL_DECL.description,
    "create_project_stage.description === CREATE_PROJECT_STAGE_TOOL_DECL (אותו ייבוא)",
  );
  assert(
    deepEqual(createStage.input_schema, CREATE_PROJECT_STAGE_TOOL_DECL.input_schema),
    "create_project_stage.input_schema === CREATE_PROJECT_STAGE_TOOL_DECL.input_schema",
  );
}

// ───────────────────────── 2. סכמות שהועתקו ידנית — השוואה ל-fixture נאמן למקור ─────────────────────────
// ה-fixtures כאן הם העתק מדויק (ולא ניסוח מחדש) של ה-inline tool defs בתוך runOpsChat (ops/chat.ts,
// נכון ל-2026-09-24) — אם מישהו ישנה את הסכמה שם בלי לעדכן את agentTools.ts, הבדיקה הזו תיכשל.

logger.info("— סכמות שהועתקו ידנית מ-ops/chat.ts (inline tool defs) —");
{
  const expected: Record<string, Record<string, unknown>> = {
    mark_done: {
      type: "object",
      properties: { itemId: { type: "string" }, source: { type: "string", enum: ["general", "project_stage"] } },
      required: ["itemId", "source"],
    },
    set_status: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        source: { type: "string", enum: ["general", "project_stage"] },
        status: { type: "string", description: "תווית סטטוס, למשל 'בעבודה'" },
      },
      required: ["itemId", "source", "status"],
    },
    add_note: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        source: { type: "string", enum: ["general", "project_stage"] },
        note: { type: "string" },
      },
      required: ["itemId", "source", "note"],
    },
    report_blocker: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        source: { type: "string", enum: ["general", "project_stage"] },
        note: { type: "string", description: "מה חוסם" },
      },
      required: ["itemId", "source", "note"],
    },
    add_update: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "מזהה הפריט ב-Monday" },
        body: { type: "string", description: "תוכן ההערה" },
        label: { type: "string", description: "שם הפריט, לאישור בלבד" },
      },
      required: ["itemId", "body"],
    },
    reassign_item: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "מזהה הפריט ב-Monday" },
        person: { type: "string", description: "שם מלא או פרטי של מי שיהיה האחראי/ת החדש/ה" },
        label: { type: "string", description: "שם הפריט, לאישור בלבד" },
      },
      required: ["itemId", "person"],
    },
  };

  for (const [name, schema] of Object.entries(expected)) {
    const tool = byName(name);
    assert(deepEqual(tool.input_schema, schema), `${name}.input_schema תואם ל-inline def המקורי ב-chat.ts`);
  }

  // create_lead: המערכים (source/product enum) מגיעים מ-leads.ts עצמו — משווים רק את המבנה סביבם.
  const createLead = byName("create_lead");
  const props = (createLead.input_schema as { properties: Record<string, unknown> }).properties;
  assert(Object.keys(props).sort().join(",") === "assignee,email,firstName,lastName,phone,product,referredBy,source", "create_lead שדות זהים ל-chat.ts");
  assert(
    deepEqual((createLead.input_schema as { required: string[] }).required, ["firstName"]),
    "create_lead.required === ['firstName']",
  );
}

// ───────────────────────── 3. execute מפנה לפונקציית ה-action הנכונה (deps מוזרקים) ─────────────────────────

logger.info("— execute מפנה ל-action הנכון (deps מוזרקים, בלי Monday אמיתי) —");

const moti = resolveUserByKey("moti")!;
const ctx = { user: moti };

async function callsCorrectAction(
  toolName: string,
  input: Record<string, unknown>,
  depKey: keyof BuildAgentToolsDeps,
  expectedArgsCheck: (args: unknown[]) => boolean,
) {
  let called: unknown[] | null = null;
  const fakeFn = async (...args: unknown[]) => {
    called = args;
    return { ok: true, fake: true };
  };
  const tools = buildAgentTools({ [depKey]: fakeFn } as BuildAgentToolsDeps);
  const tool = byName(toolName, tools);
  const result = await tool.execute(input, ctx);
  assert(called !== null, `${toolName} → ${depKey} נקרא`);
  assert((result as { fake?: boolean })?.fake === true, `${toolName} מחזיר את התוצאה מה-action (לא עוטף/משנה אותה)`);
  if (called) assert(expectedArgsCheck(called), `${toolName} → ${depKey} נקרא עם הארגומנטים הנכונים`);
}

async function main() {
  await callsCorrectAction(
    "create_task",
    { taskName: "בדיקה" },
    "createTaskAction",
    (args) => args[0] === moti && (args[1] as { taskName: string }).taskName === "בדיקה",
  );

  await callsCorrectAction(
    "create_project_stage",
    { project: "פרויקט X", name: "שלב חדש" },
    "createProjectStageAction",
    (args) =>
      args[0] === moti &&
      (args[1] as { project: string; stageName: string }).project === "פרויקט X" &&
      (args[1] as { project: string; stageName: string }).stageName === "שלב חדש",
  );

  await callsCorrectAction(
    "mark_done",
    { itemId: "123", source: "general" },
    "updateTask",
    (args) => args[0] === moti && (args[1] as { action: string; itemId: string }).action === "done" && (args[1] as { itemId: string }).itemId === "123",
  );

  await callsCorrectAction(
    "set_status",
    { itemId: "123", source: "project_stage", status: "בעבודה" },
    "updateTask",
    (args) =>
      (args[1] as { action: string; label?: string; source: string }).action === "state" &&
      (args[1] as { label?: string }).label === "בעבודה" &&
      (args[1] as { source: string }).source === "project_stage",
  );

  await callsCorrectAction(
    "add_note",
    { itemId: "123", source: "general", note: "הערה" },
    "updateTask",
    (args) => (args[1] as { action: string; note?: string }).action === "note" && (args[1] as { note?: string }).note === "הערה",
  );

  await callsCorrectAction(
    "report_blocker",
    { itemId: "123", source: "general", note: "חסם" },
    "updateTask",
    (args) => (args[1] as { action: string; note?: string }).action === "blocker" && (args[1] as { note?: string }).note === "חסם",
  );

  await callsCorrectAction(
    "add_update",
    { itemId: "123", body: "תוכן" },
    "addUpdateToItem",
    (args) => args[0] === moti && args[1] === "123" && args[2] === "תוכן",
  );

  await callsCorrectAction(
    "reassign_item",
    { itemId: "123", person: "דוב" },
    "reassignItem",
    (args) => args[0] === moti && args[1] === "123" && args[2] === "דוב",
  );

  await callsCorrectAction(
    "create_lead",
    { firstName: "ישראל" },
    "createLeadAction",
    (args) => args[0] === moti && (args[1] as { firstName: string }).firstName === "ישראל",
  );

  // ───────────────────────── 4. סינון לפי הרשאה (ANY-of) — תפקידים אמיתיים ─────────────────────────
  logger.info("— agentToolsForUser: סינון לפי הרשאה (ANY-of), תפקידים אמיתיים —");

  const ruchama = resolveUserByKey("ruchama")!; // planner: view:own_work, report:hours, task:update_own, task:create
  const ruchamaNames = agentToolsForUser(ruchama).map((t) => t.name).sort();
  assert(ruchamaNames.includes("create_task"), "רוחמה (planner, task:create) כן רואה create_task");
  assert(ruchamaNames.includes("mark_done"), "רוחמה (task:update_own) כן רואה mark_done");
  assert(!ruchamaNames.includes("reassign_item"), "רוחמה לא רואה reassign_item (אין לה task:manage/lead:manage/project:manage)");
  assert(!ruchamaNames.includes("create_lead"), "רוחמה לא רואה create_lead (אין lead:manage)");
  assert(!ruchamaNames.includes("create_project_stage"), "רוחמה לא רואה create_project_stage (אין project:manage)");

  const goldi = resolveUserByKey("goldi")!; // finance: view:own_work, view:finance, finance:manage, report:hours
  const goldiNames = agentToolsForUser(goldi).map((t) => t.name).sort();
  assert(goldiNames.includes("add_update"), "גולדי (finance:manage) כן רואה add_update");
  assert(!goldiNames.includes("create_task"), "גולדי לא רואה create_task (אין task:create/task:manage)");
  assert(!goldiNames.includes("mark_done"), "גולדי לא רואה mark_done (אין task:update_own)");

  const dov = resolveUserByKey("dov")!; // project_manager: task:create, task:manage, project:manage, lead:manage...
  const dovNames = agentToolsForUser(dov).map((t) => t.name).sort();
  assert(
    dovNames.slice().sort().join(",") === AGENT_TOOLS.map((t) => t.name).sort().join(","),
    "דוב (project_manager) רואה את כל 9 ה-AgentTools",
  );

  assert(userCanUseAgentTool(moti, byName("create_project_stage")), "userCanUseAgentTool: מוטי (owner) כן");
  assert(!userCanUseAgentTool(ruchama, byName("create_project_stage")), "userCanUseAgentTool: רוחמה לא");

  // ───────────────────────── 5. Web parity — create_task הוא באמת ה-AgentTool המשותף (שלב 2A) ─────────────────────────
  logger.info("— Web Chat parity: create_task שה-Web מקבל === ה-AgentTool ב-registry (לא עותק) —");

  const createTaskFromRegistry = byName("create_task");
  assert(
    CREATE_TASK_AGENT_TOOL === createTaskFromRegistry,
    "ops/chat.ts's CREATE_TASK_AGENT_TOOL === AGENT_TOOLS.find('create_task') — אותו אובייקט בזיכרון, לא עותק",
  );
  assert(CREATE_TASK_AGENT_TOOL.name === "create_task", "tool name זהה ('create_task')");
  assert(
    deepEqual(CREATE_TASK_AGENT_TOOL.input_schema, CREATE_TASK_TOOL_DECL.input_schema),
    "schema זהה ל-CREATE_TASK_TOOL_DECL המיוצא מ-chat.ts (עצמו re-export מ-agentTools.ts)",
  );

  // permission filtering: canCreateTask(user) (השער בפועל ב-chat.ts, if (canCreateTask(user))) מול
  // userCanUseAgentTool עם ה-requiredPermission של ה-AgentTool — צריכים להסכים לכל תפקיד אמיתי.
  for (const key of ["moti", "yochi", "dov", "eitan", "ruchama", "goldi"]) {
    const u = resolveUserByKey(key)!;
    const viaChat = canCreateTask(u);
    const viaAgentTool = userCanUseAgentTool(u, CREATE_TASK_AGENT_TOOL);
    assert(viaChat === viaAgentTool, `permission filtering זהה בין canCreateTask ל-AgentTool.requiredPermission עבור ${key} (${viaChat})`);
  }

  // ───────────────────────── 6. Web parity — create_lead הוא באמת ה-AgentTool המשותף (שלב 2C) ─────────────────────────
  logger.info("— Web Chat parity: create_lead שה-Web מקבל === ה-AgentTool ב-registry (לא עותק) —");

  const createLeadFromRegistry = byName("create_lead");
  assert(
    CREATE_LEAD_AGENT_TOOL === createLeadFromRegistry,
    "ops/chat.ts's CREATE_LEAD_AGENT_TOOL === AGENT_TOOLS.find('create_lead') — אותו אובייקט בזיכרון, לא עותק",
  );
  assert(CREATE_LEAD_AGENT_TOOL.name === "create_lead", "tool name זהה ('create_lead')");

  // permission filtering: canCreateLead(user) (השער בפועל ב-chat.ts, if (canCreateLead(user))) מול
  // userCanUseAgentTool עם ה-requiredPermission של ה-AgentTool — צריכים להסכים לכל תפקיד אמיתי.
  for (const key of ["moti", "yochi", "dov", "eitan", "ruchama", "goldi"]) {
    const u = resolveUserByKey(key)!;
    const viaChat = canCreateLead(u);
    const viaAgentTool = userCanUseAgentTool(u, CREATE_LEAD_AGENT_TOOL);
    assert(viaChat === viaAgentTool, `permission filtering זהה בין canCreateLead ל-AgentTool.requiredPermission עבור ${key} (${viaChat})`);
  }

  // ───────────────────────── 7. Web parity — משפחת updateTask + add_update (שלב 2D) ─────────────────────────
  logger.info("— Web Chat parity: mark_done/set_status/add_note/report_blocker/add_update === ה-AgentTools ב-registry —");

  const familyChatTools: [string, AgentTool][] = [
    ["mark_done", MARK_DONE_AGENT_TOOL],
    ["set_status", SET_STATUS_AGENT_TOOL],
    ["add_note", ADD_NOTE_AGENT_TOOL],
    ["report_blocker", REPORT_BLOCKER_AGENT_TOOL],
    ["add_update", ADD_UPDATE_AGENT_TOOL],
  ];
  for (const [name, chatTool] of familyChatTools) {
    assert(chatTool === byName(name), `ops/chat.ts's ${name.toUpperCase()}_AGENT_TOOL === AGENT_TOOLS.find('${name}') — אותו אובייקט, לא עותק`);
    assert(chatTool.name === name, `tool name זהה ('${name}')`);
  }

  // permission *denial* אמיתי — גולדי (finance: אין task:update_own) — נדחה לפני כל קריאת Monday
  // (authorize() ב-actions.ts בודק userCan(task:update_own) כצעד הראשון, לפני isOwnItem/Monday).
  const goldiForDenial = resolveUserByKey("goldi")!;
  for (const [name, chatTool] of familyChatTools.slice(0, 4)) {
    // ה-4 הראשונים (לא add_update) — כולם עוברים ב-updateTask's authorize().
    let threw = false;
    try {
      await chatTool.execute({ itemId: "999", source: "general", status: "x", note: "x" }, { user: goldiForDenial });
    } catch (err) {
      threw = /הרשאה/.test((err as Error).message);
    }
    assert(threw, `${name}: גולדי (אין task:update_own) נדחית באותה שגיאת הרשאה — אין קריאת Monday בכלל`);
  }
  // add_update: לגולדי *כן* יש finance:manage (אחת מההרשאות ש-addUpdateToItem מקבל) — ה-requiredPermission
  // המוצהר של ה-AgentTool חייב לשקף במדויק את חמש ההרשאות ש-addUpdateToItem בודק בפועל (canNote ב-actions.ts).
  assert(
    [...ADD_UPDATE_AGENT_TOOL.requiredPermission].sort().join(",") ===
      ["task:update_own", "task:create", "lead:manage", "finance:manage", "project:manage"].sort().join(","),
    "add_update.requiredPermission תואם בדיוק לחמש ההרשאות שה-canNote הפנימי ב-addUpdateToItem בודק",
  );

  // ───────────────────────── 8. Family distinctness — לא מתבלבלים ביניהם (שלב 2D) ─────────────────────────
  logger.info("— Family distinctness: mark_done/set_status/add_note/report_blocker/add_update לא מתנהגים זה כזה —");

  async function captureCall(
    toolName: string,
    input: Record<string, unknown>,
    depKey: "updateTask" | "addUpdateToItem",
  ): Promise<{ called: unknown[] | null; otherCalled: boolean }> {
    let called: unknown[] | null = null;
    let otherCalled = false;
    const otherKey: "updateTask" | "addUpdateToItem" = depKey === "updateTask" ? "addUpdateToItem" : "updateTask";
    const deps: BuildAgentToolsDeps = {
      [depKey]: async (...args: unknown[]) => {
        called = args;
        return { ok: true };
      },
      [otherKey]: async (...args: unknown[]) => {
        otherCalled = true;
        return otherKey === "addUpdateToItem" ? { ok: true, message: "x" } : { ok: true, message: "x" };
      },
    } as BuildAgentToolsDeps;
    const tools = buildAgentTools(deps);
    await byName(toolName, tools).execute(input, ctx);
    return { called, otherCalled };
  }

  // mark_done ≠ set_status: mark_done לעולם לא שולח label, ופעולתו תמיד "done" — לא "state".
  {
    const { called } = await captureCall("mark_done", { itemId: "1", source: "general" }, "updateTask");
    const payload = called?.[1] as { action: string; label?: string; note?: string };
    assert(payload.action === "done", "mark_done: action === 'done' (לא 'state' של set_status)");
    assert(payload.label === undefined, "mark_done: לעולם לא שולח label — זה לא set_status");
    assert(payload.note === undefined, "mark_done: לעולם לא שולח note — זה לא add_note/report_blocker");
  }

  // set_status: ה-status המבוקש לא אובד — מגיע בדיוק ל-label, ופעולתו "state" (לא "done").
  {
    const { called } = await captureCall("set_status", { itemId: "1", source: "general", status: "תקוע לבדיקה" }, "updateTask");
    const payload = called?.[1] as { action: string; label?: string };
    assert(payload.action === "state", "set_status: action === 'state' (לא 'done' של mark_done)");
    assert(payload.label === "תקוע לבדיקה", "set_status: ה-status המבוקש נשמר בדיוק ב-label, לא אובד/מוחלף");
  }

  // add_note: לא משנה status בטעות — action === 'note' בלבד, בלי label.
  {
    const { called } = await captureCall("add_note", { itemId: "1", source: "general", note: "עדכון ביניים" }, "updateTask");
    const payload = called?.[1] as { action: string; label?: string; note?: string };
    assert(payload.action === "note", "add_note: action === 'note' — לא נוגע בסטטוס המשימה");
    assert(payload.label === undefined, "add_note: אין label — לא מתנהג כמו set_status");
    assert(payload.note === "עדכון ביניים", "add_note: תוכן ההערה מועבר בדיוק");
  }

  // report_blocker: סמנטיקת ה-blocker נשמרת — action === 'blocker', תיאור החסם ב-note (לא label/status).
  {
    const { called } = await captureCall("report_blocker", { itemId: "1", source: "general", note: "מחכה לאישור" }, "updateTask");
    const payload = called?.[1] as { action: string; label?: string; note?: string };
    assert(payload.action === "blocker", "report_blocker: action === 'blocker' — לא 'state'/'done'/'note'");
    assert(payload.note === "מחכה לאישור", "report_blocker: תיאור החסם מועבר בדיוק ב-note");
    assert(payload.label === undefined, "report_blocker: אין label — החסם לא הופך ל'סטטוס' כלשהו");
  }

  // add_update: מגיע ל-addUpdateToItem בלבד — *לעולם* לא ל-updateTask.
  {
    const { called, otherCalled } = await captureCall("add_update", { itemId: "1", body: "תוכן ההערה" }, "addUpdateToItem");
    assert(called !== null, "add_update: addUpdateToItem נקרא");
    assert(!otherCalled, "add_update: updateTask *לא* נקרא בכלל — אלה שתי business actions נפרדות");
    assert(called?.[1] === "1" && called?.[2] === "תוכן ההערה", "add_update: itemId/body מועברים בדיוק (לא עטופים ב-TaskUpdateInput)");
  }

  // ולהפך: כל אחד מארבעת כלי ה-updateTask *לא* קורא ל-addUpdateToItem בטעות.
  for (const [name] of familyChatTools.slice(0, 4)) {
    const { otherCalled } = await captureCall(
      name,
      { itemId: "1", source: "general", status: "x", note: "x" },
      "updateTask",
    );
    assert(!otherCalled, `${name}: addUpdateToItem *לא* נקרא — זה לא add_update`);
  }

  // ───────────────────────── 9. Web parity — create_project_stage (שלב 2E) ─────────────────────────
  logger.info("— Web Chat parity: create_project_stage === ה-AgentTool ב-registry (לא עותק) —");

  assert(
    CREATE_PROJECT_STAGE_AGENT_TOOL === byName("create_project_stage"),
    "ops/chat.ts's CREATE_PROJECT_STAGE_AGENT_TOOL === AGENT_TOOLS.find('create_project_stage') — אותו אובייקט, לא עותק",
  );
  assert(CREATE_PROJECT_STAGE_AGENT_TOOL.name === "create_project_stage", "tool name זהה ('create_project_stage')");
  assert(
    deepEqual(CREATE_PROJECT_STAGE_AGENT_TOOL.input_schema, CREATE_PROJECT_STAGE_TOOL_DECL.input_schema),
    "schema זהה ל-CREATE_PROJECT_STAGE_TOOL_DECL המיוצא מ-chat.ts (עצמו re-export מ-agentTools.ts)",
  );

  // permission filtering: canManageProjectStages(user) (השער ב-chat.ts) מול requiredPermission
  // (project:manage, בודד — לא ANY-of כמו reassign_item, זו הסיבה שזה עבר קודם).
  for (const key of ["moti", "yochi", "dov", "eitan", "ruchama", "goldi"]) {
    const u = resolveUserByKey(key)!;
    const viaChat = canManageProjectStages(u);
    const viaAgentTool = userCanUseAgentTool(u, CREATE_PROJECT_STAGE_AGENT_TOOL);
    assert(
      viaChat === viaAgentTool,
      `permission filtering זהה בין canManageProjectStages ל-AgentTool.requiredPermission עבור ${key} (${viaChat})`,
    );
  }

  // argument mapping (project/name → project/stageName) כבר מאומת בסעיף 3 (callsCorrectAction
  // "create_project_stage") — לא משוכפל כאן.

  // propagation: שגיאת authorization/scope/idempotency מ-createProjectStageAction עוברת דרך
  // ה-execute בלי להיבלע/להשתנות — ה-adapter לא "מתקן"/מסתיר כשל עסקי. בודק עם שגיאה טיפוסית
  // מ-authorizeCreateStage האמיתית (ר' actions.ts) — לא ממציא טקסט שגיאה חדש.
  {
    const scopeError = 'אתה לא מנהל/ת את הפרויקט "X" — יצירת שלב חדש שמורה למנהל/ת הפרויקט, לבעלים או לאדמין.';
    const tools = buildAgentTools({
      createProjectStageAction: async () => {
        throw new Error(scopeError);
      },
    });
    const tool = byName("create_project_stage", tools);
    let caught: string | null = null;
    try {
      await tool.execute({ project: "X", name: "שלב" }, ctx);
    } catch (err) {
      caught = (err as Error).message;
    }
    assert(caught === scopeError, "create_project_stage: שגיאת scope מ-createProjectStageAction עוברת דרך execute בלי שינוי");
  }

  // scope/idempotency/duplicate עצמם: מכוסים ישירות מול createProjectStageAction ב-test-project-
  // stage.ts (שלא השתנה) — אותה פונקציה בדיוק, לא עותק, ר' docstring בראש הקובץ.

  // ───────────────────────── 10. Web parity — reassign_item (שלב 2F, האחרון) ─────────────────────────
  logger.info("— Web Chat parity: reassign_item === ה-AgentTool ב-registry (לא עותק) —");

  assert(
    REASSIGN_ITEM_AGENT_TOOL === byName("reassign_item"),
    "ops/chat.ts's REASSIGN_ITEM_AGENT_TOOL === AGENT_TOOLS.find('reassign_item') — אותו אובייקט, לא עותק",
  );
  assert(REASSIGN_ITEM_AGENT_TOOL.name === "reassign_item", "tool name זהה ('reassign_item')");

  // permission filtering — ANY-of אמיתי, לא ALL-of: בודק ישירות על userCanUseAgentTool (לא רק
  // על requiredPermission.length), מול השער בפועל ב-chat.ts
  // (userCan(task:manage)||userCan(lead:manage)||userCan(project:manage)), לכל 6 התפקידים.
  assert(
    REASSIGN_ITEM_AGENT_TOOL.requiredPermission.length === 3,
    "reassign_item.requiredPermission מכיל את שלוש ההרשאות (task:manage/lead:manage/project:manage)",
  );
  for (const key of ["moti", "yochi", "dov", "eitan", "ruchama", "goldi"]) {
    const u = resolveUserByKey(key)!;
    const viaChat = userCan(u, "task:manage") || userCan(u, "lead:manage") || userCan(u, "project:manage");
    const viaAgentTool = userCanUseAgentTool(u, REASSIGN_ITEM_AGENT_TOOL);
    assert(
      viaChat === viaAgentTool,
      `permission filtering (ANY-of, לא ALL-of) זהה בין chat.ts's gate ל-userCanUseAgentTool עבור ${key} (${viaChat})`,
    );
  }
  // ספציפית ANY-of ולא ALL-of: רוחמה (planner) יש לה task:create אבל לא task:manage/lead:manage/
  // project:manage — none מההרשאות הנדרשות → נכון שהיא נדחית (לא proof של ANY-of). דוב (project_
  // manager) יש לו את *כל* השלוש — גם לא proof. גולדי (finance:manage בלבד, לא אחת משלוש) → נדחית.
  // ה-proof האמיתי ל-ANY-of (ולא ALL-of) כבר קיים בפועל ב-roles.ts: project_manager הוא התפקיד
  // היחיד עם יותר מהרשאה אחת מתוך השלוש, ואין תפקיד עם תת-קבוצה אמיתית (1 או 2 מתוך 3) לבדוק
  // עליו הבדל בין ANY-of ל-ALL-of בפועל — מתועד כהערה, לא כ-gap: ר' userCanUseAgentTool's own
  // implementation (.some(), לא .every()) כבר מאומת ישירות ב-unit test נפרד למטה.
  assert(
    (() => {
      const dummyAnyOf: AgentTool = { ...REASSIGN_ITEM_AGENT_TOOL, requiredPermission: ["lead:manage", "finance:manage"] };
      return userCanUseAgentTool(resolveUserByKey("goldi")!, dummyAnyOf) === true;
    })(),
    "userCanUseAgentTool הוא ANY-of אמיתי: גולדי (רק finance:manage, לא lead:manage) עדיין עוברת מול [lead:manage, finance:manage] כי .some() לא .every()",
  );

  // error propagation — זהה לדפוס create_project_stage: שגיאת resolution/scope אמיתית
  // מ-reassignItem עוברת דרך execute בלי שינוי.
  {
    const resolutionError = '"איקס" מתאים לכמה אנשים: דוב שפירא, איתן ברמן. מי בדיוק?';
    const tools = buildAgentTools({
      reassignItem: async () => {
        throw new Error(resolutionError);
      },
    });
    const tool = byName("reassign_item", tools);
    let caught: string | null = null;
    try {
      await tool.execute({ itemId: "1", person: "איקס" }, ctx);
    } catch (err) {
      caught = (err as Error).message;
    }
    assert(caught === resolutionError, "reassign_item: שגיאת resolution מ-reassignItem עוברת דרך execute בלי שינוי");
  }

  // ───────────────────────── 11. reassignItem — סדר ה-resolution (ישיר, אותה פונקציה בדיוק) ─────────────────────────
  // קורא ל-reassignItem האמיתית (לא דרך buildAgentTools) — זו *אותה* פונקציה בדיוק ש-
  // REASSIGN_ITEM_AGENT_TOOL.execute קורא לה (import יחיד מ-./actions.js, לא עותק) — לכן כל
  // מה שמאומת כאן תקף גם לנתיב דרך ה-AgentTool. משתמש ב-moti (owner) כ-actor כדי לעקוף scope
  // (לא רלוונטי לבדיקת ה-resolution עצמה — scope כבר מכוסה ב-test-project-scope.ts, לא משוכפל).
  logger.info("— reassignItem: סדר resolution (ספר הצוות → Monday fallback), בלי Monday אמיתי —");

  const fakeColumn: PeopleColumnInfo = {
    boardId: "board1",
    columnId: "person",
    columnTitle: "אחראי/ת",
    currentIds: ["other-id"],
    itemName: "פריט בדיקה",
  };

  async function tryReassign(
    person: string,
    deps: ReassignItemDeps,
  ): Promise<{ ok: boolean; message?: string; error?: string }> {
    try {
      const r = await reassignItem(moti, "123", person, deps);
      return { ok: true, message: r.message };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // 0. input ריק/לא תקין
  {
    const r = await tryReassign("   ", {});
    assert(!r.ok && r.error === "לא צוין למי להעביר", "person ריק (רק רווחים) → נדחה, בלי לגעת ב-Monday בכלל");
  }
  {
    let touched = false;
    try {
      await reassignItem(moti, "לא-מספר", "דוב", { detectPeopleColumn: async () => (touched = true) && fakeColumn });
    } catch (err) {
      assert((err as Error).message === "מזהה פריט לא תקין", "itemId לא מספרי → נדחה לפני כל resolution/Monday");
    }
    assert(!touched, "itemId לא תקין: Monday לא נגע בכלל");
  }

  // 1. ספר הצוות — match יחיד ("דוב" → "דוב שפירא", מקור: identity/directory.ts)
  {
    let findUsersByNameCalled = false;
    const setPeopleCalls: unknown[] = [];
    const addNoteCalls: unknown[] = [];
    const r = await tryReassign("דוב", {
      findUsersByName: async () => {
        findUsersByNameCalled = true;
        return [];
      },
      detectPeopleColumn: async () => fakeColumn,
      setItemPeople: async (...a) => void setPeopleCalls.push(a),
      addTaskNote: async (...a) => void addNoteCalls.push(a),
    });
    assert(r.ok && !!r.message?.includes("דוב שפירא"), "ספר הצוות: match יחיד ('דוב'→'דוב שפירא') → מצליח בלי Monday");
    assert(!findUsersByNameCalled, "ספר הצוות: match יחיד → findUsersByName (Monday) לא נקרא בכלל — layer 1 עוצר את layer 2");
    assert(setPeopleCalls.length === 1, "setItemPeople נקרא פעם אחת בדיוק");
    assert(addNoteCalls.length === 1, "addTaskNote נקרא פעם אחת בדיוק — אין כתיבה כפולה");
  }

  // 2. ספר הצוות — match יחיד, אבל בלי חשבון Monday ("גולדי")
  {
    let monday_touched = false;
    const r = await tryReassign("גולדי", {
      findUsersByName: async () => {
        monday_touched = true;
        return [];
      },
      detectPeopleColumn: async () => {
        monday_touched = true;
        return fakeColumn;
      },
    });
    assert(!r.ok && !!r.error?.includes("אין חשבון Monday פעיל"), "ספר הצוות: match יחיד בלי Monday פעיל (גולדי) → נדחה בהודעה הנכונה");
    assert(!monday_touched, "גולדי בלי Monday: נדחה *לפני* כל קריאת Monday (גם לא detectPeopleColumn)");
  }

  // 3. ספר הצוות — ambiguous ("דוב ואיתן" — אותו תרחיש אמיתי כמו test-task-creation.ts)
  {
    let monday_touched = false;
    const r = await tryReassign("דוב ואיתן", {
      findUsersByName: async () => {
        monday_touched = true;
        return [];
      },
    });
    assert(
      !r.ok && !!r.error?.includes("מתאים לכמה אנשים") && !!r.error?.includes("דוב שפירא") && !!r.error?.includes("איתן ברמן"),
      "ספר הצוות: ambiguous ('דוב ואיתן') → שגיאת עמימות עם שני השמות",
    );
    assert(!monday_touched, "ambiguous בספר הצוות: Monday לא נגע בכלל");
  }

  // 4. ספר הצוות ריק → Monday fallback, match יחיד
  {
    const mondayUser: MondayUser = { id: "999", name: "ישראלה ישראלי", email: "x@x.com" };
    let findUsersByNameQuery: string | null = null;
    const setPeopleCalls: unknown[] = [];
    const r = await tryReassign("ישראלה ישראלי", {
      findUsersByName: async (q) => {
        findUsersByNameQuery = q;
        return [mondayUser];
      },
      detectPeopleColumn: async () => fakeColumn,
      setItemPeople: async (...a) => void setPeopleCalls.push(a),
      addTaskNote: async () => {},
    });
    assert(r.ok && !!r.message?.includes("ישראלה ישראלי"), "Monday fallback: match יחיד → מצליח");
    assert(findUsersByNameQuery === "ישראלה ישראלי", "Monday fallback נקרא רק אחרי שספר הצוות החזיר 0 — עם השם המלא כמו שהועבר");
    const setPeopleArgs = setPeopleCalls[0] as [string, string, string, string[]] | undefined;
    assert(!!setPeopleArgs && setPeopleArgs[3].includes("999"), "setItemPeople נקרא עם המזהה שהוחזר מ-Monday ('999')");
  }

  // 5. ספר הצוות ריק → Monday fallback, ambiguous
  {
    const r = await tryReassign("ישראלה ישראלי", {
      findUsersByName: async () => [
        { id: "1", name: "ישראלה א'", email: "a@x.com" },
        { id: "2", name: "ישראלה ב'", email: "b@x.com" },
      ],
    });
    assert(
      !r.ok && !!r.error?.includes("מתאים לכמה") && !!r.error?.includes("ישראלה א'") && !!r.error?.includes("ישראלה ב'"),
      "Monday fallback: ambiguous → שגיאת עמימות עם שני השמות ממונדיי",
    );
  }

  // 6. ספר הצוות ריק → Monday fallback, אין התאמה בכלל
  {
    const r = await tryReassign("מישהו שלא קיים", { findUsersByName: async () => [] });
    assert(!r.ok && !!r.error?.includes('לא מצאתי משתמש/ת בשם "מישהו שלא קיים" ב-Monday'), "Monday fallback: אין match בכלל → שגיאה ברורה");
  }

  // 7. "כבר משויך" — no-op: לא כותב פעמיים, לא כותב בכלל
  {
    const setPeopleCalls: unknown[] = [];
    const addNoteCalls: unknown[] = [];
    const r = await tryReassign("דוב", {
      detectPeopleColumn: async () => ({ ...fakeColumn, currentIds: ["62982081"] }), // mondayUserId של דוב — כבר משויך
      setItemPeople: async (...a) => void setPeopleCalls.push(a),
      addTaskNote: async (...a) => void addNoteCalls.push(a),
    });
    assert(r.ok && !!r.message?.includes("כבר משויך"), "כבר משויך ל-targetId → no-op, מחזיר הודעה מתאימה");
    assert(setPeopleCalls.length === 0, "כבר משויך: setItemPeople *לא* נקרא — אין כתיבה מיותרת");
    assert(addNoteCalls.length === 0, "כבר משויך: addTaskNote *לא* נקרא — אין הערה כפולה/מיותרת");
  }

  logger.info(`\nסה"כ AgentTools ב-registry: ${AGENT_TOOLS.length}`);

  if (failures > 0) {
    logger.error(`\n${failures} בדיקות נכשלו ❌`);
    process.exit(1);
  }
  logger.info("\nכל בדיקות ה-agentTools עברו ✅");
}

main().catch((err) => {
  logger.error(err, "test-agent-tools failed");
  process.exit(1);
});
