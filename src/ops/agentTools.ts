/**
 * AgentTool — תשתית משותפת ל-Web Chat ו-WhatsApp (תוכנית איחוד Web/WhatsApp, החל מ-2026-09-24).
 *
 * שלבים 2A/2C/2D/2E (2026-10-05): create_task, create_lead, mark_done, set_status, add_note,
 * report_blocker, add_update, create_project_stage — כולם מחוברים בפועל ל-Web. chat.ts מייבא
 * את ה-AgentTool של כל אחד מכאן ועוטף אותו ב-adapter דק (run → execute, פלוס actions.push/
 * refresh() הספציפיים לצ'אט). נשאר רק `reassign_item` **שעדיין לא** מחובר (ממתין לשלב נפרד).
 *
 * כל AgentTool כאן עוטף ישירות פונקציה קיימת ונבדקת ב-ops/actions.ts (מקור האמת לפעולות כתיבה
 * עסקיות — ר' Source of Truth Map ב-audit 2026-09-24) — אין כאן שום לוגיקה עסקית חדשה.
 *
 * הקובץ הזה **לא מייבא מ-ops/chat.ts בכוונה** (גם לא CREATE_TASK_TOOL_DECL/
 * CREATE_PROJECT_STAGE_TOOL_DECL), כדי לא ליצור import מעגלי ברגע ש-chat.ts כן מייבא מכאן —
 * import מעגלי כזה (chat.ts → agentTools.ts → chat.ts) היה שובר את עליית השרת: ESM מאכפת
 * TDZ על `const` exports גם מעבר ל-cycle, ו-buildAgentTools() כאן רץ בזמן טעינת המודול, לפני
 * שה-const-ים ב-chat.ts היו מאותחלים. **CREATE_TASK_TOOL_DECL ו-CREATE_PROJECT_STAGE_TOOL_DECL
 * הועברו לכאן פיזית** (מקור האמת היחיד מעכשיו) ו-chat.ts מייצא את שניהם מחדש
 * (`export { X } from "./agentTools.js"`) כדי שבדיקות קיימות שמייבאות אותם מ-"../src/ops/chat.js"
 * (test-create-task-prompt.ts, test-create-task-behavior.ts, test-project-stage-behavior.ts)
 * ימשיכו לעבוד בלי שינוי.
 *
 * requiredPermission הוא מערך (ANY-of), לא הרשאה בודדת — כי כמה כלים ב-chat.ts נחשפים היום לפי
 * תנאי "או" בין כמה הרשאות (למשל reassign_item: task:manage || lead:manage || project:manage,
 * ר' ops/chat.ts). מערך משמר את התנאי האמיתי בלי לכווץ אותו לבדיקה בודדת ובלי להמציא הרשאה
 * חדשה שלא קיימת ב-identity/roles.ts.
 *
 * דפוס ה-deps (BuildAgentToolsDeps) זהה בכוונה לדפוס שכבר קיים בכל רחבי ops/actions.ts
 * (CreateTaskDeps / UpdateTaskDeps / ReassignItemDeps וכו') — לא מומצא כאן, רק מוחל גם על
 * שכבת ה-registry: מאפשר לבדוק ש-execute מפנה לפונקציה הנכונה בלי לגעת ב-Monday האמיתי.
 */

import type { IdentifiedUser, Permission } from "../identity/index.js";
import { userCan } from "../identity/index.js";
import type { OpsTaskSource } from "../integrations/monday/opsRead.js";
import { LEAD_PRODUCT_OPTIONS, LEAD_SOURCE_OPTIONS } from "../integrations/monday/leads.js";
import {
  addUpdateToItem,
  createLeadAction,
  createProjectStageAction,
  createTaskAction,
  reassignItem,
  updateTask,
  type CreateLeadActionInput,
  type CreateLeadResult,
  type CreateProjectStageActionInput,
  type CreateProjectStageActionResult,
  type CreateTaskInput,
  type CreateTaskResult,
  type TaskUpdateInput,
} from "./actions.js";

/**
 * מקור האמת ל-create_task — עבר לכאן מ-ops/chat.ts ב-2026-10-05 (שלב 2A). התוכן (name/
 * description/input_schema) לא שונה אות אחת לעומת המקור — רק מיקומו. taskName חייב להגיע
 * מהמשתמש בפועל — ר' האירוע מ-2026-09-22: "תיצור לרוחי משימה" (בלי המשך) גרם למודל למלא
 * taskName="משימה חדשה" כדי לספק שדה חובה, במקום לשאול. אין לזה ברירת מחדל הגיונית (בשונה
 * מ-project/stage/assignee/dueDate/priority), אז זה מנוסח גם כאן וגם ב-ops/chat.ts's
 * systemPrompt בכוונה — גם ב-tool schema וגם בהוראה מפורשת.
 */
export const CREATE_TASK_TOOL_DECL = {
  name: "create_task",
  description:
    "פותח משימה חדשה ב-Monday. שלושה סוגי יצירה: (1) בלי project — משימה כללית בלוח המשימות, בלי שום קישור, נוצרת מיד. (2) עם project ו-taskKind='project' — item באותו לוח, אבל *עם* קישור (project relation) לפרויקט; לא subitem, לא שלב. נבחר רק כשהמשתמש ביקש 'לקשר' את המשימה לפרויקט — לא כשהוא אמר 'תחת' (זו מילת היררכיה, לא קישור — ר' taskKind). (3) עם project ו-stage מפורש (או taskKind='stage') — subitem תחת השלב; זה מה שמילת 'תחת' מתארת (Project→Stage→Task). כש-project ניתן בלי stage מפורש צריך גם taskKind כדי לדעת אם מדובר ב-(2) או ב-(3); בלי אף אחד מהשניים הכלי יזרוק שגיאה עם השאלה שצריך לשאול את המשתמש — זה תקין ומצופה, לא כשל. חובה: אם ניתן project, הוא חייב להינתן *בכל קריאה* שעוסקת באותה משימה, כולל קריאות המשך אחרי ששאלת taskKind/stage — אחרת המשימה עלולה להיווצר בלי הקישור לפרויקט. בלי assignee — מוקצית למשתמש עצמו. חובה שיהיה taskName אמיתי לפני הקריאה — אל תקרא לכלי הזה כדי 'לבדוק' מה קורה בלי תוכן משימה אמיתי.",
  input_schema: {
    type: "object",
    properties: {
      taskName: {
        type: "string",
        description:
          "תוכן המשימה בפועל (מה צריך לעשות), בדיוק כמו שהמשתמש תיאר — לא כותרת פורמלית נפרדת. חובה שיגיע מהמשתמש בעצמו. אם המשתמש ביקש ליצור משימה בלי לומר מה היא — אל תמלא כאן ערך מומצא/placeholder (כמו 'משימה חדשה', 'משימה', 'ללא שם', 'משימה כללית') ואל תקרא לכלי הזה בכלל; שאל את המשתמש מה המשימה לפני שאתה קורא לכלי.",
      },
      project: {
        type: "string",
        description:
          "שם הפרויקט, אם המשימה קשורה לפרויקט כלשהו. השמט למשימה כללית שלא קשורה לשום פרויקט. חשוב: אם צוין פרויקט בהודעה כלשהי בשיחה — חובה להעביר אותו כאן **בכל קריאה עוקבת** שעוסקת באותה משימה (כולל אחרי ששאלת taskKind/stage), לא רק בקריאה הראשונה שבה הוא הוזכר.",
      },
      taskKind: {
        type: "string",
        enum: ["project", "stage"],
        description:
          "רק כש-project ניתן וגם stage לא ניתן מפורש. **חשוב — שתי מילים שונות לגמרי בעברית:** 'תחת' (כמו 'תחת הפרויקט', 'תחת שלב') היא מילת **היררכיה** (Project→Stage→Task) ותמיד אומרת 'stage', לעולם לא 'project'. 'מקושר/לקשר לפרויקט' היא מילת **קישור/relation** ואומרת 'project'. 'project' = item בלוח המשימות הכלליות עם project relation (לא subitem, לא שלב) — רק כשהמשתמש ביקש 'לקשר'/'קישור' במפורש. 'stage' = subitem תחת אחד משלבי הפרויקט — זה מה ש'תחת הפרויקט'/'תחת שלב' מתארים, גם בלי שם שלב ספציפי. אל תמלא לבד — זו החלטה עסקית של המשתמש: אם לא ברור מהניסוח (אין 'תחת' ואין 'לקשר'), אל תקרא לכלי, שאל 'האם לקשר את המשימה לפרויקט, או ליצור אותה תחת אחד משלבי הפרויקט?' וחכה לתשובה.",
      },
      stage: {
        type: "string",
        description:
          "שם/מספר השלב בפרויקט. תן ערך כאן רק אם העובד ציין שלב במפורש בהודעה (כולל בתשובה לשאלה 'באיזה שלב?') — אז זה מכריע בלי צורך ב-taskKind. אחרת השמט; אל תנחש שלב ואל תבחר את 'השלב הפעיל' לבד.",
      },
      assignee: { type: "string", description: "שם העובד/ת שיבצע/תבצע את המשימה. השמט כדי להקצות למשתמש עצמו." },
      dueDate: { type: "string", description: "תאריך יעד בפורמט YYYY-MM-DD, אם ניתן תאריך." },
      priority: { type: "string", description: "תעדוף — רק אם העובד ציין במפורש (למשל 'קריטי', 'דחוף'). אחרת השמט." },
    },
    required: ["taskName"],
  },
};

/**
 * מקור האמת ל-create_project_stage — עבר לכאן מ-ops/chat.ts ב-2026-10-05 (שלב 2E), באותה סיבה
 * בדיוק כמו CREATE_TASK_TOOL_DECL (2A): כך ש-agentTools.ts לא יהיה תלוי ב-chat.ts. התוכן לא
 * שונה אות אחת — אומת byte-for-byte לפני ההעברה (ר' audit 2026-10-05). chat.ts מייצא אותו
 * מחדש כדי ש-test-project-stage-behavior.ts (שמייבא אותו מ-"../src/ops/chat.js") ימשיך לעבוד.
 */
export const CREATE_PROJECT_STAGE_TOOL_DECL = {
  name: "create_project_stage",
  description:
    "יוצר שלב חדש (לא משימה!) בתוך פרויקט — item עצמאי בבורד השלבים של הפרויקט, לא subitem/task. השתמש בזה רק כשהמשתמש ביקש להוסיף/לפתוח 'שלב' חדש במפורש (למשל 'תוסיף שלב חדש בשם X', 'תעשה את זה שלב', 'תוסיף את זה בתור עוד שלב') — לא לבקשת 'משימה'/'task' רגילה (זה create_task). אם המשתמש התחיל לתאר משימה ואז אמר במפורש שזה שלב — הכוונה האחרונה גוברת: קרא create_project_stage, לא create_task. חובה project ו-name אמיתיים; אם אחד מהם לא ברור מההודעה/מההקשר שנשמר בשיחה — אל תקרא לכלי, שאל.",
  input_schema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "שם הפרויקט שאליו מוסיפים את השלב. אם לא ברור/לא נאמר — אל תנחש, שאל.",
      },
      name: {
        type: "string",
        description: "שם השלב החדש, כפי שהמשתמש תיאר. חובה שיגיע מהמשתמש — אל תמציא/תשלים לבד.",
      },
    },
    required: ["project", "name"],
  },
};

export interface AgentToolContext {
  user: IdentifiedUser;
}

export interface AgentTool<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  /** שם השדה (snake_case) תואם בכוונה למוסכמה הקיימת בפועל בשני הצדדים היום —
   *  Anthropic.Tool.InputSchema (integrations/claude/tools.ts) ו-ToolDef.input_schema (ops/chat.ts). */
  input_schema: Record<string, unknown>;
  requiredPermission: Permission[];
  execute: (input: TInput, ctx: AgentToolContext) => Promise<unknown>;
}

/** true אם למשתמש יש לפחות אחת מההרשאות הנדרשות (ANY-of) — אותו תנאי שכבר קיים inline בכל chat.ts. */
export function userCanUseAgentTool(user: IdentifiedUser, tool: AgentTool): boolean {
  return tool.requiredPermission.some((p) => userCan(user, p));
}

export interface BuildAgentToolsDeps {
  createTaskAction?: typeof createTaskAction;
  updateTask?: typeof updateTask;
  reassignItem?: typeof reassignItem;
  createLeadAction?: typeof createLeadAction;
  createProjectStageAction?: typeof createProjectStageAction;
  addUpdateToItem?: typeof addUpdateToItem;
}

/**
 * בונה את רשימת ה-AgentTool. deps ניתנים להזרקה (בדיוק כמו כל פונקציית action ב-ops/actions.ts)
 * כדי שבדיקות יוכלו לוודא "execute מפנה לפונקציה הנכונה" בלי לגעת ב-Monday האמיתי — ברירת המחדל
 * (כשלא מוזרק כלום) היא תמיד הפונקציות האמיתיות מ-ops/actions.ts.
 */
export function buildAgentTools(deps: BuildAgentToolsDeps = {}): AgentTool[] {
  const doCreateTaskAction = deps.createTaskAction ?? createTaskAction;
  const doUpdateTask = deps.updateTask ?? updateTask;
  const doReassignItem = deps.reassignItem ?? reassignItem;
  const doCreateLeadAction = deps.createLeadAction ?? createLeadAction;
  const doCreateProjectStageAction = deps.createProjectStageAction ?? createProjectStageAction;
  const doAddUpdateToItem = deps.addUpdateToItem ?? addUpdateToItem;

  const tools: AgentTool[] = [
    {
      // CREATE_TASK_TOOL_DECL מוגדר ממש למעלה בקובץ הזה — מקור האמת היחיד (ר' docstring בראש הקובץ).
      ...CREATE_TASK_TOOL_DECL,
      // canCreateTask(user) ב-chat.ts = task:create || task:manage.
      requiredPermission: ["task:create", "task:manage"],
      execute: async (input: Record<string, unknown>, ctx) => {
        const taskKind = input.taskKind === "project" || input.taskKind === "stage" ? input.taskKind : undefined;
        const taskInput: CreateTaskInput = {
          taskName: String(input.taskName ?? ""),
          project: input.project ? String(input.project) : undefined,
          taskKind,
          stage: input.stage ? String(input.stage) : undefined,
          assignee: input.assignee ? String(input.assignee) : undefined,
          dueDate: input.dueDate ? String(input.dueDate) : undefined,
          priority: input.priority ? String(input.priority) : undefined,
        };
        const result: CreateTaskResult = await doCreateTaskAction(ctx.user, taskInput);
        return result;
      },
    },
    {
      // CREATE_PROJECT_STAGE_TOOL_DECL מוגדר ממש למעלה בקובץ הזה — מקור האמת היחיד (שלב 2E).
      ...CREATE_PROJECT_STAGE_TOOL_DECL,
      // canManageProjectStages(user) ב-chat.ts = project:manage.
      requiredPermission: ["project:manage"],
      execute: async (input: Record<string, unknown>, ctx) => {
        const stageInput: CreateProjectStageActionInput = {
          project: String(input.project ?? ""),
          stageName: String(input.name ?? ""),
        };
        const result: CreateProjectStageActionResult = await doCreateProjectStageAction(ctx.user, stageInput);
        return result;
      },
    },
    {
      // הסכמה הבאה ואילך: העתק מדויק של ה-inline tool defs בתוך runOpsChat (ops/chat.ts) —
      // לא מיוצאות משם היום כקבועים, לכן הועתקו כאן מילה במילה (ר' docstring בראש הקובץ).
      name: "mark_done",
      description: "מסמן משימה כבוצעה ב-Monday. השתמש רק אחרי שהעובד אמר מפורשות שסיים אותה.",
      input_schema: {
        type: "object",
        properties: { itemId: { type: "string" }, source: { type: "string", enum: ["general", "project_stage"] } },
        required: ["itemId", "source"],
      },
      requiredPermission: ["task:update_own"],
      execute: async (input: Record<string, unknown>, ctx) => {
        const taskInput: TaskUpdateInput = {
          action: "done",
          source: input.source as OpsTaskSource,
          itemId: String(input.itemId),
        };
        return doUpdateTask(ctx.user, taskInput);
      },
    },
    {
      name: "set_status",
      description: "מעדכן סטטוס משימה ב-Monday (למשל 'בעבודה' כשהעובד מתחיל לעבוד עליה).",
      input_schema: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          source: { type: "string", enum: ["general", "project_stage"] },
          status: { type: "string", description: "תווית סטטוס, למשל 'בעבודה'" },
        },
        required: ["itemId", "source", "status"],
      },
      requiredPermission: ["task:update_own"],
      execute: async (input: Record<string, unknown>, ctx) => {
        const taskInput: TaskUpdateInput = {
          action: "state",
          source: input.source as OpsTaskSource,
          itemId: String(input.itemId),
          label: String(input.status),
        };
        return doUpdateTask(ctx.user, taskInput);
      },
    },
    {
      name: "add_note",
      description: "מוסיף הערת עדכון למשימה ב-Monday (עדכון ביניים מהעובד).",
      input_schema: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          source: { type: "string", enum: ["general", "project_stage"] },
          note: { type: "string" },
        },
        required: ["itemId", "source", "note"],
      },
      requiredPermission: ["task:update_own"],
      execute: async (input: Record<string, unknown>, ctx) => {
        const taskInput: TaskUpdateInput = {
          action: "note",
          source: input.source as OpsTaskSource,
          itemId: String(input.itemId),
          note: String(input.note),
        };
        return doUpdateTask(ctx.user, taskInput);
      },
    },
    {
      name: "report_blocker",
      description: "מסמן משימה כתקועה ב-Monday ומוסיף הערה עם תיאור החסם.",
      input_schema: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          source: { type: "string", enum: ["general", "project_stage"] },
          note: { type: "string", description: "מה חוסם" },
        },
        required: ["itemId", "source", "note"],
      },
      requiredPermission: ["task:update_own"],
      execute: async (input: Record<string, unknown>, ctx) => {
        const taskInput: TaskUpdateInput = {
          action: "blocker",
          source: input.source as OpsTaskSource,
          itemId: String(input.itemId),
          note: String(input.note),
        };
        return doUpdateTask(ctx.user, taskInput);
      },
    },
    {
      name: "add_update",
      description:
        "מוסיף הערת עדכון (Update) לכל פריט ב-Monday — ליד / משימה / פרויקט / עסקה / גבייה. קבל את itemId מ-find_task / find_lead_or_deal / project_status. לבקשות כמו 'תכתוב בעדכונים של הליד X ש…', 'תוסיף הערה לפרויקט Y'.",
      input_schema: {
        type: "object",
        properties: {
          itemId: { type: "string", description: "מזהה הפריט ב-Monday" },
          body: { type: "string", description: "תוכן ההערה" },
          label: { type: "string", description: "שם הפריט, לאישור בלבד" },
        },
        required: ["itemId", "body"],
      },
      // addUpdateToItem אוכף בעצמו (canNote) את אותה תערובת הרשאות — משוקפת כאן כ-ANY-of.
      requiredPermission: ["task:update_own", "task:create", "lead:manage", "finance:manage", "project:manage"],
      execute: async (input: Record<string, unknown>, ctx) => {
        return doAddUpdateToItem(ctx.user, String(input.itemId), String(input.body));
      },
    },
    {
      name: "reassign_item",
      description:
        "מחליף את האחראי/ת של פריט ב-Monday — ליד / עסקה / משימה / פרויקט / שלב. קבל את itemId מ-find_task / find_lead_or_deal / project_status. לבקשות כמו 'תעביר את האחריות על הליד X ליוכי', 'תשייך את הפרויקט לדוב'. משנה בפועל את שדה האחראי ומתעד ב-Updates.",
      input_schema: {
        type: "object",
        properties: {
          itemId: { type: "string", description: "מזהה הפריט ב-Monday" },
          person: { type: "string", description: "שם מלא או פרטי של מי שיהיה האחראי/ת החדש/ה" },
          label: { type: "string", description: "שם הפריט, לאישור בלבד" },
        },
        required: ["itemId", "person"],
      },
      // ops/chat.ts:785 — userCan(task:manage) || userCan(lead:manage) || userCan(project:manage).
      requiredPermission: ["task:manage", "lead:manage", "project:manage"],
      execute: async (input: Record<string, unknown>, ctx) => {
        const r = await doReassignItem(ctx.user, String(input.itemId), String(input.person));
        return r;
      },
    },
    {
      name: "create_lead",
      description:
        "פותח ליד חדש (לקוח פוטנציאלי) בלוח הלידים. לבקשות כמו 'תפתח ליד...', 'יש לי ליד חדש...'. source/product חייבים להתאים בדיוק לאפשרויות הקיימות (enum) — אם לא ברור מה המשתמש התכוון, השמט את השדה במקום לנחש.",
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
          assignee: { type: "string", description: "מי אחראי/ת על הליד. השמט כדי לשייך למשתמש עצמו." },
        },
        required: ["firstName"],
      },
      requiredPermission: ["lead:manage"],
      execute: async (input: Record<string, unknown>, ctx) => {
        const leadInput: CreateLeadActionInput = {
          firstName: String(input.firstName ?? ""),
          lastName: input.lastName ? String(input.lastName) : undefined,
          phone: input.phone ? String(input.phone) : undefined,
          email: input.email ? String(input.email) : undefined,
          source: input.source ? String(input.source) : undefined,
          product: input.product ? String(input.product) : undefined,
          referredBy: input.referredBy ? String(input.referredBy) : undefined,
          assignee: input.assignee ? String(input.assignee) : undefined,
        };
        const result: CreateLeadResult = await doCreateLeadAction(ctx.user, leadInput);
        return result;
      },
    },
  ];

  return tools;
}

/** רשימה מוכנה עם התלויות האמיתיות — עדיין לא מיובאת/נקראת משום מקום ב-production. */
export const AGENT_TOOLS: AgentTool[] = buildAgentTools();

/** הכלים שהמשתמש הנתון רשאי להשתמש בהם, לפי requiredPermission (ANY-of). פונקציה טהורה. */
export function agentToolsForUser(user: IdentifiedUser, tools: AgentTool[] = AGENT_TOOLS): AgentTool[] {
  return tools.filter((t) => userCanUseAgentTool(user, t));
}
