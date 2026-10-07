/**
 * צ'אט תפעולי לעובד (שלב 3) — "בסגנון שיחה".
 *
 * העובד כותב בשפה חופשית ("בוקר טוב", "סיימתי את התכניות של בלומינג", "מה הבא?"), והעוזר:
 *  1. בבוקר — מציג את המשימות של היום.
 *  2. כשמדווחים ביצוע/התקדמות — מזהה את המשימה ומעדכן ב-Monday.
 *  3. שואל מה הבא בתור.
 *
 * מבוסס על אותם אבני בניין שכבר קיימות: getEmployeeDashboard (מה המשימות),
 * fetchUserOpsTasks (רשימה מלאה לזיהוי), updateTask (הכתיבה — עם בדיקת הרשאה ובעלות).
 * הכל ממודר לעובד המחובר בלבד.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { userCan, type IdentifiedUser } from "../identity/index.js";
import {
  fetchUserOpsTasks,
  getProjectNextAction,
  matchProjectsByQuery,
  type OpsTask,
} from "../integrations/monday/opsRead.js";
import {
  addCommitment,
  closeCommitment,
  listUserCommitments,
} from "../db/repositories/commitments.js";
import { logger } from "../utils/logger.js";
import { runRoutedAgent } from "../ai/routedAgent.js";
import { buildSystemPrompt } from "../ai/prompt.js";
import { isToolAllowedForUser, requireIdentifiedUser, type ToolDefinition } from "../ai/toolRegistry.js";
import type { NormTool, NormToolCall } from "../ai/providers/types.js";
import { AGENT_TOOLS, type AgentTool } from "./agentTools.js";
import { getApproval } from "../db/repositories/managerApprovals.js";
import { replyToApprovalInstruction } from "./approvalActions.js";
import {
  replyAwaitManager,
  replyBlocked,
  replyDefer,
  replyDone,
  replyFinishingToday,
  replyNotRelevant,
  replyProgress,
  replyWaiting,
  type LoopContext,
} from "./loopReply.js";
import { searchLeadsAndDeals } from "../integrations/monday/crmRead.js";
import { runControlScan } from "./controlScan.js";
import { runCrmScan } from "./crmScan.js";
import { buildDashboardViews, type DashboardTask } from "./dashboard.js";
import { getOfficeState } from "./officeState.js";
import { getOversightReport } from "./oversight.js";

const MAX_TURNS = 7;

/**
 * מאתר AgentTool לפי שם ב-registry המשותף, וזורק מיידית אם חסר — תקלת-חיווט תיתפס בעליית
 * השרת, לא בשקט באמצע שיחה עם עובד. טיפוס ההחזרה המוצהר (AgentTool, לא AgentTool|undefined)
 * מבטל את הצורך בבדיקת null/non-null assertion בכל מקום שמשתמש בתוצאה (כולל בתוך closures
 * שמוגדרים אחרי הבדיקה, כמו runOpsChat למטה) — ה-throw כאן הוא ההוכחה היחידה שצריכה.
 */
function requireAgentTool(name: string): AgentTool {
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`AgentTool '${name}' לא נמצא ב-registry המשותף (ops/agentTools.ts) — חיבור Web שבור.`);
  return tool;
}

/**
 * ה-AgentTool המשותף בפועל (לא עותק) — ר' ops/agentTools.ts. מיוצא (לא רק מקומי) כדי שבדיקת
 * parity (test-agent-tools.ts) תוכל להוכיח === מול AGENT_TOOLS.find(...) — שזה באמת האובייקט
 * המשותף, לא עותק.
 */
export const CREATE_TASK_AGENT_TOOL: AgentTool = requireAgentTool("create_task");

/**
 * שלב 3F.5A (2026-10-07): אותו דפוס בדיוק כמו CREATE_LEAD_TOOL_DEFINITION (3F.3) — ToolDefinition
 * אמיתי, לא "WebToolDefinition" נפרד. אין requiredPermission עצמאי: ה-ANY-of המלא של ה-AgentTool
 * חל (task:create/task:manage), בדיוק כמו canCreateTask(user) שהשער היה קודם (נשאר מיוצא/נבדק
 * בנפרד, רק לא משמש כאן יותר). schema זהה למה ש-WhatsApp's create_task גם חושף (CREATE_TASK_
 * AGENT_TOOL.input_schema המלא, בלי narrowing — בשונה מ-create_lead, שם יש הבדל מכוון).
 */
export const CREATE_TASK_TOOL_DEFINITION: ToolDefinition = {
  name: CREATE_TASK_AGENT_TOOL.name,
  description: CREATE_TASK_AGENT_TOOL.description,
  input_schema: CREATE_TASK_AGENT_TOOL.input_schema,
  requiresConfirmation: false,
  agentTool: CREATE_TASK_AGENT_TOOL,
  execute: async (input: Record<string, unknown>, ctx) =>
    CREATE_TASK_AGENT_TOOL.execute(input, { user: requireIdentifiedUser(ctx) }),
};

/**
 * שלב 2C (2026-10-05): אותו דפוס בדיוק כמו CREATE_TASK_AGENT_TOOL, ל-create_lead. ה-AgentTool
 * המשותף בפועל — לא עותק. מיוצא כדי ש-test-agent-tools.ts יוכל להוכיח === מול
 * AGENT_TOOLS.find("create_lead").
 */
export const CREATE_LEAD_AGENT_TOOL: AgentTool = requireAgentTool("create_lead");

/**
 * שלב 3F.3 (2026-10-07): create_lead הופך ל-ToolDefinition אמיתי — אותו טיפוס/מושג הרשאה
 * בדיוק שגם WhatsApp (integrations/claude/tools.ts) בנוי עליו משלב 3F.2, לא "WebToolDefinition"
 * נפרד. requiresConfirmation=false (Web לא משתמש בזרימת האישור הזו כלל — ר' Step 3A). אין
 * requiredPermission עצמאי כאן: ה-ANY-of המלא של ה-AgentTool חל (היום הסינגלטון ["lead:manage"]),
 * בדיוק כמו canCreateLead(user) שהשער היה קודם (נשאר מיוצא/נבדק בנפרד, רק לא משמש כאן יותר).
 * execute עצמו מפנה ל-AgentTool.execute בלבד — אין כאן לוגיקה עסקית חדשה, רק narrowing של
 * ctx.user (requireIdentifiedUser, זהה למה ש-WhatsApp עושה לכל כלי agentTool-backed שלו).
 */
export const CREATE_LEAD_TOOL_DEFINITION: ToolDefinition = {
  name: CREATE_LEAD_AGENT_TOOL.name,
  description: CREATE_LEAD_AGENT_TOOL.description,
  input_schema: CREATE_LEAD_AGENT_TOOL.input_schema,
  requiresConfirmation: false,
  agentTool: CREATE_LEAD_AGENT_TOOL,
  execute: async (input: Record<string, unknown>, ctx) =>
    CREATE_LEAD_AGENT_TOOL.execute(input, { user: requireIdentifiedUser(ctx) }),
};

/**
 * שלב 2D (2026-10-05): אותו דפוס, למשפחת updateTask (mark_done/set_status/add_note/
 * report_blocker) + add_update (addUpdateToItem, לא updateTask — הרשאה/business action שונה).
 * חמישה AgentTool נפרדים, לא אחד משולב — ה-action/source/note mapping שונה בין כל אחד,
 * ו-chat.ts's adapter (למטה) ממשיך לבנות כל הודעת actions.push ואת refresh()-or-not בדיוק
 * כפי שהיה (ר' Inspection ב-audit 2026-10-05: add_note ו-add_update לא קראו ל-refresh() מעולם
 * — ליצור/לעדכן הערה לא משפיע על cache המשימות; mark_done/set_status/report_blocker כן).
 */
export const MARK_DONE_AGENT_TOOL: AgentTool = requireAgentTool("mark_done");
export const SET_STATUS_AGENT_TOOL: AgentTool = requireAgentTool("set_status");
export const ADD_NOTE_AGENT_TOOL: AgentTool = requireAgentTool("add_note");
export const REPORT_BLOCKER_AGENT_TOOL: AgentTool = requireAgentTool("report_blocker");
export const ADD_UPDATE_AGENT_TOOL: AgentTool = requireAgentTool("add_update");

/**
 * שלב 2E (2026-10-05): אותו דפוס, ל-create_project_stage. permission gate בודד (project:manage,
 * לא ANY-of) — זו הסיבה שהוא עבר לפני reassign_item (task:manage||lead:manage||project:manage).
 */
export const CREATE_PROJECT_STAGE_AGENT_TOOL: AgentTool = requireAgentTool("create_project_stage");

/**
 * שלב 2F (2026-10-05) — הכלי התשיעי והאחרון מתוך ה-9 שבתוכנית. permission gate ANY-of
 * (task:manage || lead:manage || project:manage) — requiredPermission כבר מערך מ-Step 1,
 * ו-userCanUseAgentTool משתמש ב-.some() (ANY-of), לא .every() — אומת ב-test-agent-tools.ts.
 */
export const REASSIGN_ITEM_AGENT_TOOL: AgentTool = requireAgentTool("reassign_item");

/**
 * מקור אמת אמיתי (לא regex על טקסט!) לבדיקת tool-parity (test-tool-parity.ts, שלב 2B,
 * 2026-10-05): אילו שמות כלים ה-Web בפועל יכול לחשוף למשתמש כלשהו, מחולק לפי המקור —
 *
 *   WIRED_AGENT_TOOL_NAMES — מגיעים בפועל מה-AgentTool registry המשותף (ops/agentTools.ts),
 *     בדיוק כמו create_task/create_lead. נגזר מ-`.name` של האובייקטים האמיתיים
 *     (למשל CREATE_TASK_AGENT_TOOL.name), לא retype של מחרוזת — אי אפשר שזה "יתפזר" בלי לשים לב.
 *
 *   WEB_CHAT_LOCAL_TOOL_NAMES — עדיין מוגדרים inline כאן ב-runOpsChat; כל 9 ה-AgentTools כבר
 *     עברו (ר' למטה) — מה שנשאר ברשימה הזו הם כלים שאינם חלק מ-9 ה-AgentTools בכלל (get_today_
 *     tasks, find_task, commitments, reply_X (סגירת לולאה), כלי בקרת-משרד) ולא מועמדים ל-migration בשלב הזה.
 *
 * כל 9 ה-AgentTools עברו: create_task (2A), create_lead (2C), mark_done/set_status/add_note/
 * report_blocker/add_update (2D), create_project_stage (2E), reassign_item (2F — האחרון,
 * כל השלבים 2026-10-05). migration עתידי של כלי *חדש* (לא אחד מה-9) יצטרך תחילה AgentTool
 * חדש ב-agentTools.ts, ואז להעביר שם מכאן ל-WIRED_AGENT_TOOL_NAMES באותו commit.
 */
export const WIRED_AGENT_TOOL_NAMES: readonly string[] = [
  CREATE_TASK_AGENT_TOOL.name,
  CREATE_LEAD_AGENT_TOOL.name,
  MARK_DONE_AGENT_TOOL.name,
  SET_STATUS_AGENT_TOOL.name,
  ADD_NOTE_AGENT_TOOL.name,
  REPORT_BLOCKER_AGENT_TOOL.name,
  ADD_UPDATE_AGENT_TOOL.name,
  CREATE_PROJECT_STAGE_AGENT_TOOL.name,
  REASSIGN_ITEM_AGENT_TOOL.name,
];

export const WEB_CHAT_LOCAL_TOOL_NAMES: readonly string[] = [
  // "מה יש לי היום" + זיהוי משימה
  "get_today_tasks",
  "find_task",
  // התחייבויות
  "record_commitment",
  "list_my_commitments",
  "close_commitment",
  // סגירת הלולאה (נחשף רק כשיש about — פנייה יזומה של הבקרה)
  "reply_done",
  "reply_progress",
  "reply_finishing_today",
  "reply_defer",
  "reply_waiting",
  "reply_blocked",
  "reply_await_manager",
  "reply_not_relevant",
  // בקרה על כל המשרד — view:all_work בלבד
  "office_overview",
  "person_status",
  "project_status",
  "list_findings",
  "sales_and_collection",
  "find_lead_or_deal",
];

/**
 * תנאי חשיפת create_task/create_lead בחלונית — פונקציות בשם משלהן (לא inline) כדי שבדיקות
 * (test-task-creation.ts) יוכלו לאמת "הכלי נחשף כשיש הרשאה" בלי להריץ את כל runOpsChat
 * (שדורש Monday+AI חיים). נקראות גם בבניית ה-system prompt וגם בגייטינג של תוספת הכלי בפועל.
 */
export function canCreateTask(user: IdentifiedUser): boolean {
  return userCan(user, "task:create") || userCan(user, "task:manage");
}
export function canCreateLead(user: IdentifiedUser): boolean {
  return userCan(user, "lead:manage");
}
/**
 * יצירת שלב חדש בפרויקט (create_project_stage) — שינוי מבנה הפרויקט עצמו, לא רק תוכן בתוכו,
 * לכן שער ב-project:manage (לא task:create/task:manage): קיים בדיוק ל-owner/admin/project_manager
 * (ר' roles.ts) — לא ל-planner/finance. scope פר-פרויקט (מנהל/ת רק בפרויקט שהוא/היא מנהל/ת)
 * נאכף בפועל ב-createProjectStageAction (authorizeCreateStage), לא כאן — זה רק שער הכלי.
 */
export function canManageProjectStages(user: IdentifiedUser): boolean {
  return userCan(user, "project:manage");
}

/**
 * create_task — ה-AgentTool המשותף (name/description/input_schema/execute) מוגדר ומיוצא עכשיו
 * מ-ops/agentTools.ts (שלב 2A, תוכנית איחוד Web/WhatsApp, 2026-10-05), לא כאן. הוזז לשם כדי
 * ש-agentTools.ts לא יהיה תלוי ב-chat.ts (היה גורם ל-import מעגלי ברגע שגם chat.ts צריך לצרוך
 * משם את create_task בפועל — ר' audit 2026-10-05). מיוצא כאן מחדש (re-export) כדי שבדיקות
 * קיימות (test-create-task-prompt.ts/test-create-task-behavior.ts) שמייבאות CREATE_TASK_TOOL_DECL
 * מ-"./chat.js" ימשיכו לעבוד בלי שום שינוי — התוכן של ה-schema עצמו לא שונה כלל, רק מיקומו.
 * ההיסטוריה של דרישת taskName האמיתי (אירוע 2026-09-22) מתועדת כעת בתוך agentTools.ts.
 */
export { CREATE_TASK_TOOL_DECL } from "./agentTools.js";

/**
 * create_project_stage — ה-AgentTool המשותף מוגדר ומיוצא עכשיו מ-ops/agentTools.ts (שלב 2E,
 * 2026-10-05), באותה סיבה בדיוק כמו create_task (2A): כדי ש-agentTools.ts לא יהיה תלוי
 * ב-chat.ts. התוכן לא שונה אות אחת (אומת byte-for-byte לפני ההעברה). מיוצא כאן מחדש כדי
 * ש-test-project-stage-behavior.ts (שמייבא CREATE_PROJECT_STAGE_TOOL_DECL מ-"./chat.js")
 * ימשיך לעבוד בלי שינוי.
 */
export { CREATE_PROJECT_STAGE_TOOL_DECL } from "./agentTools.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface OpsChatResult {
  reply: string;
  /** תיאור קצר של כל עדכון שבוצע ב-Monday בסבב הזה — לרענון הרשימה ולתצוגה */
  actions: string[];
}

/**
 * שלב 3F.1 (2026-10-07): התוכן הועבר ל-src/ai/prompt.ts (buildSystemPrompt) — זה עכשיו adapter
 * דק בלבד, בלי שינוי טקסט/behavior (ר' test-shared-prompt.ts). מיוצא עדיין (ללא שינוי חתימה)
 * כי test-create-task-prompt.ts/test-create-task-behavior.ts/test-project-stage-behavior.ts
 * מייבאים אותו ישירות מ-"./chat.js".
 */
export function systemPrompt(user: IdentifiedUser, about?: LoopContext): string {
  return buildSystemPrompt({ channel: "web", user, about });
}

function fmtTask(t: DashboardTask): string {
  const where = t.stageName ? `${t.context} › ${t.stageName}` : t.context;
  const bits = [where];
  if (t.dueDate) bits.push(t.flags.overdue ? `באיחור ${t.flags.daysOverdue} ימים` : t.dueDate);
  if (t.status) bits.push(t.status);
  if (t.priority?.includes("קריטי")) bits.push("קריטי");
  if (t.flags.blocking.length) bits.push(`חוסם ${t.flags.blocking.length}`);
  return `[${t.source}:${t.itemId}] ${t.name} — ${bits.join(" · ")}`;
}

/**
 * תדריך "היום שלי" מקובץ לפי פרויקט, עם שורת "עכשיו:" לכל פרויקט (הפעולה הבאה המחושבת).
 * נבנה בשרת כדי שהתצוגה תהיה עקבית — הצ'אט רק מגיש אותו.
 */
async function buildTodayBriefing(myDay: DashboardTask[], user: IdentifiedUser): Promise<string> {
  if (myDay.length === 0) return "אין משימות לטיפול היום 👌";

  // קיבוץ: פרויקט מקושר (projectId) → קבוצה; משימות משרד כלליות → דלי נפרד
  const groups = new Map<string, { label: string; projectId?: string; tasks: DashboardTask[] }>();
  const officeTasks: DashboardTask[] = [];
  for (const t of myDay) {
    const hasProject = t.context && t.context !== "משימת משרד" && t.context !== "פרויקט לא מקושר";
    if (t.projectId) {
      const g = groups.get(t.projectId) ?? { label: t.context, projectId: t.projectId, tasks: [] };
      g.tasks.push(t);
      groups.set(t.projectId, g);
    } else if (hasProject) {
      const key = "name:" + t.context;
      const g = groups.get(key) ?? { label: t.context, tasks: [] };
      g.tasks.push(t);
      groups.set(key, g);
    } else {
      officeTasks.push(t);
    }
  }

  const flagStr = (t: DashboardTask): string => {
    const bits: string[] = [];
    if (t.flags.critical) bits.push("🔴 קריטי");
    if (t.flags.overdue) bits.push(`באיחור ${t.flags.daysOverdue} ימים`);
    else if (t.flags.dueToday) bits.push("להיום");
    return bits.join(" · ");
  };

  const myTaskIds = new Set(myDay.map((t) => t.itemId));
  const lines: string[] = [`היום על הפרק — ${myDay.length} משימות:`];

  // "הפעולה הבאה" לכל הפרויקטים במקביל — אחרת "בוקר טוב" של מנהל פרויקט עם כמה פרויקטים איטי מדי.
  const groupList = [...groups.values()];
  const nextActions = await Promise.all(
    groupList.map((g) => (g.projectId ? getProjectNextAction(g.projectId).catch(() => null) : Promise.resolve(null))),
  );

  for (let i = 0; i < groupList.length; i++) {
    const g = groupList[i]!;
    // המשימה הבולטת בקבוצה קובעת את סימון הדגל של הפרויקט
    const lead = [...g.tasks].sort(
      (a, b) => Number(b.flags.critical) - Number(a.flags.critical) || b.flags.daysOverdue - a.flags.daysOverdue,
    )[0]!;
    const fl = flagStr(lead);
    lines.push("", `📁 ${g.label}${fl ? ` — ${fl}` : ""}`);

    const na = nextActions[i];
    if (na) {
      let suffix = "";
      if (!na.assignees) suffix = " (עדיין לא משויך)";
      else if (!na.assignees.includes(user.name)) suffix = ` (אצל ${na.assignees})`;
      else if (myTaskIds.has(na.taskId)) suffix = " (זו המשימה שלך)";
      lines.push(`   עכשיו: ${na.taskName} · ${na.stageName}${suffix}`);
    } else {
      // אין פרויקט מקושר / לא הצלחנו לחשב — נופלים למשימה של העובד עצמו
      lines.push(`   עכשיו: ${g.tasks[0]!.name}${g.tasks[0]!.stageName ? ` · ${g.tasks[0]!.stageName}` : ""}`);
    }
    // אם לעובד יש עוד משימות באותו פרויקט מעבר לצעד הנוכחי — נזכיר בקצרה
    const extra = g.tasks.filter((t) => t.name !== (na?.taskName ?? g.tasks[0]!.name));
    if (extra.length) lines.push(`   גם שלך כאן: ${extra.map((t) => t.name).join(" · ")}`);
  }

  if (officeTasks.length) {
    lines.push("", "🗂️ משימות משרד:");
    for (const t of officeTasks) {
      const fl = flagStr(t);
      lines.push(`   • ${t.name}${fl ? ` — ${fl}` : ""}`);
    }
  }

  return lines.join("\n");
}

function matchScore(task: OpsTask, q: string): number {
  const hay = `${task.name} ${task.context} ${task.stageName ?? ""}`.toLowerCase();
  const needle = q.toLowerCase().trim();
  if (!needle) return 0;
  if (hay.includes(needle)) return 100;
  const words = needle.split(/\s+/).filter((w) => w.length > 1);
  return words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
}

interface ToolDef {
  name: string;
  description: string;
  /** אובייקט JSON Schema — מתורגם לפורמט של כל provider בשכבת ה-providers */
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * שלב 3F.4 (2026-10-07): מבדיל בין Web-local ToolDef הישן (run(input), בלי ctx — ~27 כלים,
 * כולל 8 מתוך 9 ה-AgentTool-backed שעדיין לא הומרו) לבין ToolDefinition משותף אמיתי
 * (execute(input,ctx), src/ai/toolRegistry.ts — היום רק create_lead). ה-duck-typing (שדה
 * execute קיים) עובד כי שתי הצורות לעולם לא מגדירות את שני השדות (run/execute) גם יחד.
 */
function isSharedToolDefinition(tool: ToolDef | ToolDefinition): tool is ToolDefinition {
  return "execute" in tool;
}

/**
 * שלב 3F.4, הורחב 3F.5A: מיפוי Web-specific מ-shared ToolDefinitions (לא Web-local הישנים)
 * לתופעות הלוואי של ה-UI — channel adapter concern, לא חלק מה-ToolDefinition המשותף/מה-business
 * logic (ה-execute של ToolDefinition לא יודע על actions[]/refresh() בכלל). message בונה את
 * טקסט ה-changelog (actions[]); refresh?:true אומר לדיספצ'ר להריץ await refresh() *אחרי*
 * actions.push, בדיוק הסדר שהיה ב-run() wrapper הישן של create_task. לא event bus גנרי — רק
 * שני השדות שבאמת צריך כרגע. create_lead (3F.3/4): אין refresh (כמו שהיה). create_task (3F.5A):
 * refresh:true (כמו שהיה). כלים נוספים שיומרו יקבלו שורה משלהם, עם הניסוח המקורי שלהם.
 */
interface SharedToolUiEffect {
  message: (result: { message: string }) => string;
  /** true ⇐ הדיספצ'ר מריץ await refresh() אחרי actions.push, רק אם execute הצליח. */
  refresh?: boolean;
}
const SHARED_TOOL_UI_EFFECT: Record<string, SharedToolUiEffect> = {
  create_lead: { message: (r) => `🆕 ${r.message}` },
  create_task: { message: (r) => `🆕 ${r.message}`, refresh: true },
};

export interface OpsChatOptions {
  /** ההודעה היא תשובה לפנייה יזומה של הבקרה על משימה ספציפית — מפעיל את כלי סגירת הלולאה. */
  about?: LoopContext;
}

export async function runOpsChat(
  user: IdentifiedUser,
  history: ChatMessage[],
  opts: OpsChatOptions = {},
): Promise<OpsChatResult> {
  if (!user.mondayUserId) {
    return { reply: "אין לך חשבון Monday מקושר, אז אין לי גישה למשימות שלך. פנה/י ליוכי.", actions: [] };
  }

  // תשובה לשאלה/הנחיה של מוטי מתוך Approval (audit 2026-09-14, סגירת פער pending_instruction):
  // אם יש approvalId וה-Approval עדיין ממתין לתשובה — כל ההודעה היא התשובה, נקודה. לא עובר דרך
  // ה-AI/reply_* tools בכלל (בכוונה — "אל תבצע אוטומטית פעולה חדשה מתוך אותו מסר").
  if (opts.about?.approvalId) {
    const approval = getApproval(opts.about.approvalId);
    if (approval && approval.status === "pending_instruction" && approval.requestedBy === user.key) {
      const lastUserMsg = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
      const result = await replyToApprovalInstruction(user, opts.about.approvalId, lastUserMsg);
      if (result.ok) {
        return {
          reply: "העברתי את התשובה שלך למוטי. אני אעדכן אותך כשהוא יחליט.",
          actions: [`💬 תשובה למוטי על "${approval.taskName ?? approval.itemId}"`],
        };
      }
      // כבר הוכרע/לא ממתין בינתיים — לא שגיאה למשתמש, ממשיכים כשיחה רגילה במקום לתקוע אותו.
      logger.info({ user: user.key, approvalId: opts.about.approvalId, code: result.code }, "תשובת approval הגיעה באיחור — ממשיך כשיחה רגילה");
    }
    // approval לא נמצא / לא שייך למשתמש / כבר לא pending_instruction → ממשיכים בזרימה הרגילה,
    // בלי לחשוף מידע על approval של מישהו אחר.
  }

  const now = DateTime.now().setZone(env.TIMEZONE);
  let tasks = await fetchUserOpsTasks(user.mondayUserId);
  const actions: string[] = [];
  // התדריך של "בוקר טוב" מוגש מילה במילה — מודלים נוטים לקצר/לנסח מחדש, וכאן חשוב שהמבנה
  // (פרויקט → 'עכשיו:') יישאר בדיוק כמו שבנינו אותו.
  let capturedBriefing: string | null = null;

  const refresh = async () => {
    tasks = await fetchUserOpsTasks(user.mondayUserId!);
  };

  const findTask = (itemId: string): OpsTask | undefined => tasks.find((t) => t.itemId === itemId);

  const tools: (ToolDef | ToolDefinition)[] = [
    {
      name: "get_today_tasks",
      description:
        "מחזיר את המשימות של המשתמש להיום: מה לטפל בו היום, מה דורש תשומת לב, ומה אחרים מחכים לו. לכל פרויקט שמופיע במשימות של היום מצורף גם 'הצעד הנוכחי בפרויקט' — המשימה/תת-המשימה שצריך לעשות עכשיו באותו פרויקט לפי סדר השלבים.",
      input_schema: { type: "object", properties: {} },
      run: async () => {
        const v = buildDashboardViews(tasks, now);
        const briefing = await buildTodayBriefing(v.myDay, user);
        capturedBriefing = briefing;
        return {
          counts: {
            today: v.myDay.length,
            needsAttention: v.needsAttention.length,
            waitingOnMe: v.waitingOnMe.length,
            totalOpen: tasks.length,
          },
          briefing,
          needsAttention: v.needsAttention.slice(0, 8).map(fmtTask),
          waitingOnMe: v.waitingOnMe.slice(0, 8).map(fmtTask),
        };
      },
    },
    {
      name: "find_task",
      description: "מחפש משימה פתוחה של המשתמש לפי תיאור חופשי (שם משימה / פרויקט / שלב). מחזיר עד 5 התאמות עם המזהה. השתמש בזה כדי לזהות על איזו משימה העובד מדבר לפני עדכון.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "מה שהעובד תיאר, למשל 'התכניות של בלומינג'" } },
        required: ["query"],
      },
      run: async (input) => {
        const q = String(input.query ?? "");
        const ranked = tasks
          .map((t) => ({ t, score: matchScore(t, q) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
        return {
          matches: ranked.map(({ t }) => ({
            itemId: t.itemId,
            source: t.source,
            name: t.name,
            context: t.stageName ? `${t.context} › ${t.stageName}` : t.context,
            status: t.status,
            dueDate: t.dueDate ?? null,
          })),
        };
      },
    },
    {
      // name/description/input_schema/execute מה-AgentTool המשותף (ops/agentTools.ts, שלב 2D).
      // ה-run כאן הוא adapter דק: findTask (לשם התצוגה), execute המשותף (קורא ל-updateTask,
      // בדיוק כמו קודם), ואז actions.push + refresh() בדיוק כמו שהיה — כולל ה-emoji/טקסט המדויק.
      name: MARK_DONE_AGENT_TOOL.name,
      description: MARK_DONE_AGENT_TOOL.description,
      input_schema: MARK_DONE_AGENT_TOOL.input_schema,
      run: async (input) => {
        const t = findTask(String(input.itemId));
        const r = await MARK_DONE_AGENT_TOOL.execute(input, { user });
        actions.push(`✅ ${t?.name ?? input.itemId} — בוצע`);
        await refresh();
        return r;
      },
    },
    {
      name: SET_STATUS_AGENT_TOOL.name,
      description: SET_STATUS_AGENT_TOOL.description,
      input_schema: SET_STATUS_AGENT_TOOL.input_schema,
      run: async (input) => {
        const t = findTask(String(input.itemId));
        const r = await SET_STATUS_AGENT_TOOL.execute(input, { user });
        actions.push(`↻ ${t?.name ?? input.itemId} — ${input.status}`);
        await refresh();
        return r;
      },
    },
    {
      name: ADD_NOTE_AGENT_TOOL.name,
      description: ADD_NOTE_AGENT_TOOL.description,
      input_schema: ADD_NOTE_AGENT_TOOL.input_schema,
      run: async (input) => {
        const t = findTask(String(input.itemId));
        const r = await ADD_NOTE_AGENT_TOOL.execute(input, { user });
        actions.push(`✎ ${t?.name ?? input.itemId} — הערה`);
        // כמו במקור: בלי refresh() — הערה לא משנה את תצוגת/cache המשימות.
        return r;
      },
    },
    {
      name: REPORT_BLOCKER_AGENT_TOOL.name,
      description: REPORT_BLOCKER_AGENT_TOOL.description,
      input_schema: REPORT_BLOCKER_AGENT_TOOL.input_schema,
      run: async (input) => {
        const t = findTask(String(input.itemId));
        const r = await REPORT_BLOCKER_AGENT_TOOL.execute(input, { user });
        actions.push(`🚧 ${t?.name ?? input.itemId} — תקוע`);
        await refresh();
        return r;
      },
    },
    {
      name: ADD_UPDATE_AGENT_TOOL.name,
      description: ADD_UPDATE_AGENT_TOOL.description,
      input_schema: ADD_UPDATE_AGENT_TOOL.input_schema,
      run: async (input) => {
        const r = await ADD_UPDATE_AGENT_TOOL.execute(input, { user });
        actions.push(`✎ הערה נוספה${input.label ? `: ${input.label}` : ""}`);
        // כמו במקור: בלי refresh().
        return r;
      },
    },
    {
      name: "record_commitment",
      description:
        "רושם התחייבות שהעובד נתן — משהו שהובטח ללקוח / ליועץ / לגורם אחר. קרא לזה כשהעובד אומר 'הבטחתי ל...', 'אמרתי ללקוח ש...', 'התחייבתי לשלוח עד...'. נסה למלא תאריך יעד אם נאמר.",
      input_schema: {
        type: "object",
        properties: {
          toWhom: { type: "string", description: "למי הובטח (שם הלקוח/הגורם)" },
          what: { type: "string", description: "מה הובטח" },
          dueDate: { type: "string", description: "תאריך יעד YYYY-MM-DD, אם נאמר" },
          project: { type: "string", description: "שם הפרויקט אם רלוונטי" },
        },
        required: ["toWhom", "what"],
      },
      run: async (input) => {
        const c = addCommitment({
          createdBy: user.key,
          toWhom: String(input.toWhom),
          what: String(input.what),
          dueDate: input.dueDate ? String(input.dueDate) : undefined,
          project: input.project ? String(input.project) : undefined,
        });
        actions.push(`🤝 התחייבות נרשמה: ${c.toWhom} — ${c.what}`);
        return { ok: true, id: c.id, dueDate: c.dueDate };
      },
    },
    {
      name: "list_my_commitments",
      description: "מחזיר את ההתחייבויות הפתוחות של העובד. לשאלות כמו 'מה הבטחתי?', 'מה אני חייב ללקוחות?'.",
      input_schema: { type: "object", properties: {} },
      run: async () => ({
        commitments: listUserCommitments(user.key).map((c) => ({
          id: c.id,
          toWhom: c.toWhom,
          what: c.what,
          dueDate: c.dueDate,
        })),
      }),
    },
    {
      name: "close_commitment",
      description: "סוגר התחייבות — כשהעובד אומר שקיים אותה ('שלחתי ללקוח', 'קיימתי') או שהיא כבר לא רלוונטית. קבל id מ-list_my_commitments.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "number" },
          outcome: { type: "string", enum: ["done", "cancelled"] },
        },
        required: ["id", "outcome"],
      },
      run: async (input) => {
        const ok = closeCommitment(Number(input.id), input.outcome === "cancelled" ? "cancelled" : "done");
        if (ok) actions.push(`🤝 התחייבות ${input.outcome === "cancelled" ? "בוטלה" : "קוימה"}`);
        return { ok };
      },
    },
  ];

  // ---- סגירת הלולאה: תשובה לפנייה יזומה של הבקרה על משימה ידועה ----
  if (opts.about) {
    const c = opts.about;
    const label = c.taskName ?? c.itemId;
    const runLoop = async (
      tag: string,
      fn: () => Promise<{ message: string; tracking: string }>,
    ): Promise<{ message: string; tracking: string }> => {
      const r = await fn();
      actions.push(tag);
      await refresh();
      return r;
    };
    tools.push(
      {
        name: "reply_done",
        description: "העובד דיווח שסיים את המשימה. מסמן בוצע וסוגר את ממצא הבקרה.",
        input_schema: { type: "object", properties: {} },
        run: () => runLoop(`✅ ${label} — בוצע`, () => replyDone(user, c)),
      },
      {
        name: "reply_progress",
        description: "העובד דיווח שהוא עדיין עובד על המשימה / באמצע / כמעט סיים. רושם הערה ונותן לו עוד יום עבודה.",
        input_schema: {
          type: "object",
          properties: { note: { type: "string", description: "מה שהעובד אמר על ההתקדמות" } },
          required: ["note"],
        },
        run: (i) => runLoop(`🔄 ${label} — עדכון התקדמות`, () => replyProgress(user, c, String(i.note))),
      },
      {
        name: "reply_finishing_today",
        description:
          "העובד דיווח שהוא עדיין עובד אבל בטוח שיסיים היום ('אני עובד על זה ואסיים היום', 'יהיה מוכן עד הערב'). " +
          "לא משנה תאריך יעד ולא דוחה — רק מתעד ומפסיק להטריד עד סוף היום. אם העובד ביקש בפירוש עוד ימים/תאריך אחר — זה reply_defer, לא זה.",
        input_schema: { type: "object", properties: {} },
        run: () => runLoop(`🕓 ${label} — מסיים היום`, () => replyFinishingToday(user, c)),
      },
      {
        name: "reply_defer",
        description:
          "העובד ביקש דחייה ('צריך עוד יומיים', 'עד יום חמישי', 'תדחה לשבוע הבא'). מעדכן את תאריך היעד ב-Monday, מתעד את בקשת הדחייה, ומשהה את הבקרה עד התאריך החדש. " +
          "אתה לא מאשר את הדחייה — אתה רק מפרש ומעריך אם ההסבר שניתן (אם ניתן) הגיוני, דרך reasonJudgedPlausible.",
        input_schema: {
          type: "object",
          properties: {
            newDate: { type: "string", description: "תאריך היעד החדש, YYYY-MM-DD — חשב לפי התאריך היום שבמערכת" },
            reason: { type: "string", description: "סיבת הדחייה כפי שהעובד ניסח אותה, אם ניסח" },
            reasonJudgedPlausible: {
              type: "boolean",
              description:
                "שיפוט שלך על הסיבה שהעובד נתן — לא אישור, רק פרשנות: true אם ההסבר קונקרטי וסביר " +
                "(מסביר בפועל למה צריך את הזמן), false אם 'הסבר' ניתן אבל לא באמת מצדיק כלום. " +
                "השמט את הפרמטר הזה כליל אם העובד לא נתן שום הסבר.",
            },
            scopeChange: {
              type: "boolean",
              description:
                "true אם הסיבה לדחייה היא שינוי/הרחבת היקף העבודה (דרישות נוספות, שרטוטים נוספים, " +
                "שינוי מצד הלקוח, קומה/חלופה/חלק נוסף וכו'). מידע לתיעוד בלבד — לא משפיע על האישור " +
                "עצמו. השמט אם זו לא סיבת שינוי היקף.",
            },
          },
          required: ["newDate"],
        },
        // replyDefer עובר עכשיו תמיד דרך ה-Policy Engine (planDeferralReply) — יכול להחזיר
        // executed / needs_clarification / manager_approval_required. לא ניתן לדעת מראש איזה
        // תג לרשום ל-actions (בניגוד לשאר reply_*), אז לא משתמשים כאן ב-runLoop הגנרי.
        run: async (i) => {
          const result = await replyDefer(
            user,
            c,
            String(i.newDate),
            i.reason ? String(i.reason) : undefined,
            typeof i.reasonJudgedPlausible === "boolean" ? i.reasonJudgedPlausible : null,
            {},
            typeof i.scopeChange === "boolean" ? i.scopeChange : false,
          );
          const tag =
            result.status === "executed"
              ? `📅 ${label} — נדחה ל-${String(i.newDate)}`
              : result.status === "needs_clarification"
                ? `❓ ${label} — צריך הבהרה לפני דחייה`
                : `⏸️ ${label} — דחייה ממתינה לאישור מוטי`;
          actions.push(tag);
          await refresh();
          return result;
        },
      },
      {
        name: "reply_waiting",
        description:
          "העובד דיווח שהוא ממתין לגורם חיצוני: 'מחכה ללקוח' (on=client), 'מחכה ליועץ/לספק/לקונסטרוקטור' (on=consultant), גורם אחר (on=other). מעדכן סטטוס המתנה ומתעד את הסיבה.",
        input_schema: {
          type: "object",
          properties: {
            on: { type: "string", enum: ["client", "consultant", "other"] },
            reason: { type: "string", description: "למה בדיוק מחכים" },
          },
          required: ["on"],
        },
        run: (i) =>
          runLoop(`⏳ ${label} — ממתין (${String(i.on)})`, () =>
            replyWaiting(user, c, i.on as "client" | "consultant" | "other", i.reason ? String(i.reason) : undefined),
          ),
      },
      {
        name: "reply_blocked",
        description: "העובד דיווח שהמשימה תקועה בגלל חסם ('תקוע כי...', 'חסום כי...'). מסמן תקוע ומתעד את החסם.",
        input_schema: {
          type: "object",
          properties: { blocker: { type: "string", description: "מה חוסם" } },
          required: ["blocker"],
        },
        run: (i) => runLoop(`🚧 ${label} — תקוע`, () => replyBlocked(user, c, String(i.blocker))),
      },
      {
        name: "reply_await_manager",
        description:
          "העובד דיווח שהוא ממתין להחלטה של מנהל ('מחכה שמוטי יחליט', 'צריך אישור מלמעלה'). מתעד על המשימה ומעדכן את מוטי שהעובד ממתין להחלטתו.",
        input_schema: {
          type: "object",
          properties: { question: { type: "string", description: "על מה בדיוק מחכים להחלטה" } },
          required: ["question"],
        },
        run: (i) => runLoop(`🧑‍⚖️ ${label} — הועבר למוטי`, () => replyAwaitManager(user, c, String(i.question))),
      },
      {
        name: "reply_not_relevant",
        description:
          "העובד דיווח שהמשימה כבר לא רלוונטית / בוטלה / לא צריך אותה יותר. לפי מדיניות המערכת ביטול תמיד דורש אישור מוטי — הכלי הזה לא משנה סטטוס ולא סוגר ב-Monday, רק מתעד ומעביר להחלטת מוטי.",
        input_schema: {
          type: "object",
          properties: { reason: { type: "string", description: "למה כבר לא רלוונטי" } },
        },
        run: (i) => runLoop(`⏸️ ${label} — ממתין לאישור מוטי (לא רלוונטי)`, () => replyNotRelevant(user, c, i.reason ? String(i.reason) : undefined)),
      },
    );
  }

  // ---- שינוי אחראי/ת — למי שמנהל משימות/לידים/פרויקטים ----
  // name/description/input_schema/execute מגיעים מה-AgentTool המשותף (ops/agentTools.ts, שלב
  // 2F) — לא עותק מקומי. ה-run כאן הוא adapter דק: מריץ את ה-execute המשותף (שקורא בפועל
  // ל-reassignItem — resolution דו-שכבתית + scope + addTaskNote, הכל בלתי משתנה) ואז מוסיף
  // actions.push לפי r.message, בדיוק כמו קודם. אין refresh() — גם בגרסה המקורית לא היה.
  if (userCan(user, "task:manage") || userCan(user, "lead:manage") || userCan(user, "project:manage")) {
    tools.push({
      name: REASSIGN_ITEM_AGENT_TOOL.name,
      description: REASSIGN_ITEM_AGENT_TOOL.description,
      input_schema: REASSIGN_ITEM_AGENT_TOOL.input_schema,
      run: async (input) => {
        const r = (await REASSIGN_ITEM_AGENT_TOOL.execute(input, { user })) as { message: string };
        actions.push(`👤 ${r.message}`);
        return r;
      },
    });
  }

  // ---- יצירת משימה חדשה — שלב 3F.5A: ToolDefinition משותף נדחף ישירות, בלי run() wrapper ----
  // gate עובר דרך isToolAllowedForUser (לא canCreateTask(user), ר' שלב 3F.3/4 לאותו דפוס
  // ב-create_lead). ה-executeToolCall (למטה, buildLoop) מריץ CREATE_TASK_TOOL_DEFINITION.
  // execute(input,{user}) ישירות, ואז actions.push + refresh() דרך SHARED_TOOL_UI_EFFECT —
  // בדיוק באותו סדר שהיה ב-run() wrapper הישן (actions.push קודם, refresh() אחריו, שניהם רק
  // אם execute לא זרק).
  if (isToolAllowedForUser(CREATE_TASK_TOOL_DEFINITION, user)) {
    tools.push(CREATE_TASK_TOOL_DEFINITION);
  }

  // ---- יצירת שלב חדש בפרויקט — רק למי שיש project:manage (owner/admin/project_manager) ----
  // name/description/input_schema/execute מגיעים מה-AgentTool המשותף (ops/agentTools.ts, שלב
  // 2E) — לא עותק מקומי. ה-run כאן הוא adapter דק: מריץ את ה-execute המשותף (שקורא בפועל
  // ל-createProjectStageAction, בדיוק כמו קודם) ואז מוסיף actions.push לפי r.message — בדיוק
  // כמו שהיה. אין refresh() — גם בגרסה המקורית לא היה (יצירת שלב לא משפיעה על מטמון המשימות).
  if (canManageProjectStages(user)) {
    tools.push({
      name: CREATE_PROJECT_STAGE_AGENT_TOOL.name,
      description: CREATE_PROJECT_STAGE_AGENT_TOOL.description,
      input_schema: CREATE_PROJECT_STAGE_AGENT_TOOL.input_schema,
      run: async (input) => {
        const r = (await CREATE_PROJECT_STAGE_AGENT_TOOL.execute(input, { user })) as { message: string };
        actions.push(`🆕 ${r.message}`);
        return r;
      },
    });
  }

  // ---- יצירת ליד חדש — שלב 3F.4: ToolDefinition משותף נדחף ישירות, בלי run() wrapper ----
  // gate עובר דרך isToolAllowedForUser (לא canCreateLead(user), ר' שלב 3F.3). ה-executeToolCall
  // (למטה, buildLoop) הוא זה שמריץ CREATE_LEAD_TOOL_DEFINITION.execute(input,{user}) ישירות
  // ומוסיף את actions.push ה-UI-specific (דרך SHARED_TOOL_UI_EFFECT) — אין כאן יותר adapter
  // מקומי בכלל, לא רק run() דק. בניגוד ל-create_task, אין refresh() — כמו קודם.
  if (isToolAllowedForUser(CREATE_LEAD_TOOL_DEFINITION, user)) {
    tools.push(CREATE_LEAD_TOOL_DEFINITION);
  }

  // ---- כלי בקרה על כל המשרד — רק למי שיש view:all_work (מוטי, יוכי) ----
  if (userCan(user, "view:all_work")) {
    const fmtFinding = (f: { severity: string; headline: string; who: string; detail: string }) =>
      `[${f.severity}] ${f.headline} — ${f.who}${f.detail ? ` · ${f.detail}` : ""}`;

    tools.push(
      {
        name: "office_overview",
        description: "תמונת מצב כללית של כל המשרד: מספרי משימות פתוחות/באיחור/תקועות, פרויקטים בסיכון, וממצאי מכירות וגבייה. לשאלות כמו 'מה המצב הכללי' / 'מה דורש אותי'.",
        input_schema: { type: "object", properties: {} },
        run: async () => {
          const [ctrl, crm, over] = await Promise.all([runControlScan(), runCrmScan(), getOversightReport(user)]);
          return {
            tasks: { open: over.totals.openTasks, overdue: over.totals.overdue, stuck: over.totals.stuck },
            projectsFlagged: over.totals.projectsFlagged,
            controlFindings: { critical: ctrl.counts.critical, high: ctrl.counts.high, normal: ctrl.counts.normal },
            crmFindings: { high: crm.counts.high, normal: crm.counts.normal },
            topUrgent: [...ctrl.forManager, ...crm.forManager].slice(0, 10).map(fmtFinding),
            decisionsWaiting: crm.decisions.map((d) => `${d.name} — ${d.detail}`),
          };
        },
      },
      {
        name: "person_status",
        description: "מצב העבודה של איש צוות מסוים: כמה משימות פתוחות/באיחור/תקועות יש לו, מה הכי באיחור, ואיזה פרויקטים בסיכון קשורים אליו. לשאלות כמו 'מה קורה אצל דוב'.",
        input_schema: {
          type: "object",
          properties: { name: { type: "string", description: "שם איש הצוות" } },
          required: ["name"],
        },
        run: async (input) => {
          const q = String(input.name ?? "").trim();
          const [over, ctrl] = await Promise.all([getOversightReport(user), runControlScan()]);
          const p = over.people.find((x) => x.name.includes(q) || q.includes(x.name.split(" ")[0]!));
          if (!p) return { error: `לא מצאתי איש צוות בשם "${q}". אפשרויות: ${over.people.map((x) => x.name).join(", ")}` };
          return {
            name: p.name,
            counts: p.counts,
            worst: p.worst,
            findings: ctrl.findings.filter((f) => f.who.includes(p.name)).map(fmtFinding),
          };
        },
      },
      {
        name: "project_status",
        description: "מצב פרויקט מסוים: סטטוס, אחראי, תאריך מסירה, הפעולה הנוכחית, וכל דגל בקרה שקשור אליו. לשאלות כמו 'מה מצב פרויקט בלומינג'.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string", description: "שם הפרויקט או חלק ממנו" } },
          required: ["query"],
        },
        run: async (input) => {
          const q = String(input.query ?? "").trim();
          const [office, ctrl] = await Promise.all([getOfficeState(), runControlScan()]);
          const matches = matchProjectsByQuery(office.projects, q);
          if (matches.length === 0) return { error: `לא מצאתי פרויקט שמתאים ל"${q}".` };
          if (matches.length > 3) return { hint: "יותר מדי התאמות", names: matches.map((p) => p.name).slice(0, 10) };
          const out = [];
          for (const p of matches) {
            const na = await getProjectNextAction(p.itemId).catch(() => null);
            out.push({
              itemId: p.itemId,
              name: p.name,
              status: p.status || "לא הוגדר",
              owner: p.owner || "בלי אחראי",
              deliveryDate: p.deliveryDate ?? null,
              nextAction: na ? `${na.taskName} · ${na.stageName}${na.assignees ? ` (${na.assignees})` : " (לא משויך)"}` : "אין משימה פתוחה",
              findings: ctrl.findings.filter((f) => f.project === p.name).map(fmtFinding),
            });
          }
          return { projects: out };
        },
      },
      {
        name: "list_findings",
        description: "רשימת ממצאי הבקרה, אפשר לסנן. area: tasks (משימות) / projects (פרויקטים) / sales (מכירות ולידים) / collection (גבייה). severity: critical / high / normal. לשאלות כמו 'מה תקוע', 'מה דחוף', 'איזה פרויקטים בסיכון'.",
        input_schema: {
          type: "object",
          properties: {
            area: { type: "string", enum: ["tasks", "projects", "sales", "collection"] },
            severity: { type: "string", enum: ["critical", "high", "normal"] },
          },
        },
        run: async (input) => {
          const [ctrl, crm] = await Promise.all([runControlScan(), runCrmScan()]);
          let list = [...ctrl.findings, ...crm.findings];
          const area = input.area as string | undefined;
          if (area === "projects") list = list.filter((f) => f.kind === "project_stuck" || f.kind === "delivery_overdue");
          else if (area === "sales") list = list.filter((f) => f.project === "מכירות" || f.project === "לידים");
          else if (area === "collection") list = list.filter((f) => f.project === "גבייה");
          else if (area === "tasks")
            list = list.filter(
              (f) => !["מכירות", "לידים", "גבייה"].includes(f.project ?? "") && f.kind !== "project_stuck" && f.kind !== "delivery_overdue",
            );
          if (input.severity) list = list.filter((f) => f.severity === input.severity);
          return { count: list.length, findings: list.slice(0, 25).map(fmtFinding) };
        },
      },
      {
        name: "sales_and_collection",
        description: "מצב מלא של המכירות והגבייה: עסקאות בלי פולו-אפ, הצעות מחיר תלויות, החלטות שמחכות, ותשלומים באיחור עם סכומים. לשאלות כמו 'מה מצב המכירות', 'מה מצב הגבייה'.",
        input_schema: { type: "object", properties: {} },
        run: async () => {
          const crm = await runCrmScan();
          return {
            decisionsWaiting: crm.decisions.map((d) => `${d.name} — ${d.detail}`),
            sales: crm.findings.filter((f) => f.project === "מכירות" || f.project === "לידים").map(fmtFinding),
            collection: crm.findings.filter((f) => f.project === "גבייה").map(fmtFinding),
            paymentsDueToday: crm.paymentsDueToday.map((p) => `${p.label} ${p.amount}`),
          };
        },
      },
      {
        name: "find_lead_or_deal",
        description:
          "מחפש ליד או עסקה ספציפית לפי שם, בכל הסטטוסים (כולל סגורים ומוקפאים) — חיפוש ישיר בבורדי הלידים והעסקאות. השתמש בזה כשמוטי מבקש 'גש לליד X', 'מה מצב העסקה של Y', 'תמצא את הליד של Z'. מחזיר סטטוס, אחראי, תאריך תזכורת ותאריך יצירה.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string", description: "שם הליד/העסקה או חלק ממנו" } },
          required: ["query"],
        },
        run: async (input) => {
          const matches = await searchLeadsAndDeals(String(input.query ?? ""));
          if (matches.length === 0) {
            return { found: false, note: "לא נמצא ליד/עסקה עם השם הזה בשני הבורדים." };
          }
          return {
            found: true,
            matches: matches.map((m) => ({
              board: m.board,
              itemId: m.itemId,
              name: m.name,
              status: m.status || "לא הוגדר",
              owner: m.owner || "בלי אחראי",
              reminderDate: m.reminderDate ?? null,
              createdDate: m.createdDate ?? null,
              extra: m.extra ?? null,
              url: m.url,
            })),
          };
        },
      },
    );
  }

  const normTools: NormTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));

  // ── מפרט הלולאה לכל ניסיון. הלולאה עצמה ב-agentLoop; הניתוב + fallback ב-runRoutedAgent.
  //    כאן רק: הרצת הכלים (עם מעקב כתיבות ל-sideEffect) והגשת תדריך הבוקר מילה-במילה.
  const buildLoop = () => {
    capturedBriefing = null; // איפוס לפני כל ניסיון — כדי שה-fallback ל-SMART יאסוף תדריך מחדש
    return {
      system: systemPrompt(user, opts.about),
      maxTokens: 1024,
      maxTurns: MAX_TURNS,
      messages: history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      tools: normTools,
      // שלב 3F.4: dispatcher כפול — תומך גם ב-Web-local ToolDef הישן (run(input), ~27 כלים, ללא
      // שינוי) וגם ב-ToolDefinition משותף (execute(input,ctx), היום רק create_lead). לא dispatcher
      // שלישי — אותה פונקציה אחת, עם branch לפי isSharedToolDefinition. ה-sideEffect detection
      // (actions.length לפני/אחרי) נשאר אחיד לשני המסלולים.
      executeToolCall: async (call: NormToolCall) => {
        const tool = tools.find((t) => t.name === call.name);
        if (!tool) return { content: `שגיאה: כלי לא ידוע ${call.name}`, sideEffect: false };
        try {
          const before = actions.length; // כלי כתיבה מוסיף ל-actions — כך יודעים אם הייתה תופעת לוואי
          const input = (call.input ?? {}) as Record<string, unknown>;
          let out: unknown;
          if (isSharedToolDefinition(tool)) {
            // בדיקת הרשאה בזמן ההרצה — לא רק בזמן בניית הרשימה — בדיוק כמו ה-defense-in-depth
            // של WhatsApp's canUseTool (orchestrator.ts). Web-local tools (ה-else למטה) לא
            // עוברים בדיקה כזו כרגע — הם ממשיכים בדיוק בהתנהגות הקיימת (אין להם requiredPermission/
            // agentTool על האובייקט כלל, אז אין במה לבדוק).
            if (!isToolAllowedForUser(tool, user)) {
              logger.warn({ tool: call.name, user: user.key }, "כלי נחסם — אין למשתמש הרשאה (בדיקה בזמן הרצה)");
              return { content: `שגיאה: אין הרשאה להשתמש בכלי ${call.name}.`, sideEffect: false };
            }
            out = await tool.execute(input, { user });
            // actions.push/refresh — channel adapter concern, לא חלק מה-ToolDefinition המשותף
            // (tool.execute לא יודע על actions[]/refresh() בכלל). ר' SHARED_TOOL_UI_EFFECT.
            // סדר מפורש, זהה ל-run() wrapper הישן: actions.push קודם, refresh() אחריו, שניהם
            // רק אם execute הצליח (אם זרק — לא מגיעים לכאן בכלל, ה-catch התחתון תופס).
            const uiEffect = SHARED_TOOL_UI_EFFECT[call.name];
            if (uiEffect) {
              actions.push(uiEffect.message(out as { message: string }));
              if (uiEffect.refresh) await refresh();
            }
          } else {
            out = await tool.run(input);
          }
          return { content: JSON.stringify(out), sideEffect: actions.length > before };
        } catch (err) {
          logger.warn({ err, tool: call.name, user: user.key }, "כלי צ'אט תפעולי נכשל");
          return { content: `שגיאה: ${(err as Error).message}`, sideEffect: false };
        }
      },
      finalizeText: (modelText: string) => {
        // אם בסבב הזה נשלף תדריך היום ולא בוצעו עדכונים — מגישים אותו כפי שהוא, עם ברכה קצרה,
        // במקום הניסוח החופשי של המודל (שנוטה לאבד את מבנה 'עכשיו:' לכל פרויקט).
        // לא רלוונטי בתשובה לפנייה יזומה — שם רוצים את התשובה של הכלי.
        if (capturedBriefing && actions.length === 0 && !opts.about) {
          const hour = now.hour;
          const greet = hour < 12 ? "בוקר טוב" : hour < 17 ? "צהריים טובים" : "ערב טוב";
          return `${greet} ${user.name} ☀️\n\n${capturedBriefing}\n\nעל מה מתחילים?`;
        }
        return modelText || null;
      },
    };
  };

  const routed = await runRoutedAgent({
    useCase: "ops_chat",
    latestMessage: history[history.length - 1]?.content ?? "",
    historyLength: history.length,
    canSeeAllWork: userCan(user, "view:all_work"),
    // תשובה לפנייה יזומה → SMART: הבנת הכוונה + הפעולה הנכונה ב-Monday חשובה מהעלות.
    forceTier: opts.about ? "smart" : undefined,
    buildLoop,
    // ל-ops chat "תופעת לוואי" = כתיבה ל-Monday/DB (actions), לא סתם קריאת מידע
    sideEffectCount: () => actions.length,
  });

  return { reply: routed.outcome.text ?? "סליחה, הסתבכתי. אפשר לנסח שוב בקצרה?", actions };
}
