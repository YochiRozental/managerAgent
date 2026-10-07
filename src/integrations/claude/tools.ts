/**
 * כלי ה-AI לסוכן WhatsApp (orchestrator.ts). הכלים הקיימים כאן (assign_monday_task,
 * update_monday_task_status, set_monday_task_due_date, delete_monday_task) גייטד לפי
 * requiredPermission="task:manage" בלבד — בלי project scope (החלטת יוכי 2026-09-24: מנהל
 * פרויקט מורשה לנהל רק את הפרויקטים שהוא בעצמו רשום עליהם ב-"אחראי/ת").
 *
 * זה תקין *כרגע* בפועל כי WhatsApp פתוח רק למוטי/owner (CLAUDE.md §3) — owner עוקף scope
 * ממילא. **ברגע ש-WhatsApp ייפתח למנהלי פרויקטים (דוב/איתן) — האכיפה הזו חובה כאן גם**, באותה
 * צורה שכבר יושמה בחלונית (src/ops/actions.ts: assertManagesItemProject/managesProject, מעל
 * resolveItemProjectScope/getProjectOwnerIds ב-src/integrations/monday/opsRead.ts). אל תניחו
 * ש-task:manage מספיק בלי לבדוק שוב את הפער הזה קודם.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { IdentifiedUser, Permission } from "../../identity/index.js";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
  type UpdateEventInput,
} from "../google/calendar.js";
import { sendEmail } from "../google/gmail.js";
import { LEAD_PRODUCT_OPTIONS, LEAD_SOURCE_OPTIONS } from "../monday/leads.js";
import {
  assignTask,
  createTask,
  deleteTask,
  findBoardsByName,
  listBoards,
  listTasks,
  setTaskDueDate,
  updateTaskStatus,
} from "../monday/tasks.js";
import { findUsersByName } from "../monday/users.js";
import { getMyWorkBrief } from "../../ops/myWorkBrief.js";
import { AGENT_TOOLS, type AgentTool } from "../../ops/agentTools.js";

/** הקשר הרצה שה-orchestrator מזריק לכלי — מי המשתמש ששאל. */
export interface ToolContext {
  user: IdentifiedUser | null;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  /** Visible to others / hard to undo — must be confirmed by the user before executing (wired in M7). */
  requiresConfirmation: boolean;
  /**
   * ההרשאה שהמשתמש חייב להחזיק כדי להריץ את הכלי. אם לא מוגדר — מספיק להיות מזוהה.
   * האכיפה ב-orchestrator לפני הרצת הכלי. כשהכלי מגובה ב-agentTool (למטה): אם requiredPermission
   * מוגדר, הוא צמצום מכוון של ה-ANY-of של ה-AgentTool (נבדק כ-subset ב-startup — ר' הבדיקה אחרי
   * מערך tools למטה); אם לא מוגדר, ה-ANY-of המלא של ה-AgentTool חל ישירות — ר' isToolAllowedForUser.
   */
  requiredPermission?: Permission;
  /**
   * קישור גנרי (שלב 3C, 2026-10-07) לכלי משותף ב-registry (ops/agentTools.ts) — לא תלוי בשם
   * הכלי, כדי שישמש גם מיגרציות עתידיות. כשמוגדר, ה-AgentTool הוא מקור האמת להרשאות הכלי
   * (ר' isToolAllowedForUser) — לא עוד שתי השוואות הרשאה נפרדות (אחת כאן/ב-toAnthropicTools,
   * אחת ב-orchestrator.ts's canUseTool) שרק "קורה" להן להסכים.
   */
  agentTool?: AgentTool;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any, ctx: ToolContext) => Promise<unknown>;
}

/**
 * שלב 3B (2026-10-05, תוכנית איחוד Web/WhatsApp) — add_monday_update/create_lead מחוברים
 * ל-AgentTool המשותף (ops/agentTools.ts) במקום implementation עצמאי. מאתר לפי שם ב-registry,
 * זורק מיידית אם חסר — תקלת-חיווט תיתפס בעליית השרת, לא בשקט באמצע שיחה (אותו דפוס בדיוק
 * כמו requireAgentTool ב-ops/chat.ts).
 */
function requireAgentTool(name: string) {
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`AgentTool '${name}' לא נמצא ב-registry המשותף (ops/agentTools.ts) — חיבור WhatsApp שבור.`);
  return tool;
}
/** מיוצאים כדי שבדיקות (test-whatsapp-agent-tools.ts) יוכיחו === מול AGENT_TOOLS — אותו אובייקט
 *  שגם ops/chat.ts (Web) משתמש בו, לא עותק. */
export const ADD_UPDATE_AGENT_TOOL = requireAgentTool("add_update");
export const CREATE_LEAD_AGENT_TOOL = requireAgentTool("create_lead");
/**
 * שלב 3D (2026-10-07) — domain actions אמיתיים של מערכת המשימות (לא Monday primitive גנרי
 * כמו update_monday_task_status, ר' docstring בראש הקובץ). update_monday_task_status *נשאר*
 * ללא שינוי כ-legacy fallback (בורדים שאינם משימות משרד/שלבי פרויקט) — ר' audit נפרד.
 */
export const MARK_DONE_AGENT_TOOL = requireAgentTool("mark_done");
export const SET_STATUS_AGENT_TOOL = requireAgentTool("set_status");
/**
 * שלב 3E (2026-10-07) — אותו דפוס בדיוק: create_monday_task הוא Monday primitive גנרי
 * (boardId+itemName כלשהם, בלי assignee/project/stage/date/priority/idempotency/scope) ולא
 * equivalent סמנטי ל-create_task (domain action מלא עם authorizeCreateTask/project+stage
 * disambiguation/idempotency). create_monday_task *נשאר* ללא שינוי כ-legacy fallback לבורדים
 * שאינם משימות משרד/שלבי פרויקט — ר' audit נפרד.
 */
export const CREATE_TASK_AGENT_TOOL = requireAgentTool("create_task");

/**
 * בפועל לא אמור לקרות — toAnthropicTools(null) מחזיר מערך כלים ריק, אז executeToolCall לא
 * אמור להגיע לכאן בלי משתמש מזוהה. שמירה מפורשת (לא bypass, לא ניחוש) כדי שה-AgentTool יקבל
 * user: IdentifiedUser תקין, לא IdentifiedUser|null. מיוצא כדי שבדיקות יוכלו לבחון אותה ישירות
 * כפונקציה טהורה, בלי להריץ שום AgentTool אמיתי (שהיה מגיע ל-Monday).
 */
export function requireIdentifiedUser(ctx: ToolContext): IdentifiedUser {
  if (!ctx.user) throw new Error("חסר הקשר משתמש — לא ניתן לבצע את הפעולה בלי לדעת מי שואל.");
  return ctx.user;
}

/**
 * שלב 3D: list_my_work (הכלי היחיד שחושף source לפריט ב-WhatsApp היום) מחזיר source="office"/
 * "project" — תוויות תצוגה (ר' ops/myWorkBrief.ts's toBriefTask), לא "general"/"project_stage"
 * (הערך הגולמי, זהה ל-OpsTaskSource, שה-AgentTool של mark_done/set_status דורש בפועל — וזה מה
 * שה-schema שהמודל מקבל מצהיר עליו, ללא שינוי). אי-התאמת מינוח קיימת שהתגלתה באודיט — לא נוגעים
 * ב-myWorkBrief.ts (מחוץ לסקופ), רק רשת ביטחון כאן למקרה שהמודל מעתיק את source מילה-במילה
 * מ-list_my_work בלי לתרגם. מיפוי כינויים בלבד — אין כאן שום לוגיקה עסקית.
 */
export function normalizeTaskSource(input: Record<string, unknown>): Record<string, unknown> {
  const aliasMap: Record<string, string> = { office: "general", project: "project_stage" };
  const raw = input.source;
  return typeof raw === "string" && raw in aliasMap ? { ...input, source: aliasMap[raw] } : input;
}

export const tools: ToolDefinition[] = [
  {
    name: "list_monday_boards",
    description: "מחזיר את כל הלוחות (boards) הקיימים ב-Monday.com עם השם וה-id של כל אחד.",
    input_schema: { type: "object", properties: {} },
    requiresConfirmation: false,
    requiredPermission: "view:own_work",
    execute: async () => listBoards(),
  },
  {
    name: "find_monday_board",
    description: "מחפש לוחות ב-Monday.com לפי מילת חיפוש בשם (למשל שם פרויקט/לקוח). מחזיר את כל הלוחות התואמים.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "מילת חיפוש בשם הלוח" } },
      required: ["query"],
    },
    requiresConfirmation: false,
    requiredPermission: "view:own_work",
    execute: async (input: { query: string }) => findBoardsByName(input.query),
  },
  {
    name: "list_monday_tasks",
    description: "מחזיר את רשימת המשימות (items) בלוח מסוים ב-Monday.com.",
    input_schema: {
      type: "object",
      properties: { boardId: { type: "string", description: "מזהה הלוח" } },
      required: ["boardId"],
    },
    requiresConfirmation: false,
    requiredPermission: "view:managed_projects",
    execute: async (input: { boardId: string }) => listTasks(input.boardId),
  },
  {
    name: "list_my_work",
    description:
      "מחזיר תדריך קומפקטי ומתועדף של העבודה של *המשתמש ששואל* להיום: משימות שבאיחור / להיום / השבוע / בעבודה, ואם דל — גם מה שדורש תשומת לב. עד 30 פריטים, כל אחד עם פרויקט/שלב/סטטוס/תעדוף/תאריך/ימי איחור אם רלוונטי, ושדה summary עם הספירות המלאות. להשתמש כשמבקשים 'מה יש לי לעשות', 'המשימות שלי', 'מה על הפרק', 'מה עליי לבצע היום'.",
    input_schema: { type: "object", properties: {} },
    requiresConfirmation: false,
    requiredPermission: "view:own_work",
    execute: async (_input, ctx: ToolContext) => {
      if (!ctx.user) throw new Error("חסר הקשר משתמש — אי אפשר לשלוף 'המשימות שלי' בלי לדעת מי שואל.");
      return getMyWorkBrief(ctx.user);
    },
  },
  {
    name: "create_monday_task",
    description: "יוצר משימה (item) חדשה בלוח מסוים ב-Monday.com.",
    input_schema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "מזהה הלוח שאליו להוסיף את המשימה" },
        itemName: { type: "string", description: "שם המשימה" },
      },
      required: ["boardId", "itemName"],
    },
    requiresConfirmation: false,
    requiredPermission: "task:create",
    execute: async (input: { boardId: string; itemName: string }) => createTask(input.itemName, input.boardId),
  },
  {
    // שלב 3E: domain action אמיתי (לא Monday primitive) — name/description/input_schema מגיעים
    // מה-AgentTool המשותף (source of truth), לא מומצאים כאן. agentTool מקשר ל-registry: אין
    // requiredPermission עצמאי — מגיע במלואו מ-CREATE_TASK_AGENT_TOOL.requiredPermission
    // (ANY-of task:create/task:manage — זהה ל-canCreateTask ב-chat.ts, זהה בתוצאה לשער הקודם
    // "task:create" בלבד עבור כל תפקיד קיים היום: כל תפקיד עם task:manage מחזיק גם task:create
    // ב-roles.ts, ר' audit נפרד). execute מפנה ל-AgentTool בלבד — createTaskAction→ops/actions.ts
    // (authorizeCreateTask, project/stage disambiguation, idempotency), לא Monday ישירות.
    name: CREATE_TASK_AGENT_TOOL.name,
    description: CREATE_TASK_AGENT_TOOL.description,
    input_schema: CREATE_TASK_AGENT_TOOL.input_schema as Anthropic.Tool.InputSchema,
    requiresConfirmation: false,
    agentTool: CREATE_TASK_AGENT_TOOL,
    execute: async (input: Record<string, unknown>, ctx: ToolContext) => {
      const user = requireIdentifiedUser(ctx);
      return CREATE_TASK_AGENT_TOOL.execute(input, { user });
    },
  },
  {
    name: "update_monday_task_status",
    description: "משנה את הסטטוס של משימה קיימת ב-Monday.com (למשל \"הושלם\", \"בתהליך\").",
    input_schema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "מזהה הלוח" },
        itemId: { type: "string", description: "מזהה המשימה" },
        statusLabel: { type: "string", description: "שם הסטטוס החדש (חייב להתאים לאחת האפשרויות הקיימות בלוח)" },
      },
      required: ["boardId", "itemId", "statusLabel"],
    },
    requiresConfirmation: false,
    requiredPermission: "task:update_own",
    execute: async (input: { boardId: string; itemId: string; statusLabel: string }) =>
      updateTaskStatus(input.boardId, input.itemId, input.statusLabel),
  },
  {
    // שלב 3D: domain action אמיתי (לא Monday primitive) — name/description/input_schema מגיעים
    // מה-AgentTool המשותף (source of truth, ר' תחילת הקובץ), לא מומצאים כאן. agentTool מקשר
    // ל-registry: אין requiredPermission עצמאי — מגיע במלואו מ-MARK_DONE_AGENT_TOOL.requiredPermission
    // (סינגלטון task:update_own, בדיוק כמו create_lead ב-Step 3C — אין gate קיים לשמר, אין צמצום).
    // execute מפנה ל-AgentTool בלבד — doUpdateTask→ops/actions.ts→authorize() (ownership/project
    // scope), לא Monday ישירות. source מתורגם מ-list_my_work's "office"/"project" אם צריך
    // (normalizeTaskSource) — רשת ביטחון, לא לוגיקה עסקית.
    name: MARK_DONE_AGENT_TOOL.name,
    description: MARK_DONE_AGENT_TOOL.description,
    input_schema: MARK_DONE_AGENT_TOOL.input_schema as Anthropic.Tool.InputSchema,
    requiresConfirmation: false,
    agentTool: MARK_DONE_AGENT_TOOL,
    execute: async (input: Record<string, unknown>, ctx: ToolContext) => {
      const user = requireIdentifiedUser(ctx);
      return MARK_DONE_AGENT_TOOL.execute(normalizeTaskSource(input), { user });
    },
  },
  {
    // שלב 3D: ראה הערה מעל mark_done — אותו דפוס בדיוק, SET_STATUS_AGENT_TOOL במקום MARK_DONE.
    name: SET_STATUS_AGENT_TOOL.name,
    description: SET_STATUS_AGENT_TOOL.description,
    input_schema: SET_STATUS_AGENT_TOOL.input_schema as Anthropic.Tool.InputSchema,
    requiresConfirmation: false,
    agentTool: SET_STATUS_AGENT_TOOL,
    execute: async (input: Record<string, unknown>, ctx: ToolContext) => {
      const user = requireIdentifiedUser(ctx);
      return SET_STATUS_AGENT_TOOL.execute(normalizeTaskSource(input), { user });
    },
  },
  {
    name: "set_monday_task_due_date",
    description: "קובע תאריך יעד/לביצוע למשימה קיימת ב-Monday.com.",
    input_schema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "מזהה הלוח" },
        itemId: { type: "string", description: "מזהה המשימה" },
        dateISO: { type: "string", description: "תאריך בפורמט YYYY-MM-DD" },
      },
      required: ["boardId", "itemId", "dateISO"],
    },
    requiresConfirmation: false,
    requiredPermission: "task:manage",
    execute: async (input: { boardId: string; itemId: string; dateISO: string }) =>
      setTaskDueDate(input.boardId, input.itemId, input.dateISO),
  },
  {
    name: "delete_monday_task",
    description: "מוחק לצמיתות משימה מ-Monday.com. פעולה הרסנית שאי אפשר לבטל.",
    input_schema: {
      type: "object",
      properties: { itemId: { type: "string", description: "מזהה המשימה למחיקה" } },
      required: ["itemId"],
    },
    requiresConfirmation: true,
    requiredPermission: "task:manage",
    execute: async (input: { itemId: string }) => deleteTask(input.itemId),
  },
  {
    name: "find_monday_user",
    description: "מחפש איש/אשת צוות ב-Monday.com לפי שם (עברית), כדי להקצות אליו/ה משימה.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "שם או חלק משם לחיפוש" } },
      required: ["query"],
    },
    requiresConfirmation: false,
    requiredPermission: "view:own_work",
    execute: async (input: { query: string }) => findUsersByName(input.query),
  },
  {
    name: "assign_monday_task",
    description: "מקצה (או מעביר) משימה ב-Monday.com לאיש צוות מסוים, לפי מזהה משתמש (מ-find_monday_user).",
    input_schema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "מזהה הלוח" },
        itemId: { type: "string", description: "מזהה המשימה" },
        userId: { type: "string", description: "מזהה המשתמש להקצאה" },
      },
      required: ["boardId", "itemId", "userId"],
    },
    requiresConfirmation: false,
    requiredPermission: "task:manage",
    execute: async (input: { boardId: string; itemId: string; userId: string }) =>
      assignTask(input.boardId, input.itemId, input.userId),
  },
  {
    // שלב 3B: שם/description/input_schema זהים ל-WhatsApp model שכבר מכיר (אפס שינוי prompt) —
    // רק ה-execute עובר ל-shared AgentTool. label (שדה אופציונלי קיים ב-AGENT_TOOLS's add_update,
    // משמש רק ל-actions.push התצוגתי ב-chat.ts) לא נחשף כאן בכוונה — WhatsApp לא שלח אותו קודם
    // ואינו צריך אותו לשום דבר ב-execute עצמו (addUpdateToItem לא קורא אותו בכלל).
    name: "add_monday_update",
    description: "מוסיף תגובה/הערה (Update) לפריט קיים ב-Monday.com.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "מזהה הפריט" },
        body: { type: "string", description: "תוכן התגובה" },
      },
      required: ["itemId", "body"],
    },
    requiresConfirmation: false,
    // דיון נוסף (audit Step 3B — "אל תרחיב capability surface בשקט"): requiredPermission נשאר
    // "task:update_own" בכוונה — אותו gate בדיוק כמו לפני המעבר ל-shared AgentTool. ל-
    // addUpdateToItem (ops/actions.ts) יש ANY-of עשיר יותר (5 הרשאות) — זה *נשאר* כהגנה נוספת
    // בתוך ה-business action המשותף, בלי שינוי. אבל ה-gate החיצוני הזה (visibility + execution-
    // time pre-check ב-orchestrator.ts's canUseTool) הוא מה ש-WhatsApp חשף/אכף *לפני* המעבר —
    // הרחבתו ל-ANY-of (ע"י השמטתו) הייתה משנה בשקט מי יכול להשתמש בכלי הזה דרך WhatsApp
    // (בפועל: תפקיד finance, אם יקבל אי-פעם WhatsApp JID — היום אין לו), גם אם זה "תקין" לפי
    // המדיניות העסקית של add_update עצמו. שלב 3B הוא migration של execution, לא הרחבת capability
    // surface — minimum behavioral change. אם בעתיד יוחלט במפורש להרחיב את ה-gate הזה (או
    // להסירו) — זו החלטה נפרדת, לא side-effect של ה-wiring.
    //
    // שלב 3C: agentTool מקשר לכלי המשותף — ה-ANY-of שלו (5 הרשאות) הוא עכשיו ה-source of truth
    // הרשום, ו-requiredPermission כאן הוא צמצום *נבדק* שלו (startup assertion: subset-of), לא
    // רשימה עצמאית שרק קורה להסכים איתו. ההתנהגות בפועל לא השתנתה.
    requiredPermission: "task:update_own",
    agentTool: ADD_UPDATE_AGENT_TOOL,
    execute: async (input: Record<string, unknown>, ctx: ToolContext) => {
      const user = requireIdentifiedUser(ctx);
      return ADD_UPDATE_AGENT_TOOL.execute(input, { user });
    },
  },
  {
    // שלב 3B: שם/description/input_schema זהים ל-WhatsApp model שכבר מכיר. AGENT_TOOLS's
    // create_lead מוסיף שדה assignee אופציונלי שלא נחשף כאן — WhatsApp לא שולח אותו, כך
    // שה-ברירת-מחדל של createLeadAction (אחראי = היוצר) חלה אוטומטית. זה שינוי התנהגות מכוון
    // (ר' audit Step 3B §H) — לא bypass: היוצר יסומן כאחראי/ת, מה שלא קרה קודם ב-create_lead
    // הישן (tools.ts's createLead() לא קיבל assigneeId בכלל, אז ליד נוצר תמיד בלי אחראי).
    name: "create_lead",
    description:
      "פותח ליד חדש (לקוח פוטנציאלי) בלוח \"לידים 💰\" ב-Monday.com, עם פרטי הקשר ומקור ההגעה.",
    input_schema: {
      type: "object",
      properties: {
        firstName: { type: "string", description: "שם פרטי" },
        lastName: { type: "string", description: "שם משפחה" },
        phone: { type: "string", description: "מספר טלפון/נייד" },
        email: { type: "string", description: "כתובת מייל" },
        source: { type: "string", enum: [...LEAD_SOURCE_OPTIONS], description: "מקור הגעת הליד" },
        product: { type: "string", enum: [...LEAD_PRODUCT_OPTIONS], description: "תחום העניין / סוג השירות" },
        referredBy: { type: "string", description: "שם הממליץ/מפנה הליד, אם רלוונטי" },
      },
      required: ["firstName"],
    },
    requiresConfirmation: false,
    // שלב 3C: אין requiredPermission עצמאי כאן בכוונה — הכלי מגובה במלואו ב-AgentTool (למטה),
    // וה-ANY-of שלו (כיום הסינגלטון ["lead:manage"]) הוא ה-source of truth המלא, לא קירוב שלו.
    // תוצאה בפועל זהה למה שהיה (לפני: requiredPermission="lead:manage" כאן; גם זה "lead:manage"
    // בלבד) — אבל עכשיו יש רק מקום אחד שמחזיק את ההרשאה הזו, לא שניים שצריך לשמור מסונכרנים.
    agentTool: CREATE_LEAD_AGENT_TOOL,
    execute: async (input: Record<string, unknown>, ctx: ToolContext) => {
      const user = requireIdentifiedUser(ctx);
      return CREATE_LEAD_AGENT_TOOL.execute(input, { user });
    },
  },
  {
    name: "list_calendar_events",
    description: "מחזיר אירועים קיימים ביומן Google בטווח זמן נתון (למשל \"מה יש לי היום/השבוע\").",
    input_schema: {
      type: "object",
      properties: {
        timeMinISO: { type: "string", description: "תחילת הטווח, ISO 8601, למשל 2026-08-17T00:00:00" },
        timeMaxISO: { type: "string", description: "סוף הטווח, ISO 8601, למשל 2026-08-18T00:00:00" },
      },
      required: ["timeMinISO", "timeMaxISO"],
    },
    requiresConfirmation: false,
    requiredPermission: "view:own_work",
    execute: async (input: { timeMinISO: string; timeMaxISO: string }) => listCalendarEvents(input),
  },
  {
    name: "create_calendar_event",
    description:
      "יוצר אירוע ביומן Google ושולח זימון למשתתפים (אם צוינו כתובות מייל). פעולה גלויה למשתתפים.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "כותרת האירוע" },
        description: { type: "string", description: "תיאור האירוע" },
        startISO: { type: "string", description: "זמן התחלה בפורמט ISO 8601, למשל 2026-08-20T10:00:00" },
        endISO: { type: "string", description: "זמן סיום בפורמט ISO 8601" },
        attendeeEmails: {
          type: "array",
          items: { type: "string" },
          description: "כתובות מייל של המשתתפים שיקבלו זימון",
        },
      },
      required: ["summary", "startISO", "endISO"],
    },
    requiresConfirmation: true,
    requiredPermission: "task:manage",
    execute: async (input: {
      summary: string;
      description?: string;
      startISO: string;
      endISO: string;
      attendeeEmails?: string[];
    }) => createCalendarEvent(input),
  },
  {
    name: "update_calendar_event",
    description:
      "מעדכן אירוע קיים ביומן Google (כותרת/זמן/משתתפים). שולח עדכון למשתתפים הקיימים אם יש. פעולה גלויה למשתתפים.",
    input_schema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "מזהה האירוע (מ-list_calendar_events)" },
        summary: { type: "string", description: "כותרת חדשה" },
        description: { type: "string", description: "תיאור חדש" },
        startISO: { type: "string", description: "זמן התחלה חדש, ISO 8601" },
        endISO: { type: "string", description: "זמן סיום חדש, ISO 8601" },
        attendeeEmails: { type: "array", items: { type: "string" }, description: "רשימת משתתפים מעודכנת" },
      },
      required: ["eventId"],
    },
    requiresConfirmation: true,
    requiredPermission: "task:manage",
    execute: async (input: UpdateEventInput) => updateCalendarEvent(input),
  },
  {
    name: "delete_calendar_event",
    description: "מוחק אירוע מיומן Google ושולח ביטול למשתתפים. פעולה הרסנית וגלויה למשתתפים.",
    input_schema: {
      type: "object",
      properties: { eventId: { type: "string", description: "מזהה האירוע (מ-list_calendar_events)" } },
      required: ["eventId"],
    },
    requiresConfirmation: true,
    requiredPermission: "task:manage",
    execute: async (input: { eventId: string }) => deleteCalendarEvent(input.eventId),
  },
  {
    name: "send_meeting_summary_email",
    description: "שולח מייל (למשל סיכום פגישה) לכתובת אחת או יותר. פעולה גלויה לנמענים.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "כתובות מייל של הנמענים" },
        subject: { type: "string", description: "נושא המייל" },
        text: { type: "string", description: "תוכן המייל" },
      },
      required: ["to", "subject", "text"],
    },
    requiresConfirmation: true,
    requiredPermission: "client:communicate",
    execute: async (input: { to: string[]; subject: string; text: string }) =>
      sendEmail({ to: input.to, subject: input.subject, text: input.text }),
  },
];

// שלב 3C (2026-10-07): לכל כלי עם agentTool + requiredPermission מוצהר — requiredPermission חייב
// להיות subset של ה-ANY-of של ה-AgentTool המגובה. נבדק בעליית המודול (לא בשקט באמצע שיחה) כדי
// שאף אחד לא "יצמצם" בטעות להרשאה שה-AgentTool (מקור האמת העסקי) לא מכיר בכלל.
for (const t of tools) {
  if (t.agentTool && t.requiredPermission && !t.agentTool.requiredPermission.includes(t.requiredPermission)) {
    throw new Error(
      `כלי '${t.name}': requiredPermission='${t.requiredPermission}' אינו חלק מה-ANY-of של ה-AgentTool ` +
        `המגובה '${t.agentTool.name}' (${t.agentTool.requiredPermission.join(",")}) — חיווט הרשאות שגוי.`,
    );
  }
}

/**
 * מקור האמת היחיד לקביעת "האם המשתמש רשאי להשתמש בכלי הזה" — משמש גם לחשיפה (toAnthropicTools)
 * וגם לאכיפה לפני הרצה (orchestrator.ts's canUseTool), כדי שלא יהיו שתי השוואות נפרדות שרק
 * "קורה" להן להסכים. כלי המגובה ב-agentTool (שלב 3C): ה-ANY-of שלו הוא ה-source of truth —
 * requiredPermission כאן, אם מוגדר, מצמצם אליו (נבדק subset למעלה); אם לא מוגדר, ה-ANY-of המלא
 * של ה-AgentTool חל. כלי בלי agentTool: בדיוק ההתנהגות הקודמת (requiredPermission בודד, או תמיד
 * מורשה אם לא מוגדר).
 */
export function isToolAllowedForUser(tool: ToolDefinition, user: IdentifiedUser | null): boolean {
  if (tool.agentTool) {
    const allowedPermissions: Permission[] = tool.requiredPermission
      ? [tool.requiredPermission]
      : tool.agentTool.requiredPermission;
    return user ? allowedPermissions.some((p) => user.permissions.includes(p)) : false;
  }
  if (!tool.requiredPermission) return true;
  return user ? user.permissions.includes(tool.requiredPermission) : false;
}

/**
 * מחזיר את הכלים שה-AI רשאי להשתמש בהם עבור המשתמש הנתון — כדי שלא יציע פעולה שתיחסם ממילא.
 * - אובייקט משתמש → מסונן להרשאותיו.
 * - null → משתמש לא מזוהה, אין כלים בכלל.
 * - undefined (הושמט) → הקשר פנימי/רקע מהימן, כל הכלים.
 * האכיפה הסופית ב-orchestrator לפני הרצה בפועל.
 */
export function toAnthropicTools(user?: IdentifiedUser | null): Anthropic.Tool[] {
  let allowed: ToolDefinition[];
  if (user === undefined) {
    allowed = tools;
  } else if (user === null) {
    allowed = [];
  } else {
    allowed = tools.filter((t) => isToolAllowedForUser(t, user));
  }
  return allowed.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}
