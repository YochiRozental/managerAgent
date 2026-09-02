import type Anthropic from "@anthropic-ai/sdk";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
  type UpdateEventInput,
} from "../google/calendar.js";
import { sendEmail } from "../google/gmail.js";
import { createLead, LEAD_PRODUCT_OPTIONS, LEAD_SOURCE_OPTIONS, type CreateLeadInput } from "../monday/leads.js";
import {
  addUpdate,
  assignTask,
  createTask,
  deleteTask,
  findBoardsByName,
  listBoards,
  listMyWork,
  listTasks,
  setTaskDueDate,
  updateTaskStatus,
} from "../monday/tasks.js";
import { findUsersByName } from "../monday/users.js";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  /** Visible to others / hard to undo — must be confirmed by the user before executing (wired in M7). */
  requiresConfirmation: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any) => Promise<unknown>;
}

export const tools: ToolDefinition[] = [
  {
    name: "list_monday_boards",
    description: "מחזיר את כל הלוחות (boards) הקיימים ב-Monday.com עם השם וה-id של כל אחד.",
    input_schema: { type: "object", properties: {} },
    requiresConfirmation: false,
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
    execute: async (input: { boardId: string }) => listTasks(input.boardId),
  },
  {
    name: "list_my_work",
    description:
      "מחזיר את כל המשימות הפתוחות (לא 'בוצע') שמוקצות למשתמש (בעל חשבון ה-API) בלוח המשימות הראשי ותתי-הפריטים שלו - מקביל לתצוגת 'המשימות שלי' (My Work) במאנדיי, אך ממוקד רק במשימות אמיתיות (לא בלוחות לקוחות/עסקאות/לידים, ששם 'אחראי' פירושו בעלים ולא משימה). כל משימה כוללת סטטוס ותאריך יעד אם קיימים, ממוין לפי תאריך יעד. להשתמש כשמבקשים 'מה יש לי לעשות', 'המשימות שלי', 'מה על הפרק' וכדומה.",
    input_schema: { type: "object", properties: {} },
    requiresConfirmation: false,
    execute: async () => listMyWork(),
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
    execute: async (input: { boardId: string; itemName: string }) => createTask(input.itemName, input.boardId),
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
    execute: async (input: { boardId: string; itemId: string; statusLabel: string }) =>
      updateTaskStatus(input.boardId, input.itemId, input.statusLabel),
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
    execute: async (input: { boardId: string; itemId: string; userId: string }) =>
      assignTask(input.boardId, input.itemId, input.userId),
  },
  {
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
    execute: async (input: { itemId: string; body: string }) => addUpdate(input.itemId, input.body),
  },
  {
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
    execute: async (input: CreateLeadInput) => createLead(input),
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
    execute: async (input: { to: string[]; subject: string; text: string }) =>
      sendEmail({ to: input.to, subject: input.subject, text: input.text }),
  },
];

export function toAnthropicTools(): Anthropic.Tool[] {
  return tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}
