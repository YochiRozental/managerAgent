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

import { performance } from "node:perf_hooks";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { userCan, type IdentifiedUser } from "../identity/index.js";
import {
  fetchUserOpsTasks,
  getProjectNextAction,
  getReverseDependencyMapDiagnostics,
  getUserTasksFetchDiagnostics,
  matchProjectsByQuery,
  type OpsTask,
  type ReverseDependencyMapDiagnostics,
  type UserTasksFetchStep,
} from "../integrations/monday/opsRead.js";
import {
  addCommitment,
  closeCommitment,
  listUserCommitments,
} from "../db/repositories/commitments.js";
import { logger } from "../utils/logger.js";
import { runCentralAgent } from "../ai/routedAgent.js";
import type { RunModelFn } from "../ai/agentLoop.js";
import type { AiConfig } from "../ai/tierConfig.js";
import type { ModelTier } from "../ai/models.js";
import { buildSystemPrompt, buildWebPromptCacheSplit } from "../ai/prompt.js";
import type { ToolDefinition } from "../ai/toolRegistry.js";
import { dispatchToolDefinition } from "../ai/dispatcher.js";
import { toNormMessages, toNormTools } from "../ai/normalize.js";
import {
  buildSharedToolDefinition,
  filterSharedToolsForUser,
  requireAgentTool,
  type SharedToolProjection,
  type SharedToolVisibilityEntry,
} from "../ai/sharedTools.js";
import type { NormTool, NormToolCall } from "../ai/providers/types.js";
import type { AgentTool } from "./agentTools.js";
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
import { getOfficeState, getOfficeStateDiagnostics, type OfficeStateDiagnostics } from "./officeState.js";
import { getOversightReport } from "./oversight.js";
import { getEmployeeFeed, formatEmployeeFeedText, formatEmployeeFeedBriefing, employeeFeedCounts } from "./employeeFeed.js";
import { attendanceEnabledForUser, checkAttendanceDayStart } from "./attendance.js";
import { buildMessageIdempotencySeed } from "./attendanceEngine.js";
import { countUserMessagesInSession } from "../db/repositories/chatHistory.js";

const MAX_TURNS = 7;

/**
 * Step 3F.6 (2026-10-07) — כל תשעת ה-ToolDefinition האלה נבנים עכשיו דרך buildSharedToolDefinition
 * (src/ai/sharedTools.ts), לא ביד: אין יותר תשעה אובייקטים עם אותו דפוס execute שחזר על עצמו
 * מילה-במילה (requireIdentifiedUser ואז agentTool.execute). שבעה מהם (כל מי שאין לו projection
 * כאן) מקבלים name/description/input_schema/requiredPermission *זהים בערכם* למה שהיה מוצהר ביד
 * קודם (==="AgentTool's own values", לא פרויקציה) — ר' audit Phase 1 ב-3F.6. אף אחד מה-9 לא
 * מקבל projection כלשהו ב-Web (בשונה מ-WhatsApp's add_monday_update/create_lead, ר' tools.ts) —
 * Web חושף את ה-AgentTool "כמו שהוא" בכל התשעה.
 */
export const CREATE_TASK_AGENT_TOOL: AgentTool = requireAgentTool("create_task", "Web");
export const CREATE_TASK_TOOL_DEFINITION: ToolDefinition = buildSharedToolDefinition(CREATE_TASK_AGENT_TOOL);

export const CREATE_LEAD_AGENT_TOOL: AgentTool = requireAgentTool("create_lead", "Web");
export const CREATE_LEAD_TOOL_DEFINITION: ToolDefinition = buildSharedToolDefinition(CREATE_LEAD_AGENT_TOOL);

export const MARK_DONE_AGENT_TOOL: AgentTool = requireAgentTool("mark_done", "Web");
export const SET_STATUS_AGENT_TOOL: AgentTool = requireAgentTool("set_status", "Web");
export const ADD_NOTE_AGENT_TOOL: AgentTool = requireAgentTool("add_note", "Web");
export const REPORT_BLOCKER_AGENT_TOOL: AgentTool = requireAgentTool("report_blocker", "Web");
export const ADD_UPDATE_AGENT_TOOL: AgentTool = requireAgentTool("add_update", "Web");

export const MARK_DONE_TOOL_DEFINITION: ToolDefinition = buildSharedToolDefinition(MARK_DONE_AGENT_TOOL);
export const SET_STATUS_TOOL_DEFINITION: ToolDefinition = buildSharedToolDefinition(SET_STATUS_AGENT_TOOL);
export const ADD_NOTE_TOOL_DEFINITION: ToolDefinition = buildSharedToolDefinition(ADD_NOTE_AGENT_TOOL);
export const REPORT_BLOCKER_TOOL_DEFINITION: ToolDefinition = buildSharedToolDefinition(REPORT_BLOCKER_AGENT_TOOL);
export const ADD_UPDATE_TOOL_DEFINITION: ToolDefinition = buildSharedToolDefinition(ADD_UPDATE_AGENT_TOOL);

export const CREATE_PROJECT_STAGE_AGENT_TOOL: AgentTool = requireAgentTool("create_project_stage", "Web");
export const CREATE_PROJECT_STAGE_TOOL_DEFINITION: ToolDefinition = buildSharedToolDefinition(CREATE_PROJECT_STAGE_AGENT_TOOL);

export const REASSIGN_ITEM_AGENT_TOOL: AgentTool = requireAgentTool("reassign_item", "Web");
export const REASSIGN_ITEM_TOOL_DEFINITION: ToolDefinition = buildSharedToolDefinition(REASSIGN_ITEM_AGENT_TOOL);

/**
 * find_lead/update_lead_contact (2026-10-08) — סוגרים את פער "פרטי קשר שמגיעים בהמשך לא נשמרים
 * בעמודות הנכונות של ליד קיים" (audit 2026-10-08). אותו דפוס בדיוק כמו כל שאר ה-AgentTools: אין
 * כאן שום לוגיקה עסקית, רק buildSharedToolDefinition מעל ה-AgentTool המשותף.
 */
export const FIND_LEAD_AGENT_TOOL: AgentTool = requireAgentTool("find_lead", "Web");
export const FIND_LEAD_TOOL_DEFINITION: ToolDefinition = buildSharedToolDefinition(FIND_LEAD_AGENT_TOOL);

export const UPDATE_LEAD_CONTACT_AGENT_TOOL: AgentTool = requireAgentTool("update_lead_contact", "Web");
export const UPDATE_LEAD_CONTACT_TOOL_DEFINITION: ToolDefinition = buildSharedToolDefinition(UPDATE_LEAD_CONTACT_AGENT_TOOL);

/**
 * מודול נוכחות (שלב ג, 2026-10-11) — 5 כלים נוספים, ב-registry המשותף מהתחלה (ops/agentTools.ts),
 * לא Web-local: ר' דוח המימוש §4 (חיבור ל-WhatsApp בעתיד = להוסיף את השם לרשימת הכלים שם, בלי קוד
 * חדש). **לא** ב-WEB_SHARED_TOOL_VISIBILITY/WIRED_AGENT_TOOL_NAMES הקיימים בכוונה — אלה מתעדים
 * מיגרציה היסטורית סגורה (9+2 כלים) ואין להם שום מנגנון flag+pilot; הנוכחות צריכה שער נוסף
 * (attendanceEnabledForUser) מעבר ל-isToolAllowedForUser הרגיל, אז יש לה טבלת visibility נפרדה
 * (ATTENDANCE_TOOL_VISIBILITY, למטה) שנדחפת ל-tools[] רק אם attendanceEnabledForUser(user).
 * transformInput מזריק messageSeed — host-injected, לא חלק מה-input_schema שהמודל רואה (בדיוק
 * כמו WhatsApp's normalizeTaskSource) — buildMessageIdempotencySeed מחושב *פעם אחת* ב-runOpsChat
 * (לא כאן, לא בכל כלי בנפרד) כדי שכל הכלים בסבב הזה יקבלו בדיוק את אותו seed.
 */
export const ATTENDANCE_BREAK_START_AGENT_TOOL: AgentTool = requireAgentTool("attendance_break_start", "Web");
export const ATTENDANCE_BREAK_END_AGENT_TOOL: AgentTool = requireAgentTool("attendance_break_end", "Web");
export const ATTENDANCE_DAY_CLOSE_AGENT_TOOL: AgentTool = requireAgentTool("attendance_day_close", "Web");
export const ATTENDANCE_SET_REMINDER_AGENT_TOOL: AgentTool = requireAgentTool("attendance_set_reminder", "Web");
export const ATTENDANCE_REPORT_CORRECTION_AGENT_TOOL: AgentTool = requireAgentTool("attendance_report_correction", "Web");
/** audit שלב ז (2026-10-13) — קריאה בלבד, אין לה messageSeed/תופעת-לוואי, לכן לא בתוך
 *  buildAttendanceToolDefinitions (שקיים כי *לאלה* יש messageSeed שמשתנה פר-קריאה). */
export const ATTENDANCE_DAY_STATUS_AGENT_TOOL: AgentTool = requireAgentTool("attendance_day_status", "Web");
export const ATTENDANCE_DAY_STATUS_TOOL_DEFINITION: ToolDefinition = buildSharedToolDefinition(ATTENDANCE_DAY_STATUS_AGENT_TOOL);

function withMessageSeed(messageSeed: string): SharedToolProjection {
  return { transformInput: (input) => ({ ...input, messageSeed }) };
}

/** נבנה פר-קריאת runOpsChat (לא מודול-level כמו שאר ה-TOOL_DEFINITION-ים) כי messageSeed משתנה
 *  מסבב לסבב — ר' buildAttendanceToolVisibility למטה. */
function buildAttendanceToolDefinitions(messageSeed: string) {
  const proj = withMessageSeed(messageSeed);
  return {
    breakStart: buildSharedToolDefinition(ATTENDANCE_BREAK_START_AGENT_TOOL, proj),
    breakEnd: buildSharedToolDefinition(ATTENDANCE_BREAK_END_AGENT_TOOL, proj),
    dayClose: buildSharedToolDefinition(ATTENDANCE_DAY_CLOSE_AGENT_TOOL, proj),
    setReminder: buildSharedToolDefinition(ATTENDANCE_SET_REMINDER_AGENT_TOOL, proj),
    reportCorrection: buildSharedToolDefinition(ATTENDANCE_REPORT_CORRECTION_AGENT_TOOL, proj),
  };
}

/**
 * audit שלב ז (2026-10-13) — תקלת 13/10: הסוכן טען "רשמתי — חזרת ב-12:28" (ניסוח חופשי, לא
 * תוצאת כלי) כש-אף כלי לא רץ בפועל (turns=1, אפס tool_use בלוג). אלה הם הפתיחים המדויקים
 * שהתבניות הקיימות (attendance.ts) מפיקות בהצלחה — אם המודל מפיק את אחד מהם *בלי* שהתבצע כלי
 * נוכחות אמיתי בסבב הזה (ר' liveAttendanceConfirmation ב-runOpsChat), זה חשוד כניסוח-חופשי
 * שמחקה הצלחה, לא הצלחה אמיתית. לא נועד לפרש כוונת-משתמש (regex על מה שהמשתמש אמר) — רק לזהות
 * שהמודל *עצמו* מייצר פלט שתואם *לתבניות הקנוניות של המערכת עצמה*, בלי גיבוי.
 */
const ATTENDANCE_CONFIRMATION_PATTERNS: RegExp[] = [
  /רשמתי\s*—\s*יצאת\s+ב-?\d{1,2}:\d{2}/,
  /רשמתי\s*—\s*חזרת\s+ב-?\d{1,2}:\d{2}/,
  /סיימתי את דיווח הנוכחות שלך להיום/,
  /התיקון (נשמר|אושר)/,
  /העברתי את בקשת התיקון למוטי/,
];
function matchesCannedAttendanceConfirmation(text: string): boolean {
  return ATTENDANCE_CONFIRMATION_PATTERNS.some((re) => re.test(text));
}

/**
 * audit שלב ח (2026-10-13) — בדיקת-המוכנות גילתה שה-guard לעיל תלוי בניסוח *הפלט* של המודל: אם
 * המודל מאשר הצלחה במילים אחרות (למשל "סידרתי, הכול טוב" במקום אחד מ-5 התבניות) — אין גיבוי
 * אמיתי *וגם* אין התאמת-תבנית, אז שום דבר לא תופס. התיקון: זיהוי *בקשת-הפעולה* מתוך הודעת
 * המשתמש (לא תשובת המודל) — אותו אוצר-מילים שה-system prompt (ai/prompt.ts) כבר מצהיר עליו
 * כטריגר לכלי נוכחות. במכוון לא תופס שאלות-מידע ("מה רשום לי", "כמה עבדתי", "אני בעבודה או
 * בהפסקה?") — אלה attendance_day_status, לא בקשת-ביצוע (דרישה מפורשת: לשמור על ההפרדה).
 */
const ATTENDANCE_ACTION_INTENT_PATTERNS: RegExp[] = [
  /^(אני\s+)?יוצאת?\s+(עכשיו|להפסקה|לכמה דקות)/, // "אני יוצא עכשיו" / "יוצאת להפסקה"
  /יצאתי\s+(עכשיו|להפסקה|לכמה דקות)/, // "יצאתי עכשיו" / "יצאתי להפסקה"
  /^הפסקה\s+של\s+\d+/, // "הפסקה של 10 דק'"
  /^חזרתי(?:\s|$)/, // "חזרתי", "חזרתי לעבוד..." — לא \b: Hebrew אינו \w ב-JS regex, \b לא עובד כצפוי כאן
  /^אני\s+ממשיך\s+לעבוד/, // "אני ממשיך לעבוד"
  /סיימתי\s+(את העבודה\s+)?להיום/, // "סיימתי להיום"
  /זהו,?\s*סיימתי\s+לעבוד/, // "זהו, סיימתי לעבוד"
  /תעדכן\s+ש(חזרתי|יצאתי|התחלתי|סיימתי)/, // "תעדכן שחזרתי ב-12:28" (תיקון)
  /שכחתי\s+לדווח/, // "שכחתי לדווח שחזרתי מההפסקה" (תיקון)
  /(אתמול|היום)\s+(סיימתי|התחלתי)\s+ב/, // "אתמול סיימתי בארבע" / "התחלתי היום בתשע" (תיקון)
];
function looksLikeAttendanceActionRequest(text: string): boolean {
  const t = text.trim();
  return ATTENDANCE_ACTION_INTENT_PATTERNS.some((re) => re.test(t));
}
/** מילות-השלמה גנריות — רחבות יותר מ-5 התבניות המדויקות למעלה, בכוונה: בשילוב עם בקשת-פעולה
 *  מהמשתמש (looksLikeAttendanceActionRequest) זה מספיק לתפוס "סידרתי, הכול טוב" גם בלי שהמודל
 *  חזר על התבנית הקנונית. תגובה שלא טוענת כלום (שאלת-הבהרה כמו "באיזו שעה בדיוק?") לא מכילה
 *  אף אחת מהן — לא נחסמת, בדיוק הדרישה (לא לחסום שאלות/הודעות רגילות). */
const GENERIC_COMPLETION_MARKERS = ["רשמתי", "נרשם", "סודר", "סידרתי", "בוצע", "עודכן", "נקלט"];
function soundsLikeCompletionClaim(text: string): boolean {
  return GENERIC_COMPLETION_MARKERS.some((w) => text.includes(w));
}
/** שמות הכלים שעלולים "לאשר פעולה" — אם אחד מהם רץ בהצלחה, יש גיבוי אמיתי; אם לא, וגם הטקסט
 *  תואם לתבנית למעלה, זה חשד לאישור-שקרי (ר' docstring מעל ATTENDANCE_CONFIRMATION_PATTERNS). */
const ATTENDANCE_LIVE_CONFIRMATION_TOOLS = new Set([
  "attendance_break_start",
  "attendance_break_end",
  "attendance_day_close",
  "attendance_report_correction",
]);

/**
 * Step 3F.6 — ה-visibility policy המוצהר, אחד לכל אחד מ-9 הכלים: "always" = נדחף ל-tools[] ללא
 * תנאי (מה שהיה "נדחף בלי if" בקוד הישן — mark_done/set_status/add_note/report_blocker/add_update,
 * documented discrepancy מ-3F.5B — ר' docstring מעל ADD_UPDATE_TOOL_DEFINITION למעלה למה). "gated"
 * = isToolAllowedForUser הרגיל (מה שהיה "if (isToolAllowedForUser(X,user)) tools.push(X)" בקוד
 * הישן — reassign_item/create_task/create_project_stage/create_lead). filterSharedToolsForUser
 * (src/ai/sharedTools.ts) הוא המקום היחיד שמחליט בפועל לפי הטבלה הזו — לא עוד if מפוזרים בגוף
 * runOpsChat. שינוי ה-policy של כלי כלשהו כאן *הוא* שינוי product/permission (לא structural) —
 * מודגש בכוונה כטבלה אחת גלויה, לא קוד מפוזר, בדיוק כדי שהחלטה כזו תהיה קלה-לראות.
 */
export const WEB_SHARED_TOOL_VISIBILITY: SharedToolVisibilityEntry[] = [
  { tool: MARK_DONE_TOOL_DEFINITION, visibility: "always" },
  { tool: SET_STATUS_TOOL_DEFINITION, visibility: "always" },
  { tool: ADD_NOTE_TOOL_DEFINITION, visibility: "always" },
  { tool: REPORT_BLOCKER_TOOL_DEFINITION, visibility: "always" },
  { tool: ADD_UPDATE_TOOL_DEFINITION, visibility: "always" },
  { tool: REASSIGN_ITEM_TOOL_DEFINITION, visibility: "gated" },
  { tool: CREATE_TASK_TOOL_DEFINITION, visibility: "gated" },
  { tool: CREATE_PROJECT_STAGE_TOOL_DEFINITION, visibility: "gated" },
  { tool: CREATE_LEAD_TOOL_DEFINITION, visibility: "gated" },
  { tool: FIND_LEAD_TOOL_DEFINITION, visibility: "gated" },
  { tool: UPDATE_LEAD_CONTACT_TOOL_DEFINITION, visibility: "gated" },
];

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
  FIND_LEAD_AGENT_TOOL.name,
  UPDATE_LEAD_CONTACT_AGENT_TOOL.name,
];

export const WEB_CHAT_LOCAL_TOOL_NAMES: readonly string[] = [
  // "מה יש לי היום" + זיהוי משימה
  "get_today_tasks",
  "find_task",
  // לידים/עסקאות/משימות באחריות העובד, מסונן group+תאריך (סעיף 2026-10-08)
  "get_my_pipeline",
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

/**
 * ניטור ביצועים (2026-10-14, הרחבה) — רשומה אחת לכלי/שלב-הכנה בודד: שם + משך + הצלחה/כשל בלבד.
 * אין כאן ארגומנטים של כלי, תוכן הודעה, תוצאת כלי, מזהה לקוח או פרטי פרויקט — ר' chat_perf_steps
 * ב-schema.sql. durationMs לכלים הוא *אותו* משך שכבר נספר לתוך OpsChatPerf.toolTimeMs
 * (agentLoop.ts's onToolTiming) — לא טיימר נוסף, לא נספר פעמיים.
 */
export interface PerfStepRecord {
  name: string;
  durationMs: number;
  ok: boolean;
}

export interface OpsChatPerf {
  aiTimeMs: number;
  aiCallCount: number;
  toolTimeMs: number;
  toolCallCount: number;
  /** כמה פעמים הורץ runCentralAgent בפועל — fallback FAST→SMART נספר *בתוך* קריאה אחת (ר'
   *  RoutedAgentPerf.attempts); זה סופר ניסיונות runAttempt חוצי-קריאה (רק retry אישור הנוכחות). */
  attempts: number;
  tier: ModelTier;
  fallbackUsed: boolean;
  /** פירוט כל קריאת כלי בודדת בסבב הזה (על פני כל הניסיונות) — ר' PerfStepRecord. */
  toolCalls: PerfStepRecord[];
  /** שלבי I/O לפני שה-AI loop בכלל מתחיל (fetchUserOpsTasks וכו') — זמן *שאינו* נכלל ב-aiTimeMs/toolTimeMs. */
  prepSteps: PerfStepRecord[];
}

export interface OpsChatResult {
  reply: string;
  /** תיאור קצר של כל עדכון שבוצע ב-Monday בסבב הזה — לרענון הרשימה ולתצוגה */
  actions: string[];
  /**
   * ניטור ביצועים (2026-10-14) — undefined כשלא רצה AI כלל בסבב הזה (למשל תשובת approval
   * שנענית בלי לעבור דרך runCentralAgent, או משתמש בלי mondayUserId). ר' agentLoop.ts/
   * routedAgent.ts — אין כאן תוכן, רק משכי זמן.
   */
  perf?: OpsChatPerf;
}

/**
 * שלב 3F.1 (2026-10-07): התוכן הועבר ל-src/ai/prompt.ts (buildSystemPrompt) — זה עכשיו adapter
 * דק בלבד, בלי שינוי טקסט/behavior (ר' test-shared-prompt.ts). מיוצא עדיין (ללא שינוי חתימה)
 * כי test-create-task-prompt.ts/test-create-task-behavior.ts/test-project-stage-behavior.ts
 * מייבאים אותו ישירות מ-"./chat.js".
 */
export function systemPrompt(user: IdentifiedUser, about?: LoopContext): string {
  return buildSystemPrompt({ channel: "web", user, about, attendanceEnabled: attendanceEnabledForUser(user) });
}

/**
 * ניסוי Prompt Caching (2026-10-14) — ממיר את הפיצול של buildWebPromptCacheSplit לשם השדות
 * שה-provider מצפה להם (RunModelParams.promptCaching). attendanceEnabled מחושב **באותו אופן
 * בדיוק** כמו ב-systemPrompt למעלה (attendanceEnabledForUser(user), לא attendanceOn/ה-override
 * לבדיקות) — כדי ששני הפיצולים (הרגיל וה-cacheable) יתארו בדיוק את אותו טקסט לאותם user/about.
 */
export function buildPromptCachingSplitFor(user: IdentifiedUser, about?: LoopContext): { cacheableSystem: string; volatileSystemSuffix: string } {
  const split = buildWebPromptCacheSplit(user, about, attendanceEnabledForUser(user));
  return { cacheableSystem: split.cacheable, volatileSystemSuffix: split.volatile };
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
 * תדריך "היום שלי" הישן, מקובץ לפי פרויקט עם שורת "עכשיו:" לכל פרויקט (הפעולה הבאה המחושבת).
 *
 * **לא נקרא יותר מ-get_today_tasks** (2026-10-13, דרישת מוטי): התשובה למשתמש על "מה יש לי
 * היום" היא כעת רק Employee Feed (formatEmployeeFeedBriefing) — התדריך הזה והתדריך של חמש
 * הקטגוריות הוצגו ברצף, כפולים וארוכים. הפונקציה נשארת מוגדרת בכוונה (לא נמחק מנגנון ישן —
 * ר' הנחיית מוטי) למקרה שתידרש שוב (לדוגמה כתשובה נפרדת ל"מה הצעד הבא בפרויקטים שלי"), אך
 * כיום אין קורא לה בכלל.
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

/**
 * person_status — פירוק מלא לפי פרויקטים (2026-10-18, המשך audit "פירוט חלקי כאילו מלא").
 *
 * שני הסנטינלים הקיימים ל"אין פרויקט" (ר' buildTodayBriefing למעלה, ו-opsRead.ts): "משימת משרד"
 * (משימה כללית בבורד המשימות, בלי קישור) ו-"פרויקט לא מקושר" (subitem ששלב/פרויקט שלו לא הצליח
 * להיפתר). שתיהן נכנסות לדלי "ללא פרויקט" אחד, לא לשני דליים — הן שתיהן "העובד לא עובד תחת שום
 * פרויקט בפריט הזה", רק ממקור שונה.
 */
const NO_PROJECT_CONTEXTS = new Set(["משימת משרד", "פרויקט לא מקושר"]);
function isNoProjectTask(t: DashboardTask): boolean {
  return !t.projectId && NO_PROJECT_CONTEXTS.has(t.context);
}

export interface PersonProjectCounts {
  open: number;
  overdue: number;
  stuck: number;
  blocking: number;
  dueToday: number;
}
export interface PersonProjectBreakdown extends PersonProjectCounts {
  project: string;
  projectId?: string;
}
export interface PersonTaskBreakdown {
  /** ממוין overdue→stuck→open יורד, כדי שאם יש חיתוך (byProjectTruncated) הוא יחתוך את הכי-פחות-חשוב. */
  byProject: PersonProjectBreakdown[];
  /** true ⇐ יש לעובד יותר פרויקטים מ-PERSON_BYPROJECT_CAP — ר' docstring שם. היום (6 אנשי צוות,
   *  עד כמה עשרות פרויקטים לאדם) זה לא צפוי לקרות בפועל, אבל חובה לדווח את זה אם כן (לא להציג
   *  פירוק חלקי כאילו הוא מלא — בדיוק התקלה שהביאה לתיקון הזה). */
  byProjectTruncated: boolean;
  /** כמה פרויקטים שונים יש לעובד בפועל — גם אם byProject נחתך, השדה הזה תמיד מדויק. */
  totalProjects: number;
  /** קבוצה נפרדת (לא עוד שורה ב-byProject) למשימות בלי שיוך לפרויקט — דרישה מפורשת. */
  withoutProject: PersonProjectCounts;
}

/** סף בטיחות — לא אמור להיחתך בפועל היום (אדם בודד לא מגיע לעשרות פרויקטים), אבל קיים כדי שלעולם
 *  לא נציג "זו הרשימה המלאה" כש-היא לא. ר' byProjectTruncated. */
export const PERSON_BYPROJECT_CAP = 40;

/**
 * פונקציה טהורה — פירוק מלא, לא-חלקי, של כל משימות העובד (DashboardTask[], כבר במטמון דרך
 * getOfficeState — אין כאן שום I/O) לפי פרויקט. ה-counts בכל דלי נספרים *ישירות* מתוך tasks (לא
 * ממוחזרים מ-oversight.ts/controlScan.ts), ו-byProject+withoutProject הם partition מלא ומוציא-
 * הדדי של tasks (כל משימה בדיוק בדלי אחד) — לכן סכום הפתוחות על פני byProject+withoutProject שווה
 * **בהכרח** ל-tasks.length, בלי ספירה כפולה ובלי תלות בעוד חישוב-counts במקום אחר שעלול להתפזר.
 */
export function buildPersonProjectBreakdown(tasks: DashboardTask[]): PersonTaskBreakdown {
  const byProjectMap = new Map<string, PersonProjectBreakdown>();
  const withoutProject: PersonProjectCounts = { open: 0, overdue: 0, stuck: 0, blocking: 0, dueToday: 0 };

  const bump = (bucket: PersonProjectCounts, t: DashboardTask) => {
    bucket.open++;
    if (t.flags.overdue) bucket.overdue++;
    if (t.flags.stuck) bucket.stuck++;
    if (t.flags.blocking.length > 0) bucket.blocking++;
    if (t.flags.dueToday) bucket.dueToday++;
  };

  for (const t of tasks) {
    if (isNoProjectTask(t)) {
      bump(withoutProject, t);
      continue;
    }
    const key = t.projectId ?? t.context;
    let bucket = byProjectMap.get(key);
    if (!bucket) {
      bucket = { project: t.context, projectId: t.projectId, open: 0, overdue: 0, stuck: 0, blocking: 0, dueToday: 0 };
      byProjectMap.set(key, bucket);
    }
    bump(bucket, t);
  }

  const all = [...byProjectMap.values()].sort(
    (a, b) => b.overdue - a.overdue || b.stuck - a.stuck || b.open - a.open,
  );
  return {
    byProject: all.slice(0, PERSON_BYPROJECT_CAP),
    byProjectTruncated: all.length > PERSON_BYPROJECT_CAP,
    totalProjects: all.length,
    withoutProject,
  };
}

/**
 * חיפוש מחרוזת-חלקית, case-insensitive, בין ה-byProject buckets שחושבו כבר (לא בין tasks גולמיים)
 * — רק בין הפרויקטים שבאמת קיימים אצל העובד הזה (לא כל המשרד). scope מכוון, זה מה שהמשתמש ראה
 * בתשובה הקודמת. **מחזיר buckets שלמים (project+projectId), לא רק שם** — תיקון (2026-10-18, audit
 * טרום-פריסה): שני byProject buckets יכולים לשתף שם תצוגה זהה (`project`) כש-יש להם projectId
 * שונה (למשל שגיאת הקלדה/כפילות ב-Monday, או אין projectId כלל והשם זהה במקרה). אם matchPersonProjects
 * היה מחזיר רק מחרוזות-שם, buildPersonProjectDrilldown לא היה יכול להבחין בין שני הבאקטים האלה
 * ועלול היה למזג משימות משני פרויקטים שונים לתוך אותה תשובה — בדיוק מה שהדריש' "אין להחזיר משימות
 * מפרויקט אחר" אוסר. עכשיו: שני באקטים עם שם זהה אבל projectId שונה הם *שתי* התאמות נפרדות (לא
 * אחת) → נכנסים ל-branch של "יותר מדי התאמות" ונשאלים, לא ממוזגים בשקט.
 */
/**
 * נרמול רווחים (2026-10-18, audit בקשות-המשך) — מכווץ כל רצף whitespace למרווח בודד ו-trim,
 * משני הצדדים (גם query וגם p.project — קודם היה רק query). **לא** fuzzy matching: לא סולח על
 * שגיאות כתיב (למשל "המשבה" מול "המושבה", מקרה אמיתי שנצפה) — רק על הבדלי-רווח. כוונה מפורשת
 * (דרישה 3): fuzzy-matching אמיתי (מרחק-ערוך) מסוכן כאן — יכול "לקרב" בטעות שני פרויקטים שונים.
 */
function normalizeForMatch(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export function matchPersonProjects(byProject: PersonProjectBreakdown[], query: string): PersonProjectBreakdown[] {
  const q = normalizeForMatch(query);
  if (!q) return [];
  return byProject.filter((p) => normalizeForMatch(p.project).includes(q));
}

export interface ProjectIndexResolution {
  ok: boolean;
  project?: PersonProjectBreakdown;
  reason?: "out_of_range" | "ambiguous_order";
  /** כש-reason="ambiguous_order": כל הפרויקטים שמתחרים על אותו מיקום (אותו overdue/stuck/open). */
  candidates?: PersonProjectBreakdown[];
}

/** מפתח-המיון של buildPersonProjectBreakdown, כמחרוזת להשוואת-שוויון. */
function sortTieKey(p: PersonProjectBreakdown): string {
  return `${p.overdue}|${p.stuck}|${p.open}`;
}

/**
 * פותר "הפרויקט הראשון/השני/האחרון ברשימה" (2026-10-18, audit בקשות-המשך) — דטרמיניסטי, בלי
 * תלות בכך שהמודל משחזר נכון שם טקסטואלי מהתשובה הקודמת (ר' docstring מעל buildPersonProjectBreakdown
 * על למה זה שבור: ההיסטוריה ששומרת chatHistory.ts היא פרוזה חופשית, לא ה-JSON המדויק).
 *
 * index1Based: 1=ראשון, 2=שני... שלילי סופר מהסוף (-1=אחרון, -2=לפני-אחרון...), תואם למה שהמשתמש
 * אומר ("האחרון ברשימה") בלי שהמודל יצטרך לדעת/לזכור את totalProjects המדויק.
 *
 * דרישה 1 ("אם אי אפשר להבטיח — אל תנחש, החזר הבהרה"): byProject ממוין דטרמיניסטית לפי ערכים
 * (overdue/stuck/open), אז כל עוד הערכים האלה לא השתנו בין שתי הקריאות (נכון כל עוד שתיהן נופלות
 * באותו cache window של getOfficeState, 3 דק') — הסדר היחסי בין פרויקטים עם ערכים *שונים* משוחזר
 * באופן זהה, תלוי-ערך בלבד. אבל שני פרויקטים עם *אותם* overdue/stuck/open יכולים להחליף מקום
 * ביניהם בין fetch-ים שונים (סדר ה-items מ-Monday לא מובטח) — Array.sort יציב רק *בתוך* אותה
 * קריאת sort, לא בין שתי קריאות fetch נפרדות. לכן: אם המיקום המבוקש מעורב ב-tie כזה (קבוצה שלמה
 * של buckets עם אותו מפתח — ר' sortTieKey, יציב/רציף בזכות המיון), מחזירים ambiguous_order ולא
 * מנחשים — המודל מתבקש לשאול/לבקש לפי שם.
 */
export function resolveProjectByIndex(byProject: PersonProjectBreakdown[], index1Based: number): ProjectIndexResolution {
  if (!Number.isInteger(index1Based) || index1Based === 0) return { ok: false, reason: "out_of_range" };
  const i = index1Based > 0 ? index1Based - 1 : byProject.length + index1Based;
  if (i < 0 || i >= byProject.length) return { ok: false, reason: "out_of_range" };

  const target = byProject[i]!;
  const key = sortTieKey(target);
  const tiedGroup = byProject.filter((p) => sortTieKey(p) === key);
  if (tiedGroup.length > 1) return { ok: false, reason: "ambiguous_order", candidates: tiedGroup };
  return { ok: true, project: target };
}

export interface PersonProjectTaskDetail {
  itemId: string;
  name: string;
  stageName?: string;
  dueDate?: string;
  status: string;
  priority?: string;
  overdue: boolean;
  daysOverdue: number;
  dueToday: boolean;
  stuck: boolean;
  blockingCount: number;
  url: string;
}
export interface PersonProjectDrilldown {
  project: string;
  tasks: PersonProjectTaskDetail[];
  /** כמה משימות התאימו בפועל לפרויקט הזה — גם אם tasks נחתך (truncated). */
  totalMatching: number;
  truncated: boolean;
}

/**
 * פירוט מלא (לא counts) של משימות העובד בפרויקט ספציפי אחד — scope קטן בהגדרה (פרויקט בודד), אבל
 * עדיין עם cap+truncated מפורש כדי לא להבטיח "השלמות" בלי לבדוק אותה.
 *
 * מסנן לפי **אותו מפתח בדיוק** שבו buildPersonProjectBreakdown קיבץ את ה-bucket הזה
 * (`projectId ?? context`) — לא לפי `context` גולמי. זה מה שמבטיח שלא "יזלגו" לתשובה משימות
 * מפרויקט *אחר* שרק קורה לחלוק את אותו שם תצוגה (ר' docstring מעל matchPersonProjects).
 */
export function buildPersonProjectDrilldown(tasks: DashboardTask[], target: PersonProjectBreakdown): PersonProjectDrilldown {
  const key = target.projectId ?? target.project;
  const matching = tasks.filter((t) => !isNoProjectTask(t) && (t.projectId ?? t.context) === key);
  const limited = matching.slice(0, PERSON_BYPROJECT_CAP);
  return {
    project: target.project,
    tasks: limited.map((t) => ({
      itemId: t.itemId,
      name: t.name,
      stageName: t.stageName,
      dueDate: t.dueDate,
      status: t.status,
      priority: t.priority,
      overdue: t.flags.overdue,
      daysOverdue: t.flags.daysOverdue,
      dueToday: t.flags.dueToday,
      stuck: t.flags.stuck,
      blockingCount: t.flags.blocking.length,
      url: t.url,
    })),
    totalMatching: matching.length,
    truncated: matching.length > limited.length,
  };
}

export interface PersonProjectWithTasks extends PersonProjectBreakdown {
  tasks: PersonProjectTaskDetail[];
  /** true ⇐ לפרויקט הזה עצמו יש יותר משימות מ-PERSON_BYPROJECT_CAP (40) — נחתך גם בתוך ה-detail הזה. */
  taskListTruncated: boolean;
}
export interface PersonFullDetail {
  /** ממוין overdue→stuck→open יורד (אותו סדר כמו byProject) — הפרויקטים הכי-חשובים ראשונים, כך
   *  שאם יש חיתוך-כולל, הוא חותך את הכי-פחות-חשובים, לא באקראי. */
  projects: PersonProjectWithTasks[];
  /** כמה פרויקטים הוצגו עם פירוט מלא, מתוך כמה יש בסה"כ. */
  projectsShown: number;
  totalProjects: number;
  /** כמה משימות הוצגו בפועל (סכום על פני projects[].tasks), מתוך הכלל (סכום counts.open). */
  tasksShown: number;
  tasksTotal: number;
  /** true ⇐ לא כל הפרויקטים/המשימות הוצגו — דרישה 2: לעולם לא "זו הרשימה המלאה" כש-היא לא. */
  truncated: boolean;
}

/** סף נפרד (לא PERSON_BYPROJECT_CAP) — זה מצב "תן לי הכול" מכוון (detail=true), לא ברירת המחדל,
 *  אז מתירים יותר: 150 מכסה בנוחות כל חבר צוות קיים (הגבוה ביותר שנצפה: ~109 משימות פתוחות) גם
 *  אם הן מפוזרות על כמה פרויקטים, בלי להתנפח לאינסוף אם המשרד יגדל בהרבה בעתיד. */
export const PERSON_FULL_DETAIL_CAP = 150;

/**
 * פירוט מלא (לא רק counts) של *כל* הפרויקטים של העובד בבת אחת — דרישה 2 ("תפרק לי את כל המשימות
 * שלו לפי פרויקטים"). בונה על buildPersonProjectDrilldown הקיים פר-פרויקט (אותו מפתח projectId??
 * context, אותה בדיקת בידוד) — לא לוגיקת-סינון נפרדת. חותך בגבולות-פרויקט (לא בתוך פרויקט) לפי
 * סדר byProject (הכי-חשוב קודם), כדי שלעולם לא יוצג פרויקט "חצי" בלי האזהרה המתאימה.
 */
export function buildPersonFullDetail(tasks: DashboardTask[], byProject: PersonProjectBreakdown[]): PersonFullDetail {
  const projects: PersonProjectWithTasks[] = [];
  let tasksShown = 0;
  let truncated = false;

  for (const bucket of byProject) {
    if (tasksShown >= PERSON_FULL_DETAIL_CAP) {
      truncated = true;
      break;
    }
    const drill = buildPersonProjectDrilldown(tasks, bucket);
    if (projects.length > 0 && tasksShown + drill.tasks.length > PERSON_FULL_DETAIL_CAP) {
      truncated = true;
      break;
    }
    projects.push({ ...bucket, tasks: drill.tasks, taskListTruncated: drill.truncated });
    tasksShown += drill.tasks.length;
    if (drill.truncated) truncated = true;
  }

  const tasksTotal = byProject.reduce((s, p) => s + p.open, 0);
  return {
    projects,
    projectsShown: projects.length,
    totalProjects: byProject.length,
    tasksShown,
    tasksTotal,
    truncated: truncated || projects.length < byProject.length,
  };
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
 * שלב 3F.4, הורחב 3F.5A/3F.5B: מיפוי Web-specific מ-shared ToolDefinitions (לא Web-local
 * הישנים) לתופעות הלוואי של ה-UI — channel adapter concern, לא חלק מה-ToolDefinition המשותף/
 * מה-business logic (ה-execute של ToolDefinition לא יודע על actions[]/refresh() בכלל). message
 * מקבל גם את תוצאת ה-execute וגם את ה-input הגולמי (שלב 3F.5B: mark_done/set_status/add_note/
 * report_blocker בונים את ההודעה מ-findTask(input.itemId), לא רק מ-result.message — בדיוק כמו
 * ב-run() wrapper הישן) ומחזיר את טקסט ה-changelog. refresh?:true אומר לדיספצ'ר להריץ
 * await refresh() *אחרי* actions.push, רק אם execute הצליח. לא event bus גנרי — רק שני השדות
 * שבאמת צריך. ה-map עצמו מוגדר *בתוך* runOpsChat (למטה, אחרי findTask) ולא ברמת המודול, כי
 * ארבעת הכלים שמשתמשים ב-findTask צריכים לסגור עליו.
 */
interface SharedToolUiEffect {
  message: (result: unknown, input: Record<string, unknown>) => string;
  /** true ⇐ הדיספצ'ר מריץ await refresh() אחרי actions.push, רק אם execute הצליח. */
  refresh?: boolean;
  /**
   * true ⇐ ה-message הזה קורא ל-findTask (תלוי ב-tasks) — onExecuted יקרא await ensureTasksLoaded()
   * *לפניו*. חסר/false (ברירת מחדל ברוב הכלים) ⇐ הכלי הזה *לא* מפעיל את שליפת tasks בכלל
   * (2026-10-14, lazy loading — ר' docstring מעל ensureTasksLoaded).
   */
  needsTasks?: boolean;
}

/**
 * ניטור ביצועים (2026-10-14) — מודד שלב I/O *לפני* ה-AI loop (כרגע: fetchUserOpsTasks, היחיד
 * שאומת ידנית כ-I/O אסינכרוני במסלול לפני runAttempt — ר' audit; אם יתווסף שלב נוסף בעתיד, זה
 * ה-helper לעטוף אותו). דוחף רשומה ל-sink בשני המקרים (הצלחה/כשל) ו-**זורק מחדש בדיוק את
 * השגיאה המקורית** בכשל — לא עוטף, לא בולע, לא משנה את זרימת הבקרה הקיימת. בכוונה שם קבוע
 * (`name`), לא דינמי מהקלט — אין כאן שום תוכן.
 */
async function timedPrepStep<T>(name: string, fn: () => Promise<T>, sink: PerfStepRecord[]): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    sink.push({ name, durationMs: performance.now() - start, ok: true });
    return result;
  } catch (err) {
    sink.push({ name, durationMs: performance.now() - start, ok: false });
    throw err;
  }
}

/** כמה קריאות ל-getOfficeState() הכלי office_overview אמור לגרום בעצמו — ר' docstring מעל computeOfficeOverviewPerfRecords. */
export const EXPECTED_OFFICE_STATE_CALLS = 2;

export interface OfficeOverviewDiagnosticSnapshot {
  before: OfficeStateDiagnostics;
  after: OfficeStateDiagnostics;
  beforeRd: ReverseDependencyMapDiagnostics;
  afterRd: ReverseDependencyMapDiagnostics;
  /** שלבי fetchGeneralTasks/fetchProjectStageTasks פר-חבר-צוות למחזור הזה (ר' getUserTasksFetchDiagnostics) — [] אם לא רלוונטי. */
  userTasksSteps: UserTasksFetchStep[];
}

/**
 * פונקציה טהורה (לבדיקה בלי Monday/AI) — מחשבת את רשומות ה-chat_perf_steps שנובעות מריצת
 * office_overview, מתוך snapshot לפני/אחרי של ה-diagnostics הגלובליים.
 *
 * ⚠️ אמינות (2026-10-14, audit): ה-counters/lastFetch ב-OfficeStateDiagnostics/
 * ReverseDependencyMapDiagnostics הם גלובליים לכל התהליך — כל קריאה מקבילה אחרת ל-getOfficeState()
 * (runControlScan/getOversightReport של בקשה אחרת, person_status/project_status, runDailyControlCycle/
 * buildWeeklyReport של המתזמן) *או* ל-getReverseDependencyMap() בנפרד (dashboard.ts's
 * getEmployeeDashboard, שלא עובר דרך getOfficeState בכלל) באותו חלון זמן בדיוק — תוסיף ל-delta
 * ותזהם את lastFetch. שיוך מדויק פר-בקשה היה דורש להעביר sink עד ל-officeState.ts/opsRead.ts דרך
 * controlScan.ts/oversight.ts (שינוי חתימות לא-מינימלי) — לכן במקום זאת: אנחנו *יודעים* בדיוק כמה
 * קריאות אמורות לנבוע מאיתנו (EXPECTED_OFFICE_STATE_CALLS — 2, כי runControlScan+getOversightReport
 * קוראות ל-getOfficeState() פעם אחת בדיוק כל אחת; runCrmScan לא נוגע ב-officeState כלל). אם ה-delta
 * הכולל (hits+joined+fetched) לא תואם בדיוק — זו הוכחה ניצחת שמישהו אחר נגע ב-cache באותו חלון
 * (ולא פחות מהצפוי — קריאותינו שלנו תמיד תורמות בדיוק 2, זה לא יכול "לרדת"). דומה לגבי
 * getReverseDependencyMap: ההצפוי שלו הוא officeFetched עצמו (0 או 1 — רק אם getOfficeState ביצע
 * שליפה *חדשה* בחלון הזה הוא קורא ל-getReverseDependencyMap בתוכו).
 *
 * כש-"unreliable" — לא דוחפים את lastFetch/breakdown (עלול להיות שגוי), רק את עובדת חוסר-האמינות
 * והמונה שנצפה בפועל. לעולם לא מציגים מספר מדויק-למראה שעלול להיות שגוי כמדויק.
 *
 * `userTasksSteps` (2026-10-15, בדיקת היתכנות pagination): פירוט fetchGeneralTasks/
 * fetchProjectStageTasks פר-חבר-צוות למחזור הזה — ר' getUserTasksFetchDiagnostics ב-opsRead.ts.
 * בניגוד ל-office/rd (counters גלובליים עם delta), כאן השיוך בטוח *במבנה* — כל שלב נרשם תחת
 * מפתח generation ייחודי, לא counter משותף — ולכן מספיק לבדוק שהגיע *כל* מה שצפוי
 * (memberCount × 2 מקורות); אם לא — unreliable.
 */
export function computeOfficeOverviewPerfRecords(s: OfficeOverviewDiagnosticSnapshot): PerfStepRecord[] {
  const records: PerfStepRecord[] = [];
  const officeHits = s.after.hits - s.before.hits;
  const officeJoined = s.after.joinedInFlight - s.before.joinedInFlight;
  const officeFetched = s.after.fetched - s.before.fetched;
  const officeTotal = officeHits + officeJoined + officeFetched;
  const officeReliable = officeTotal === EXPECTED_OFFICE_STATE_CALLS;

  if (!officeReliable) {
    records.push({
      name: `office_state_cache:unreliable(total=${officeTotal},expected=${EXPECTED_OFFICE_STATE_CALLS})`,
      durationMs: 0,
      ok: true,
    });
    return records; // אם שכבת officeState לא אמינה, גם reverse_dep_map לא ניתן לשיוך — לא מדווחים בכלל
  }

  records.push({ name: `office_state_cache:hits=${officeHits},joined=${officeJoined},fetched=${officeFetched}`, durationMs: 0, ok: true });
  // reverse_deps_wait ו-active_projects נמדדים במקביל זה לזה (אותו Promise.all ב-fetchOfficeState) —
  // זמן המתנה אמיתי של כל אחד בנפרד, אבל **אסור לסכום** את השניים (או אותם + user_tasks/
  // run_control_scan/run_crm_scan/get_oversight_report) ולצפות לקבל את זמן הכלי הכולל — בדיוק כמו
  // אזהרת ה-overlap הקיימת ב-schema.sql's chat_perf_steps (prep/tool).
  if (officeFetched > 0 && s.after.lastFetch) {
    records.push({ name: "office_state_fetch:reverse_deps_wait", durationMs: s.after.lastFetch.reverseDepsMs, ok: true });
    records.push({ name: "office_state_fetch:active_projects", durationMs: s.after.lastFetch.activeProjectsMs, ok: true });
    records.push({ name: "office_state_fetch:user_tasks", durationMs: s.after.lastFetch.userTasksMs, ok: true });

    // פירוט פר-חבר-צוות/מקור (audit 2026-10-15, בדיקת היתכנות pagination) — שיוך בטוח-במבנה: כל
    // שלב נרשם ב-opsRead.ts תחת מפתח generation ייחודי (לא counter גלובלי), אז קריאה מקבילה אחרת
    // נופלת לדלי אחר ולא יכולה להתערבב. בודקים בכל זאת שהגיע *כל* מה שצפוי (חברי-צוות × 2 מקורות) —
    // אם לא (באג/evict נדיר), מסמנים unreliable במקום לדווח פירוק חלקי כאילו הוא מלא.
    const expectedUserTasksSteps = s.after.lastFetch.memberCount * 2;
    if (s.userTasksSteps.length !== expectedUserTasksSteps) {
      records.push({
        name: `user_tasks_fetch:unreliable(count=${s.userTasksSteps.length},expected=${expectedUserTasksSteps})`,
        durationMs: 0,
        ok: true,
      });
    } else {
      for (const step of s.userTasksSteps) {
        records.push({
          name: `user_tasks_fetch:idx=${step.teamIndex},source=${step.source},pages=${step.pages},items=${step.items}`,
          durationMs: step.durationMs,
          ok: true,
        });
      }
    }
  }

  const rdHits = s.afterRd.hits - s.beforeRd.hits;
  const rdJoined = s.afterRd.joinedInFlight - s.beforeRd.joinedInFlight;
  const rdFetched = s.afterRd.fetched - s.beforeRd.fetched;
  const rdTotal = rdHits + rdJoined + rdFetched;
  const rdReliable = rdTotal === officeFetched;

  if (!rdReliable) {
    records.push({ name: `reverse_dep_map_cache:unreliable(total=${rdTotal},expected=${officeFetched})`, durationMs: 0, ok: true });
  } else {
    records.push({
      name: `reverse_dep_map_cache:hits=${rdHits},joined=${rdJoined},fetched=${rdFetched}`,
      durationMs: rdFetched > 0 ? (s.afterRd.lastFetchMs ?? 0) : 0,
      ok: true,
    });
  }
  return records;
}

export interface OpsChatOptions {
  /** ההודעה היא תשובה לפנייה יזומה של הבקרה על משימה ספציפית — מפעיל את כלי סגירת הלולאה. */
  about?: LoopContext;
  /** מזהה השיחה (server/index.ts's session) — בשימוש רק כ-fallback (ר' clientMessageId למטה). */
  session?: string;
  /**
   * audit שלב ה (2026-10-11) — מזהה שהלקוח מקצה (ui.html, crypto.randomUUID()) *לפני* השליחה,
   * פר-פעולת-שליחה אמיתית. זה המזהה ה-**ראשי** ל-idempotency (לא turnOrdinal — ר'
   * attendanceEngine.ts's MessageIdentity): יציב ברטרי (אותה הודעה שנכשלה ונשלחה שוב = אותו
   * מזהה), ותמיד שונה בין שתי הודעות אמיתיות (שתי לשוניות/מכשירים, גם עם תוכן זהה) כי כל אחת
   * מריצה את ה-UUID שלה בעצמה — לא תלוי ב-history/session בכלל. חסר (קורא ישן/לא-חלונית) →
   * fallback ל-turnOrdinal (session+ספירת הודעות מה-DB) — עדיין נכון ל-retry תוך שיחה בודדת,
   * רק לא מגן על המקרה הגבולי של שתי בקשות מקביליות *בלי* clientMessageId בכלל.
   */
  clientMessageId?: string;
  /** בדיקות בלבד — אותם test seams ש-runCentralAgent/runRoutedAgent כבר תומכים בהם (ai/routedAgent.ts),
   *  מוזרקים דרך runOpsChat כדי לבדוק את ה-guard הדטרמיניסטי (audit שלב ז) בלי קריאת AI אמיתית. */
  _runModel?: RunModelFn;
  _config?: AiConfig;
  /** בדיקות בלבד — עוקף את attendanceEnabledForUser האמיתי (בדיוק עיקרון deps ב-agentTools.ts's
   *  buildAgentTools), כדי לא להיות תלוי ב-ATTENDANCE_MODULE_ENABLED/PILOT_USER_KEYS האמיתיים. */
  _attendanceEnabledForUser?: (user: IdentifiedUser) => boolean;
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

  // Day-Start Gate (מודול נוכחות, שלב ב/ג) — בדיקת DB טהורה, בלי קריאת AI נוספת ובלי Monday. רק
  // מי שב-attendanceEnabledForUser (דגל+פיילוט+הרשאה) יכול בכלל לפתוח יום; לכולם אחרים זה no-op
  // מיידי. הבנר מצורף לתשובה הסופית למטה, לא מוחלף לה.
  const attendanceOn = (opts._attendanceEnabledForUser ?? attendanceEnabledForUser)(user);
  const attendanceBanner = attendanceOn ? checkAttendanceDayStart(user, now).banner : null;
  // ניסוי Prompt Caching (2026-10-14) — דגל גלובלי (env) + hardcoded ל-"yochi" בלבד (לא רשימת
  // פיילוט, ר' env.ts). כל משתמש אחר, או יוכי כש-הדגל כבוי, מקבל את ה-buildLoop המקורי בדיוק
  // כמו קודם (system כמחרוזת רגילה, בלי promptCaching) — אפס שינוי התנהגות.
  const promptCachingEnabled = env.PROMPT_CACHING_EXPERIMENT_ENABLED && user.key === "yochi";
  // idempotency (audit שלב ה): clientMessageId (מה-UI, ר' OpsChatOptions) הוא הראשי — יציב ברטרי,
  // ולעולם לא מתנגש בין שתי הודעות אמיתיות (גם מקביליות, גם זהות-תוכן) כי כל שליחה מקבלת UUID
  // משלה בלקוח. turnOrdinal (ספירת הודעות מה-DB) הוא fallback בלבד לקוראים שלא שולחים clientMessageId.
  const scopeId = opts.session ?? "no-session";
  const messageSeed = attendanceOn
    ? buildMessageIdempotencySeed(
        opts.clientMessageId
          ? { scopeId, channelMessageId: opts.clientMessageId }
          : { scopeId, turnOrdinal: countUserMessagesInSession(user.key, opts.session ?? null) },
      )
    : "";

  // ניטור ביצועים (2026-10-14) — מצטבר על פני כל הבקשה (לא מתאפס בכל ניסיון/runAttempt, בדיוק
  // כמו actions), ונכתב ל-DB פעם אחת בסוף ע"י server/index.ts (ר' OpsChatResult.perf).
  const toolCallRecords: PerfStepRecord[] = [];
  const prepStepRecords: PerfStepRecord[] = [];
  // Lazy loading (2026-10-14, audit "בקשה פשוטה") — fetchUserOpsTasks לא רץ יותר עיוורת בתחילת
  // כל בקשה. tasks מתחיל ריק; ensureTasksLoaded() נקרא רק מתוך כלי שבאמת תלוי ב-tasks
  // (get_today_tasks/find_task, ו-SHARED_TOOL_UI_EFFECT's needsTasks למטה) — לא לפני. tasksPromise
  // הוא promise *משותף*: כלי שני שצריך tasks באותו סבב מקבל את אותה הבטחה, לא fetch כפול. אין כאן
  // בכלל סיכון מקביליות על ה-promise הזה — agentLoop.ts מריץ tool calls ברצף (for..of+await, לא
  // Promise.all), אז אין שני awaits חופפים על ensureTasksLoaded באותו רגע. הודעה פשוטה בלי כלים
  // (או כלי שלא צריך tasks בכלל) — fetchUserOpsTasks לא נקרא, תקופה: לא Monday, לא זמן.
  //
  // ניטור (audit): timedPrepStep עדיין רושם את זה כ-prepStep ("fetch_user_ops_tasks") כדי שזמן
  // השליפה האמיתי יימדד נכון (ר' דרישה "הניטור מודד נכון את זמן השליפה"), אבל מרגע ש-הטעינה
  // *lazy* — היא יכולה לקרות *בתוך* חלון הזמן של כלי (get_today_tasks/find_task/mark_done וכו',
  // ר' needsTasks) ולא לפניו. כלומר: בבקשה שבה ה-trigger הראשון ל-tasks הוא כלי, chat_perf_steps
  // יראה גם prep וגם tool שחופפים חלקית בזמן — זה *לא* כשל מדידה (המספר של כל אחד נכון בפני עצמו),
  // רק שסכימה נאיבית של prep+tool לא תשחזר יותר את server_total_ms באופן מדויק לבקשות כאלה (היה
  // תמיד נכון לפני lazy loading, כש-ה-fetch קרה רק לפני הלולאה). לא שינוי בקוד הניטור עצמו.
  let tasks: OpsTask[] = [];
  let tasksPromise: Promise<void> | null = null;
  function ensureTasksLoaded(): Promise<void> {
    if (!tasksPromise) {
      tasksPromise = timedPrepStep("fetch_user_ops_tasks", () => fetchUserOpsTasks(user.mondayUserId!), prepStepRecords).then(
        (t) => {
          tasks = t;
        },
      );
    }
    return tasksPromise;
  }
  const actions: string[] = [];
  // התדריך של "בוקר טוב" מוגש מילה במילה — מודלים נוטים לקצר/לנסח מחדש, וכאן חשוב שהמבנה
  // (פרויקט → 'עכשיו:') יישאר בדיוק כמו שבנינו אותו.
  let capturedBriefing: string | null = null;
  // כמו capturedBriefing — get_my_pipeline מוגש מילה-במילה כשזה כל מה שקרה בסבב, כדי שהחלוקה
  // לחמש הקטגוריות (לידים/עסקאות/משימות) לא תיטשטש בניסוח חופשי של המודל.
  let capturedPipelineText: string | null = null;
  // audit שלב ז (2026-10-13) — נתיב דטרמיניסטי לאישור פעולת נוכחות: מתעד את ה-message *האמיתי*
  // שכלי נוכחות החזיר בהצלחה בסבב הזה (לא ניסוח חופשי של המודל). אם קיים — הוא מחליף את תשובת
  // המודל כליל (ר' למטה, אחרי runCentralAgent). מאופס מחדש בכל ניסיון (ר' runAttempt).
  const liveAttendanceConfirmation: { current: { tool: string; message: string } | null } = { current: null };

  const refresh = async () => {
    // רענון מפורש אחרי כתיבה — fetch טרי תמיד (לא "רק אם עדיין לא נטען"), ומחליף את tasksPromise
    // כך ש-ensureTasksLoaded הבא (אם כלי נוסף באותו סבב יצטרך tasks) יראה את הגרסה המעודכנת,
    // לא promise ישן/stale מלפני הכתיבה.
    tasksPromise = fetchUserOpsTasks(user.mondayUserId!).then((t) => {
      tasks = t;
    });
    await tasksPromise;
  };

  const findTask = (itemId: string): OpsTask | undefined => tasks.find((t) => t.itemId === itemId);

  // שלב 3F.5B (עודכן 2026-10-14, lazy loading): ההודעות של mark_done/set_status/add_note/
  // report_blocker תלויות ב-findTask (לשם התצוגה) — needsTasks:true אומר ל-onExecuted (ר' buildLoop
  // למטה) לקרוא await ensureTasksLoaded() *לפני* uiEffect.message, כך ש-tasks מובטח טעון בדיוק
  // ברגע שצריך אותו, לא לפני (שאר הכלים כאן בכלל לא קוראים ל-tasks — needsTasks נעדר מהם בכוונה,
  // כדי שלא יפעילו את השליפה). tasks לא משתנה בין tool.execute להודעה ל-refresh() (שקורה אחרי,
  // ומרענן) — ר' audit 3F.5B המקורי להוכחת ה-ordering.
  const SHARED_TOOL_UI_EFFECT: Record<string, SharedToolUiEffect> = {
    create_lead: { message: (r) => `🆕 ${(r as { message: string }).message}` },
    create_task: { message: (r) => `🆕 ${(r as { message: string }).message}`, refresh: true },
    mark_done: {
      message: (_r, input) => `✅ ${findTask(String(input.itemId))?.name ?? input.itemId} — בוצע`,
      refresh: true,
      needsTasks: true,
    },
    set_status: {
      message: (_r, input) => `↻ ${findTask(String(input.itemId))?.name ?? input.itemId} — ${input.status}`,
      refresh: true,
      needsTasks: true,
    },
    add_note: {
      message: (_r, input) => `✎ ${findTask(String(input.itemId))?.name ?? input.itemId} — הערה`,
      needsTasks: true,
    },
    report_blocker: {
      message: (_r, input) => `🚧 ${findTask(String(input.itemId))?.name ?? input.itemId} — תקוע`,
      refresh: true,
      needsTasks: true,
    },
    add_update: {
      message: (_r, input) => `✎ הערה נוספה${input.label ? `: ${input.label}` : ""}`,
    },
    create_project_stage: { message: (r) => `🆕 ${(r as { message: string }).message}` },
    reassign_item: { message: (r) => `👤 ${(r as { message: string }).message}` },
    update_lead_contact: { message: (r) => `📇 ${(r as { message: string }).message}` },
    // מודול נוכחות (שלב ג) — AttendanceActionResult.ok מצביע אם היה ok; message הוא טקסט מוכן
    // (כבר בעברית, כולל הניסוח המדויק שהתבקש ל-day_close) — לא בונים טקסט חדש, רק מציגים.
    attendance_break_start: { message: (r) => `⏸️ ${(r as { message: string }).message}` },
    attendance_break_end: { message: (r) => `▶️ ${(r as { message: string }).message}` },
    attendance_day_close: { message: (r) => `🏁 ${(r as { message: string }).message}` },
    attendance_set_reminder: { message: (r) => `⏰ ${(r as { message: string }).message}` },
    attendance_report_correction: { message: (r) => `📝 ${(r as { message: string }).message}` },
  };

  const tools: (ToolDef | ToolDefinition)[] = [
    {
      name: "get_today_tasks",
      description:
        "מחזיר את תצוגת 'העבודה שלי' של העובד להיום — חמש קטגוריות קבועות (לידים חדשים / עסקאות חדשות / " +
        "עסקאות לטיפול / משימות רגילות / משימות פרויקטים), תמיד ובאותו סדר. זו התשובה היחידה שיש להציג " +
        "כשמבקשים 'מה יש לי היום', 'מה המשימות שלי', 'מה יש לי לבצע' — בלי לצרף תדריך ישן נוסף.",
      input_schema: { type: "object", properties: {} },
      run: async () => {
        // lazy loading (2026-10-14) — זה הכלי שבגללו tasks בכלל נדרש; נטען כאן, לא לפני.
        await ensureTasksLoaded();
        // v (needsAttention/waitingOnMe) נשאר מחושב — לא נגעתי במנגנון השליפה/הבקרה הישן — אבל
        // אינו חלק מהתשובה הנראית למשתמש יותר (ר' docstring מעל buildTodayBriefing). משמש רק
        // את ה-JSON הפנימי, למקרה שיתבקש במפורש בהמשך השיחה.
        const v = buildDashboardViews(tasks, now);
        const feed = await getEmployeeFeed(user.mondayUserId!, now);
        const briefing = formatEmployeeFeedBriefing(user.name, feed, now);
        capturedBriefing = briefing;
        return {
          counts: {
            needsAttention: v.needsAttention.length,
            waitingOnMe: v.waitingOnMe.length,
            totalOpen: tasks.length,
          },
          needsAttention: v.needsAttention.slice(0, 8).map(fmtTask),
          waitingOnMe: v.waitingOnMe.slice(0, 8).map(fmtTask),
          pipeline: { counts: employeeFeedCounts(feed), text: briefing },
        };
      },
    },
    {
      name: "get_my_pipeline",
      description:
        "מחזיר את הלידים, העסקאות והמשימות שהעובד אחראי עליהם ב-Monday, מסונן לפי כללי המשרד: " +
        "לידים חדשים ועסקאות חדשות מוצגים תמיד (בלי קשר לתאריך); עסקאות לטיפול / משימות רגילות / " +
        "משימות פרויקטים מוצגות רק אם התאריך הרלוונטי (תזכורת/ביצוע) הוא היום או כבר עבר — תאריך " +
        "עתידי או חסר לא מוצג. השתמש בזה לשאלות כמו 'יש לי לידים חדשים?', 'מה מצב העסקאות שלי?', " +
        "'מה יש לי לטפל בו' כשרוצים תמונה מלאה כולל CRM, לא רק משימות.",
      input_schema: { type: "object", properties: {} },
      run: async () => {
        const feed = await getEmployeeFeed(user.mondayUserId!, now);
        const text = formatEmployeeFeedText(feed);
        capturedPipelineText = text;
        return { counts: employeeFeedCounts(feed), text };
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
        await ensureTasksLoaded(); // lazy loading (2026-10-14) — זה הכלי שבגללו tasks נדרש
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
      name: "record_commitment",
      description:
        "רושם התחייבות שהעובד נתן — משהו שהובטח ל**צד שלישי אמיתי**: לקוח / יועץ / גורם חוץ. קרא לזה כשהעובד אומר " +
        "'הבטחתי ל...', 'אמרתי ללקוח ש...', 'התחייבתי לשלוח עד...'. נסה למלא תאריך יעד אם נאמר. " +
        "toWhom חייב להיות מישהו *אחר* מהעובד הנוכחי — לעולם לא שם המשתמש עצמו, גם אם מה שצריך הוא 'להזכיר לעצמי'/" +
        "'לטפל בזה בהמשך'. זו רשומה פנימית בלבד (list_my_commitments) — **אין מנגנון שמעביר ממנה הודעה לאף אחד**, לא " +
        "ל-toWhom ולא לשום גורם אחר. אחרי קריאה מוצלחת, אל תגיד 'העברתי/שלחתי' — רק 'נשמר ביומן הפתוח שלך'.",
      input_schema: {
        type: "object",
        properties: {
          toWhom: { type: "string", description: "למי הובטח (שם הלקוח/הגורם) — לא שם המשתמש הנוכחי עצמו" },
          what: { type: "string", description: "מה הובטח" },
          dueDate: { type: "string", description: "תאריך יעד YYYY-MM-DD, אם נאמר" },
          project: { type: "string", description: "שם הפרויקט אם רלוונטי" },
        },
        required: ["toWhom", "what"],
      },
      run: async (input) => {
        const toWhom = String(input.toWhom ?? "").trim();
        // audit שלב ז (2026-10-13) — תקלת 13/10: הסוכן השתמש בכלי הזה כ"תזכורת לעצמי" עם
        // toWhom=שם המשתמש הנוכחי, ואז טען (בניסוח החופשי שלו) ש"יוכי תטפל בזה" כאילו זו הודעה
        // שתגיע לצד שלישי — כשבפועל המשתמש *הוא* יוכי, ואין שום מנגנון מסירה. נדחה כאן במפורש,
        // לא רק בתיאור (ר' גם description למעלה) — הגנת-עומק, לא רק תלות בציות-להנחיה של המודל.
        if (toWhom && (toWhom.toLowerCase() === user.key.toLowerCase() || toWhom === user.name)) {
          return {
            ok: false,
            error:
              "אי אפשר להשתמש בכלי הזה להתחייבות/תזכורת לעצמך — הוא מיועד להבטחות לצד שלישי אמיתי (לקוח/יועץ/גורם " +
              "חוץ), ואין מנגנון שמעביר ממנו הודעה לאף אחד, גם לא למשתמש עצמו. אם רק צריך לזכור משהו עצמאית, אפשר " +
              "לציין זאת בתשובה בטקסט רגיל — בלי לטעון שזה 'הועבר' או 'יטופל' על ידי מישהו אחר.",
          };
        }
        const c = addCommitment({
          createdBy: user.key,
          toWhom,
          what: String(input.what),
          dueDate: input.dueDate ? String(input.dueDate) : undefined,
          project: input.project ? String(input.project) : undefined,
        });
        // "ביומן הפתוח" (לא "נרשמה" בלבד) — מבהיר בתוך הטוסט עצמו שזו רשומה פנימית, לא הודעה
        // שנשלחה; מצטרף לדרישה שהתשובה-בטקסט-חופשי של המודל לא תחזור/תפרט את זה שוב (ר' description).
        actions.push(`🤝 נשמר ביומן הפתוח שלך (לא נשלח לאף אחד): ${c.toWhom} — ${c.what}`);
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

  // Step 3F.6: כל 9 ה-AgentTool-backed tools (5 "תמיד-גלויים" + 4 "gated") נבנים/מסוננים כאן
  // בקריאה אחת דרך WEB_SHARED_TOOL_VISIBILITY + filterSharedToolsForUser (src/ai/sharedTools.ts) —
  // לא עוד 5 אלמנטים בלתי-מותנים בתוך ה-literal array למעלה + 4 if-ים מפוזרים בגוף הפונקציה (היה
  // קודם, ר' git history). ה-policy (always/gated) מוצהרת אחת, גלויה, במקום אחד — לא נגזרת מצורת
  // הקוד. סדר הכלים בתוך tools[] לא משפיע על שום דבר (המודל בוחר לפי name, לא לפי מיקום).
  tools.push(...filterSharedToolsForUser(WEB_SHARED_TOOL_VISIBILITY, user));

  // מודול נוכחות (שלב ג) — שער נפרד מ-WEB_SHARED_TOOL_VISIBILITY בכוונה: attendanceEnabledForUser
  // כולל Feature Flag+pilot allowlist, לא רק הרשאה (filterSharedToolsForUser בודק permission בלבד
  // — לא מספיק כאן). messageSeed מוזרק דרך transformInput, מחושב פעם אחת למעלה.
  if (attendanceOn) {
    const a = buildAttendanceToolDefinitions(messageSeed);
    tools.push(a.breakStart, a.breakEnd, a.dayClose, a.setReminder, a.reportCorrection, ATTENDANCE_DAY_STATUS_TOOL_DEFINITION);
  }

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

  // Step 3F.6: reassign_item/create_task/create_project_stage/create_lead's gating was moved into
  // WEB_SHARED_TOOL_VISIBILITY + the single filterSharedToolsForUser call above (right after the
  // tools[] literal) — each still gets exactly the same isToolAllowedForUser decision it always
  // did, just expressed as one declared policy entry instead of its own scattered if-block here.

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
          // ניטור ביצועים פנימי (2026-10-14) — מפרק את זמן הכלי לשלושת המקורות + את זמן השליפה
          // המשרדית המשותפת (getOfficeState/getReverseDependencyMap) לשלבים, בלי לשנות את ה-
          // Promise.all/המקביליות. timedPrepStep (קיים, ר' מעלה) דוחף ל-prepStepRecords הקיים —
          // יוצא ל-chat_perf_steps (kind='prep') בלי שינוי סכמה ובלי לוג debug. אין כאן שם
          // עובד/פרויקט/משימה — רק מספרים ומונים. חישוב האמינות (audit 2026-10-14) מופרד לפונקציה
          // טהורה — computeOfficeOverviewPerfRecords — שנבדקת ישירות ביחידה, ר' docstring שם.
          const beforeOffice = getOfficeStateDiagnostics();
          const beforeRd = getReverseDependencyMapDiagnostics();

          const [ctrl, crm, over] = await Promise.all([
            timedPrepStep("run_control_scan", () => runControlScan(), prepStepRecords),
            timedPrepStep("run_crm_scan", () => runCrmScan(), prepStepRecords),
            timedPrepStep("get_oversight_report", () => getOversightReport(user), prepStepRecords),
          ]);

          const afterOffice = getOfficeStateDiagnostics();
          const userTasksSteps = afterOffice.lastFetch ? getUserTasksFetchDiagnostics(afterOffice.lastFetch.generation) : [];

          prepStepRecords.push(
            ...computeOfficeOverviewPerfRecords({
              before: beforeOffice,
              after: afterOffice,
              beforeRd,
              afterRd: getReverseDependencyMapDiagnostics(),
              userTasksSteps,
            }),
          );

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
        description:
          "מצב העבודה של איש צוות מסוים. בלי פרמטרים נוספים: כמה משימות פתוחות/באיחור/תקועות/חוסמות/להיום " +
          "יש לו, ופירוק **מלא** (byProject + withoutProject, סכומם שווה ל-counts) של כל הפרויקטים שלו — זו " +
          "התשובה המלאה ל'תפרק לפי פרויקטים' (ספירות בלבד; findings הן רק highlights נבחרים, לא הרשימה המלאה). " +
          "עם project: פירוט המשימות בפועל (שם/שלב/תאריך/סטטוס) רק באותו פרויקט אחד של אותו עובד. " +
          "עם projectIndex: אותו פירוט, אבל לפי **מיקום** ברשימה שהוצגה בתשובה הקודמת (1=ראשון, 2=שני, " +
          "-1=אחרון, -2=לפני-אחרון) — להמשך-בקשה כמו 'תראה לי את הפרויקט הראשון/האחרון ברשימה', כש-אתה " +
          "לא בטוח בשם המדויק שהוצג (אל תמציא/תשחזר שם מהזיכרון, זה מה שגרם לכשל). " +
          "עם detail=true (בלי project/projectIndex): פירוט משימות אמיתי (לא רק ספירות) על פני **כל** " +
          "הפרויקטים של העובד בבת אחת — לבקשות כמו 'תפרק לי את כל המשימות שלו לפי פרויקטים' (המילה " +
          "'משימות'/'רשימה' מבדילה מ-'תפרק לפי פרויקטים' הסתמי, שמחזיר רק ספירות).",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "שם איש הצוות" },
            project: {
              type: "string",
              description: "אופציונלי — שם פרויקט (או חלק ממנו) מבין הפרויקטים של העובד הזה, לפירוט המשימות בו בפועל",
            },
            projectIndex: {
              type: "number",
              description:
                "אופציונלי — מיקום הפרויקט ברשימה שהוצגה בתשובה הקודמת (1=ראשון, 2=שני, -1=אחרון). " +
                "השתמש בזה כש-המשתמש מתייחס למיקום ('הראשון/השני/האחרון ברשימה'), לא בשם — אל תנחש שם מהזיכרון.",
            },
            detail: {
              type: "boolean",
              description: "true כש-המשתמש מבקש את כל המשימות בפועל (לא רק ספירות) עבור כל הפרויקטים של העובד יחד",
            },
          },
          required: ["name"],
        },
        run: async (input) => {
          const q = String(input.name ?? "").trim();
          const projectQuery = typeof input.project === "string" ? input.project.trim() : "";
          const projectIndex = typeof input.projectIndex === "number" ? input.projectIndex : undefined;
          const wantDetail = input.detail === true;
          // getOfficeState() בלבד — אותו מטמון (3 דק') ש-getOversightReport/controlScan כבר משתמשים
          // בו, בלי לעבור דרך oversight.ts: כך ש-counts/byProject/withoutProject כולם נספרים *פעם
          // אחת* מתוך אותו tasks[] (ר' buildPersonProjectBreakdown) — לא שני חישובים נפרדים שעלולים
          // להתפזר. runControlScan נשאר, רק ל-findings (highlights, לא השדה המלא).
          const [office, ctrl] = await Promise.all([getOfficeState(), runControlScan()]);
          const match = office.perPerson.find(
            (pp) => pp.member.name.includes(q) || q.includes(pp.member.name.split(" ")[0]!),
          );
          if (!match) {
            return {
              error: `לא מצאתי איש צוות בשם "${q}". אפשרויות: ${office.perPerson.map((pp) => pp.member.name).join(", ")}`,
            };
          }
          const { member, tasks } = match;
          const breakdown = buildPersonProjectBreakdown(tasks);

          // בקשת-המשך לפי מיקום ("הראשון/האחרון ברשימה") — דטרמיניסטי, לא תלוי בזיכרון-שם של המודל.
          // ר' resolveProjectByIndex: אם המיקום לא חד-משמעי (tie בערכים) — מחזיר הבהרה, לא מנחש.
          if (projectIndex !== undefined) {
            const resolution = resolveProjectByIndex(breakdown.byProject, projectIndex);
            if (!resolution.ok) {
              if (resolution.reason === "out_of_range") {
                return {
                  error: `אין פרויקט במיקום ${projectIndex} — יש ${breakdown.totalProjects} פרויקטים ל-${member.name}.`,
                  totalProjects: breakdown.totalProjects,
                };
              }
              return {
                hint: `המיקום הזה לא חד-משמעי — כמה פרויקטים עם עומס זהה מתחרים עליו. אפשר לבקש לפי שם?`,
                candidates: resolution.candidates!.map((c) => c.project),
              };
            }
            const drilldown = buildPersonProjectDrilldown(tasks, resolution.project!);
            return { name: member.name, ...drilldown };
          }

          if (projectQuery) {
            // matchPersonProjects מחפש בין ה-buckets המחושבים (לא tasks גולמיים) — ר' docstring
            // שם: שני פרויקטים עם שם זהה אבל projectId שונה הם שתי התאמות נפרדות, לא אחת.
            const matches = matchPersonProjects(breakdown.byProject, projectQuery);
            if (matches.length === 0) {
              return {
                error: `לא מצאתי פרויקט שמתאים ל"${projectQuery}" אצל ${member.name}.`,
                availableProjects: breakdown.byProject.map((b) => b.project),
              };
            }
            if (matches.length > 1) {
              return { hint: "יותר מדי התאמות — איזה מהם?", names: matches.map((m) => m.project) };
            }
            const drilldown = buildPersonProjectDrilldown(tasks, matches[0]!);
            return { name: member.name, ...drilldown };
          }

          if (wantDetail) {
            const full = buildPersonFullDetail(tasks, breakdown.byProject);
            return { name: member.name, ...full, withoutProject: breakdown.withoutProject };
          }

          const overdueSorted = tasks.filter((t) => t.flags.overdue).sort((a, b) => b.flags.daysOverdue - a.flags.daysOverdue);
          return {
            name: member.name,
            counts: {
              open: tasks.length,
              overdue: overdueSorted.length,
              stuck: tasks.filter((t) => t.flags.stuck).length,
              blocking: tasks.filter((t) => t.flags.blocking.length > 0).length,
              dueToday: tasks.filter((t) => t.flags.dueToday).length,
            },
            byProject: breakdown.byProject,
            byProjectTruncated: breakdown.byProjectTruncated,
            totalProjects: breakdown.totalProjects,
            withoutProject: breakdown.withoutProject,
            worst: overdueSorted.slice(0, 3).map((t) => ({
              name: t.name,
              context: t.stageName ? `${t.context} › ${t.stageName}` : t.context,
              dueDate: t.dueDate,
              daysOverdue: t.flags.daysOverdue,
              status: t.status,
            })),
            findings: ctrl.findings.filter((f) => f.who.includes(member.name)).map(fmtFinding),
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

  const normTools: NormTool[] = toNormTools(tools);

  // ── מפרט הלולאה לכל ניסיון. הלולאה עצמה ב-agentLoop; הניתוב + fallback ב-runCentralAgent.
  //    כאן רק: הרצת הכלים (עם מעקב כתיבות ל-sideEffect) והגשת תדריך הבוקר מילה-במילה.
  const buildLoop = () => {
    capturedBriefing = null; // איפוס לפני כל ניסיון — כדי שה-fallback ל-SMART יאסוף תדריך מחדש
    capturedPipelineText = null;
    return {
      system: systemPrompt(user, opts.about),
      // ניסוי Prompt Caching (2026-10-14) — ר' promptCachingEnabled למעלה. כש-כבוי (כל משתמש
      // חוץ מ-yochi+flag) השדה הזה undefined, ו-agentLoop/anthropic.ts מתנהגים בדיוק כקודם.
      ...(promptCachingEnabled ? { promptCaching: buildPromptCachingSplitFor(user, opts.about) } : {}),
      maxTokens: 1024,
      maxTurns: MAX_TURNS,
      messages: toNormMessages(history),
      tools: normTools,
      // Central Agent Core unification (2026-10-07): כלים משותפים (ToolDefinition, isSharedToolDefinition)
      // עוברים עכשיו דרך dispatchToolDefinition (src/ai/dispatcher.ts) — אותו דיספצ'ר ש-WhatsApp's
      // orchestrator.ts גם קורא לו, לא עוד implementation כפול שרק "קורה" להתנהג אותו דבר. Web-local
      // tools (~19 כלים, run(input) בלי ctx) נשארים דרך ה-else למטה בדיוק כמו קודם — לא דורשים
      // AgentTool/permission data, אין להם מה להמיר. actions.push/refresh() (SHARED_TOOL_UI_EFFECT) ו-
      // כל ה-logging נשארים channel adapter concern, מחוברים דרך hooks — הדיספצ'ר עצמו לא מכיר אותם.
      executeToolCall: async (call: NormToolCall) => {
        const tool = tools.find((t) => t.name === call.name);
        if (!tool) return { content: `שגיאה: כלי לא ידוע ${call.name}`, sideEffect: false };
        const input = (call.input ?? {}) as Record<string, unknown>;
        if (isSharedToolDefinition(tool)) {
          return dispatchToolDefinition(tool, input, { user }, {
            onDenied: () =>
              logger.warn({ tool: call.name, user: user.key }, "כלי נחסם — אין למשתמש הרשאה (בדיקה בזמן הרצה)"),
            // actions.push/refresh — channel adapter concern, לא חלק מה-ToolDefinition המשותף
            // (tool.execute לא יודע על actions[]/refresh() בכלל). ר' SHARED_TOOL_UI_EFFECT. סדר
            // מפורש, זהה למה שהיה: actions.push קודם, refresh() אחריו, שניהם רק אם execute הצליח
            // (onExecuted נקרא רק בהצלחה — אם זרק, onError למטה תופס, לא כאן).
            onExecuted: async (_t, out, inp) => {
              // audit שלב ז: גיבוי דטרמיניסטי — out.message הוא תוצאת הכלי *האמיתית* (onExecuted
              // נקרא רק בהצלחה, ר' הערה למעלה), לא מה שהמודל יגיד בטקסט הסופי. נלכד *לפני* ה-UI
              // effect, לא תלוי בו.
              if (ATTENDANCE_LIVE_CONFIRMATION_TOOLS.has(call.name)) {
                const msg = (out as { message?: string } | undefined)?.message;
                if (msg) liveAttendanceConfirmation.current = { tool: call.name, message: msg };
              }
              const uiEffect = SHARED_TOOL_UI_EFFECT[call.name];
              if (uiEffect) {
                // lazy loading (2026-10-14) — רק כלים עם needsTasks:true (findTask בהודעה) מפעילים
                // את השליפה, ורק *כאן*, ממש לפני שבאמת צריך אותה. try/catch מקומי — dispatchToolDefinition
                // (dispatcher.ts) עוטף את כל onExecuted באותו try/catch כמו tool.execute עצמו, אז
                // בלי ההגנה הזו, כשל-Monday בשליפת tasks *לצורך תצוגה בלבד* היה מדווח כ-sideEffect:false
                // (= "הכלי נכשל") גם כש-tool.execute (הכתיבה האמיתית ל-Monday) *כבר הצליחה* — זו
                // תקלה חדשה שהרפקטור הזה היה עלול להכניס (לפני ה-lazy loading, tasks נטען לפני
                // שכל כלי רץ, אז הכשל הזה היה קורה — אם בכלל — לפני הכתיבה, לא אחריה). findTask
                // מחזיר undefined על tasks ריק, וההודעות כולן כבר נופלות ל-input.itemId בלי שם —
                // אין צורך בטיפול נוסף, רק למנוע מהחריגה לברוח ל-catch של הדיספצ'ר.
                if (uiEffect.needsTasks) {
                  try {
                    await ensureTasksLoaded();
                  } catch (err) {
                    logger.warn(
                      { err, tool: call.name, user: user.key },
                      "lazy loading של tasks נכשל — ההודעה תציג מזהה פריט גולמי במקום שם המשימה (הכתיבה עצמה הצליחה)",
                    );
                  }
                }
                actions.push(uiEffect.message(out, inp));
                if (uiEffect.refresh) await refresh();
              }
            },
            onError: (_t, err) => logger.warn({ err, tool: call.name, user: user.key }, "כלי צ'אט תפעולי נכשל"),
          });
        }
        const before = actions.length; // כלי כתיבה מוסיף ל-actions — כך יודעים אם הייתה תופעת לוואי
        try {
          const out = await tool.run(input);
          return { content: JSON.stringify(out), sideEffect: actions.length > before };
        } catch (err) {
          logger.warn({ err, tool: call.name, user: user.key }, "כלי צ'אט תפעולי נכשל");
          return { content: `שגיאה: ${(err as Error).message}`, sideEffect: false };
        }
      },
      // ניטור ביצועים (2026-10-14) — toolCallRecords מוגדר *מעל* buildLoop (לא כאן), כך שנשאר
      // אותו מערך על פני כל הניסיונות (fast→smart fallback, retry אישור נוכחות) — בדיוק כמו
      // actions. agentLoop.ts כבר קורא לזה עם *אותו* durationMs שנספר ל-toolTimeMs — לא טיימר שני.
      onToolTiming: (name: string, durationMs: number, ok: boolean) => {
        toolCallRecords.push({ name, durationMs, ok });
      },
      finalizeText: (modelText: string) => {
        // אם בסבב הזה נשלף תדריך היום ולא בוצעו עדכונים — מגישים אותו כפי שהוא (כולל ברכה+כותרת,
        // ר' formatEmployeeFeedBriefing) במקום הניסוח החופשי של המודל (שנוטה לשבש את מבנה חמש
        // הקטגוריות). לא רלוונטי בתשובה לפנייה יזומה — שם רוצים את התשובה של הכלי.
        if (capturedBriefing && actions.length === 0 && !opts.about) {
          return `${capturedBriefing}\n\nעל מה מתחילים?`;
        }
        if (capturedPipelineText && actions.length === 0 && !opts.about) {
          return capturedPipelineText;
        }
        return modelText || null;
      },
    };
  };

  const runAttempt = (forceTier?: "smart") => {
    liveAttendanceConfirmation.current = null; // מאופס פר-ניסיון — גיבוי חייב להיות מהניסיון הזה, לא קודם
    return runCentralAgent({
      useCase: "ops_chat",
      latestMessage: history[history.length - 1]?.content ?? "",
      historyLength: history.length,
      canSeeAllWork: userCan(user, "view:all_work"),
      // תשובה לפנייה יזומה → SMART: הבנת הכוונה + הפעולה הנכונה ב-Monday חשובה מהעלות.
      forceTier: forceTier ?? (opts.about ? "smart" : undefined),
      buildLoop,
      // ל-ops chat "תופעת לוואי" = כתיבה ל-Monday/DB (actions), לא סתם קריאת מידע
      sideEffectCount: () => actions.length,
      _runModel: opts._runModel,
      _config: opts._config,
    });
  };

  let routed = await runAttempt();
  let finalText = routed.outcome.text ?? "סליחה, הסתבכתי. אפשר לנסח שוב בקצרה?";
  // ניטור ביצועים (2026-10-14) — מצטבר מהניסיון הראשון; אם יתווסף ניסיון חיצוני נוסף (retry אישור
  // נוכחות, למטה) הוא מצטרף. זה *מעבר* ל-fallback FAST→SMART הפנימי שכבר מצטבר בתוך routed.perf.
  let perfAiTimeMs = routed.perf.aiTimeMs;
  let perfAiCallCount = routed.perf.aiCallCount;
  let perfToolTimeMs = routed.perf.toolTimeMs;
  let perfToolCallCount = routed.perf.toolCallCount;
  let perfAttempts = routed.perf.attempts;

  // audit שלב ז/ח (2026-10-13) — נתיב דטרמיניסטי: אם כלי נוכחות אמיתי רץ בהצלחה בסבב הזה, תשובת
  // המשתמש היא *בדיוק* ה-message שהוא החזיר — לא ניסוח חופשי של המודל (גם אם המודל כתב משהו
  // אחר/נוסף). אם לא רץ כלום אבל יש חשד — **משני מקורות בלתי-תלויים**: (א) הטקסט תואם תבנית-אישור
  // קנונית מדויקת (ממצא 1 המקורי), או (ב) המשתמש *ביקש פעולה* (זוהה מתוך ההודעה שלו, לא מהמודל)
  // *וגם* התשובה נשמעת כמו הצהרת-ביצוע גנרית (סגירת-הפער: מודל שמנסח הצלחה-שקרית במילים אחרות,
  // למשל "סידרתי, הכול טוב") — ניסיון חוזר *אחד*, מאולץ ל-SMART; אם גם זה לא מייצר גיבוי אמיתי —
  // הודעת כישלון ברורה, לעולם לא הטקסט החשוד. שאלת-מידע טהורה (אין (א) ואין (ב), כי אין טענת-
  // ביצוע בתשובה) לעולם לא מפעילה את זה — ההפרדה בין שאלה לבקשת-ביצוע נשמרת. אין סיכון כפילות:
  // runAttempt חדש אבל messageSeed (מ-clientMessageId, חושב פעם אחת למעלה) נשאר אותו —
  // getEventByIdempotencyKey/getCorrectionByIdempotencyKey ב-attendance.ts מגנים בדיוק על זה.
  if (attendanceOn) {
    const lastUserMsg = history[history.length - 1]?.content ?? "";
    const userRequestedAction = looksLikeAttendanceActionRequest(lastUserMsg);
    const isSuspicious = (text: string) => matchesCannedAttendanceConfirmation(text) || (userRequestedAction && soundsLikeCompletionClaim(text));

    const confirmed1 = liveAttendanceConfirmation.current;
    if (confirmed1) {
      finalText = confirmed1.message;
    } else if (isSuspicious(finalText)) {
      logger.warn({ user: user.key, userRequestedAction }, "חשד לאישור נוכחות בלי tool_use מאומת — מנסה שוב (SMART) לפני הצגה למשתמש");
      routed = await runAttempt("smart");
      finalText = routed.outcome.text ?? "סליחה, הסתבכתי. אפשר לנסח שוב בקצרה?";
      perfAiTimeMs += routed.perf.aiTimeMs;
      perfAiCallCount += routed.perf.aiCallCount;
      perfToolTimeMs += routed.perf.toolTimeMs;
      perfToolCallCount += routed.perf.toolCallCount;
      perfAttempts += routed.perf.attempts;
      const confirmed2 = liveAttendanceConfirmation.current;
      if (confirmed2) {
        finalText = confirmed2.message;
      } else if (isSuspicious(finalText)) {
        logger.warn({ user: user.key }, "חשד לאישור נוכחות נמשך גם אחרי ניסיון חוזר — מציג כישלון מפורש, לא את הטקסט החשוד");
        finalText = "לא הצלחתי לאשר בוודאות שהפעולה בוצעה בפועל. נסה לשלוח את ההודעה שוב, או נסח אותה במפורש (למשל 'יצאתי להפסקה עכשיו' / 'חזרתי מההפסקה').";
      }
    }
  }

  return {
    reply: attendanceBanner ? `${attendanceBanner}\n\n${finalText}` : finalText,
    actions,
    perf: {
      aiTimeMs: perfAiTimeMs,
      aiCallCount: perfAiCallCount,
      toolTimeMs: perfToolTimeMs,
      toolCallCount: perfToolCallCount,
      attempts: perfAttempts,
      tier: routed.tier,
      fallbackUsed: routed.fallbackUsed,
      toolCalls: toolCallRecords,
      prepSteps: prepStepRecords,
    },
  };
}
