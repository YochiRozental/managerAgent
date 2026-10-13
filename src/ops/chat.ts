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
import { runCentralAgent } from "../ai/routedAgent.js";
import type { RunModelFn } from "../ai/agentLoop.js";
import type { AiConfig } from "../ai/tierConfig.js";
import { buildSystemPrompt } from "../ai/prompt.js";
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
import { getOfficeState } from "./officeState.js";
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
  return buildSystemPrompt({ channel: "web", user, about, attendanceEnabled: attendanceEnabledForUser(user) });
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

  let tasks = await fetchUserOpsTasks(user.mondayUserId);
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
    tasks = await fetchUserOpsTasks(user.mondayUserId!);
  };

  const findTask = (itemId: string): OpsTask | undefined => tasks.find((t) => t.itemId === itemId);

  // שלב 3F.5B: ההודעות של mark_done/set_status/add_note/report_blocker תלויות ב-findTask (לשם
  // התצוגה) — בדיוק כמו ב-run() wrapper הישן, שקרא findTask *לפני* execute. כאן (בתוך ה-dispatcher,
  // ר' buildLoop למטה) ה-uiEffect.message נקרא *אחרי* tool.execute אבל *לפני* refresh() — tasks
  // (ה-cache ש-findTask קורא ממנו) לא משתנה בין שתי הנקודות האלה (רק refresh() מרענן אותו, וזה
  // קורה אחרי), אז זו אותה תוצאה בדיוק כמו קריאה מוקדמת יותר. ר' audit 3F.5B להוכחת ה-ordering הזו.
  const SHARED_TOOL_UI_EFFECT: Record<string, SharedToolUiEffect> = {
    create_lead: { message: (r) => `🆕 ${(r as { message: string }).message}` },
    create_task: { message: (r) => `🆕 ${(r as { message: string }).message}`, refresh: true },
    mark_done: {
      message: (_r, input) => `✅ ${findTask(String(input.itemId))?.name ?? input.itemId} — בוצע`,
      refresh: true,
    },
    set_status: {
      message: (_r, input) => `↻ ${findTask(String(input.itemId))?.name ?? input.itemId} — ${input.status}`,
      refresh: true,
    },
    add_note: {
      message: (_r, input) => `✎ ${findTask(String(input.itemId))?.name ?? input.itemId} — הערה`,
    },
    report_blocker: {
      message: (_r, input) => `🚧 ${findTask(String(input.itemId))?.name ?? input.itemId} — תקוע`,
      refresh: true,
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

  const normTools: NormTool[] = toNormTools(tools);

  // ── מפרט הלולאה לכל ניסיון. הלולאה עצמה ב-agentLoop; הניתוב + fallback ב-runCentralAgent.
  //    כאן רק: הרצת הכלים (עם מעקב כתיבות ל-sideEffect) והגשת תדריך הבוקר מילה-במילה.
  const buildLoop = () => {
    capturedBriefing = null; // איפוס לפני כל ניסיון — כדי שה-fallback ל-SMART יאסוף תדריך מחדש
    capturedPipelineText = null;
    return {
      system: systemPrompt(user, opts.about),
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
      const confirmed2 = liveAttendanceConfirmation.current;
      if (confirmed2) {
        finalText = confirmed2.message;
      } else if (isSuspicious(finalText)) {
        logger.warn({ user: user.key }, "חשד לאישור נוכחות נמשך גם אחרי ניסיון חוזר — מציג כישלון מפורש, לא את הטקסט החשוד");
        finalText = "לא הצלחתי לאשר בוודאות שהפעולה בוצעה בפועל. נסה לשלוח את ההודעה שוב, או נסח אותה במפורש (למשל 'יצאתי להפסקה עכשיו' / 'חזרתי מההפסקה').";
      }
    }
  }

  return { reply: attendanceBanner ? `${attendanceBanner}\n\n${finalText}` : finalText, actions };
}
