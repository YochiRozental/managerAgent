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
import type { IdentifiedUser } from "../../identity/index.js";
import {
  isToolAllowedForUser,
  requireIdentifiedUser,
  type ToolContext,
  type ToolDefinition,
} from "../../ai/toolRegistry.js";
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
import { buildSharedToolDefinition, requireAgentTool } from "../../ai/sharedTools.js";

/**
 * שלב 3F.2 (2026-10-07): ToolContext/ToolDefinition/isToolAllowedForUser הועברו ל-src/ai/
 * toolRegistry.ts — מושגים channel-independent, לא רק WhatsApp (ר' docstring שם). מיוצאים
 * מחדש כאן (ללא שינוי שם/חתימה) כי כל הקוד הקיים (כולל בדיקות) מייבא אותם מ-"./tools.js".
 */
export type { ToolContext, ToolDefinition };
export { isToolAllowedForUser, requireIdentifiedUser };

/**
 * Step 3F.6 (2026-10-07): requireAgentTool הועבר ל-src/ai/sharedTools.ts (היה כאן ובקובץ המקביל
 * ops/chat.ts כשתי פונקציות זהות מילה-במילה עד שם הערוץ בהודעת השגיאה) — מיובא ולא מוגדר מחדש.
 * מיוצאים כדי שבדיקות (test-whatsapp-agent-tools.ts) יוכיחו === מול AGENT_TOOLS — אותו אובייקט
 * שגם ops/chat.ts (Web) משתמש בו, לא עותק.
 */
export const ADD_UPDATE_AGENT_TOOL = requireAgentTool("add_update", "WhatsApp");
export const CREATE_LEAD_AGENT_TOOL = requireAgentTool("create_lead", "WhatsApp");
/**
 * שלב 3D (2026-10-07) — domain actions אמיתיים של מערכת המשימות (לא Monday primitive גנרי
 * כמו update_monday_task_status, ר' docstring בראש הקובץ). update_monday_task_status *נשאר*
 * ללא שינוי כ-legacy fallback (בורדים שאינם משימות משרד/שלבי פרויקט) — ר' audit נפרד.
 */
export const MARK_DONE_AGENT_TOOL = requireAgentTool("mark_done", "WhatsApp");
export const SET_STATUS_AGENT_TOOL = requireAgentTool("set_status", "WhatsApp");
/**
 * שלב 3E (2026-10-07) — אותו דפוס בדיוק: create_monday_task הוא Monday primitive גנרי
 * (boardId+itemName כלשהם, בלי assignee/project/stage/date/priority/idempotency/scope) ולא
 * equivalent סמנטי ל-create_task (domain action מלא עם authorizeCreateTask/project+stage
 * disambiguation/idempotency). create_monday_task *נשאר* ללא שינוי כ-legacy fallback לבורדים
 * שאינם משימות משרד/שלבי פרויקט — ר' audit נפרד.
 */
export const CREATE_TASK_AGENT_TOOL = requireAgentTool("create_task", "WhatsApp");

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
  // שלב 3E, עודכן 3F.6: domain action אמיתי (לא Monday primitive) — name/description/input_schema
  // מגיעים מה-AgentTool המשותף (source of truth), ללא projection (WhatsApp חושף את ה-AgentTool
  // "כמו שהוא", בדיוק כמו לפני 3F.6). אין requiredPermission עצמאי — ה-ANY-of task:create/
  // task:manage המלא חל (זהה ל-canCreateTask ב-chat.ts). buildSharedToolDefinition (src/ai/
  // sharedTools.ts) בונה את ה-wrapper — לא יד, לא עוד implementation כפול מול ops/chat.ts's
  // CREATE_TASK_TOOL_DEFINITION. execute מפנה ל-AgentTool בלבד — createTaskAction→ops/actions.ts
  // (authorizeCreateTask, project/stage disambiguation, idempotency), לא Monday ישירות.
  buildSharedToolDefinition(CREATE_TASK_AGENT_TOOL),
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
  // שלב 3D, עודכן 3F.6: domain action אמיתי — name/description/input_schema מגיעים מה-AgentTool
  // המשותף, ללא projection. אין requiredPermission עצמאי — הסינגלטון task:update_own חל. ה-
  // transformInput projection (normalizeTaskSource — list_my_work's "office"/"project" display
  // labels → "general"/"project_stage", ר' docstring מעל normalizeTaskSource) הוא ההבדל המכוון
  // היחיד מול ops/chat.ts's MARK_DONE_TOOL_DEFINITION — Web לא צריך אותו (אין לו list_my_work).
  buildSharedToolDefinition(MARK_DONE_AGENT_TOOL, { transformInput: normalizeTaskSource }),
  // אותו דפוס בדיוק, SET_STATUS_AGENT_TOOL במקום MARK_DONE.
  buildSharedToolDefinition(SET_STATUS_AGENT_TOOL, { transformInput: normalizeTaskSource }),
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
  // שלב 3B/3C, עודכן 3F.6: name/description/input_schema נשארים ה-WhatsApp projection שהמודל כבר
  // מכיר (אפס שינוי prompt) — לא ה-AgentTool's own values. label (שדה אופציונלי קיים ב-AGENT_
  // TOOLS's add_update, משמש רק ל-actions.push התצוגתי ב-chat.ts) לא נחשף כאן בכוונה — WhatsApp
  // לא שלח אותו קודם ואינו צריך אותו (addUpdateToItem לא קורא אותו בכלל). requiredPermission
  // נשאר "task:update_own" בכוונה (audit Step 3B — "אל תרחיב capability surface בשקט"): אותו
  // gate בדיוק כמו לפני המעבר ל-shared AgentTool, למרות ש-addUpdateToItem (ops/actions.ts) עצמה
  // אוכפת ANY-of עשיר יותר (5 הרשאות) כהגנה נוספת, בלי שינוי. buildSharedToolDefinition's
  // projection מבטא את שלושת ההבדלים האלה (name/description/input_schema/requiredPermission)
  // באופן מוצהר — לא implementation כפול מול ops/chat.ts's ADD_UPDATE_TOOL_DEFINITION (בלי
  // projection, ANY-of מלא).
  buildSharedToolDefinition(ADD_UPDATE_AGENT_TOOL, {
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
    requiredPermission: "task:update_own",
  }),
  // שלב 3B/3C, עודכן 3F.6: name/description/input_schema נשארים ה-WhatsApp projection (7 שדות,
  // בלי assignee — ה-contract שהמודל כבר מכיר; Web חושף את כל 8 שדות ה-AgentTool, ר' ops/chat.ts's
  // CREATE_LEAD_TOOL_DEFINITION, בלי projection). אין requiredPermission עצמאי — ה-ANY-of המלא
  // (סינגלטון ["lead:manage"]) חל, בדיוק כמו קודם.
  buildSharedToolDefinition(CREATE_LEAD_AGENT_TOOL, {
    description: "פותח ליד חדש (לקוח פוטנציאלי) בלוח \"לידים 💰\" ב-Monday.com, עם פרטי הקשר ומקור ההגעה.",
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
  }),
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
 * מחזיר את הכלים שה-AI רשאי להשתמש בהם עבור המשתמש הנתון — כדי שלא יציע פעולה שתיחסם ממילא.
 * - אובייקט משתמש → מסונן להרשאותיו.
 * - null → משתמש לא מזוהה, אין כלים בכלל.
 * - undefined (הושמט) → הקשר פנימי/רקע מהימן, כל הכלים.
 * האכיפה הסופית ב-orchestrator לפני הרצה בפועל. ה-cast ל-Anthropic.Tool כאן (שלב 3F.2) הוא
 * הגבול היחיד שבאמת צריך את הצורה הספציפית-ל-Anthropic — ToolDefinition.input_schema עצמו
 * כללי (Record<string,unknown>, ר' toolRegistry.ts), ו-runOrchestrator ממיר את זה בכל מקרה
 * ל-NormTool הניטרלי מיד אחרי הקריאה לכאן.
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
  return allowed.map(({ name, description, input_schema }) => ({ name, description, input_schema }) as Anthropic.Tool);
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}
