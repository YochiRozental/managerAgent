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
import type { NormTool, NormToolCall } from "../ai/providers/types.js";
import {
  addUpdateToItem,
  createLeadAction,
  createProjectStageAction,
  createTaskAction,
  reassignItem,
  updateTask,
} from "./actions.js";
import { LEAD_PRODUCT_OPTIONS, LEAD_SOURCE_OPTIONS } from "../integrations/monday/leads.js";
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
 * הצהרת הכלי (בלי run — זה מצורף בתוך runOpsChat, שם יש גישה ל-closures כמו actions/refresh).
 * מיוצא בנפרד כדי שבדיקות (test-create-task-prompt.ts) יוכלו להשתמש באותו schema אמיתי בדיוק
 * שהמודל רואה בפועל, בלי לשכפל אותו וליצור סיכון לסטייה בין הבדיקה לקוד האמיתי.
 *
 * taskName חייב להגיע מהמשתמש בפועל — ר' האירוע מ-2026-09-22: "תיצור לרוחי משימה" (בלי המשך)
 * גרם למודל למלא taskName="משימה חדשה" כדי לספק שדה חובה, במקום לשאול. אין לזה ברירת מחדל
 * הגיונית (בשונה מ-project/stage/assignee/dueDate/priority), אז זה מנוסח כאן וב-system prompt
 * (systemPrompt) פעמיים בכוונה — גם ב-tool schema וגם בהוראה מפורשת.
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
 * יצירת **שלב** חדש בפרויקט — לא task/subitem (זה create_task). פער production (2026-09-22):
 * "תוסיף את המשימה בתור עוד שלב" לא היה נתמך — create_task יודע רק ליצור task תחת שלב *קיים*,
 * לא ליצור שלב חדש. מיוצא בנפרד באותה סיבה כמו CREATE_TASK_TOOL_DECL — בדיקות (test-create-
 * task-prompt.ts style) יכולות לבחון את אותו schema בדיוק שהמודל מקבל.
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

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface OpsChatResult {
  reply: string;
  /** תיאור קצר של כל עדכון שבוצע ב-Monday בסבב הזה — לרענון הרשימה ולתצוגה */
  actions: string[];
}

/** מיוצא כדי שבדיקות יוכלו לבחון את הטקסט האמיתי שהמודל מקבל (ר' CREATE_TASK_TOOL_DECL). */
export function systemPrompt(user: IdentifiedUser, about?: LoopContext): string {
  const now = DateTime.now().setZone(env.TIMEZONE);
  return [
    `אתה העוזר התפעולי של ${user.name} במשרד האדריכלים "גוטליב אדריכלים". תפקיד המשתמש: ${user.roleDescription}`,
    `היום ${now.toFormat("EEEE, dd/MM/yyyy")}, השעה ${now.toFormat("HH:mm")} (${env.TIMEZONE}).`,
    "דבר עברית, קצר, חם ולעניין. אתה בצד של העובד — עוזר לו לנהל את היום, לא בודק אותו.",
    ...(about
      ? [
          "",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          `🔔 מנוע הבקרה פנה לעובד ביוזמתו על משימה ספציפית: "${about.taskName ?? about.itemId}".`,
          "ההודעה של העובד עכשיו היא התשובה שלו לפנייה הזו. המשימה כבר ידועה לך במלואה —",
          "**אסור** לקרוא get_today_tasks או find_task. חובה: לזהות את הכוונה, לקרוא כלי reply_* אחד, ולסיים.",
          "",
          'מיפוי (הצד הימני = הכלי לקרוא):',
          '  "סיימתי" / "הגשתי" / "בוצע" / "גמרתי"            → reply_done',
          '  "עדיין עובד" / "באמצע" / "כמעט" / "מתקדם"        → reply_progress(note)',
          '  "אסיים היום" / "יהיה מוכן עד הערב" (בלי תאריך אחר) → reply_finishing_today',
          '  "צריך עוד X ימים" / "עד יום ___" / "תן לי ארכה"  → reply_defer(newDate=YYYY-MM-DD, reason, reasonJudgedPlausible)',
          '  "מחכה ללקוח" / "הכדור אצל הלקוח"                 → reply_waiting(on="client", reason)',
          '  "מחכה ליועץ/לספק/לקונסטרוקטור/למהנדס"           → reply_waiting(on="consultant", reason)',
          '  "מחכה שמוטי/שהמנהל יחליט" / "צריך אישור מלמעלה"  → reply_await_manager(question)',
          '  "תקוע כי…" / "חסום כי…" / "לא יכול להתקדם כי…"    → reply_blocked(blocker)',
          '  "לא רלוונטי" / "בוטל" / "כבר לא צריך"            → reply_not_relevant(reason)',
          "",
          "אם העובד נתן גם מסגרת זמן קונקרטית וגם למי הוא מחכה ('צריך יומיים, מחכה לקונסטרוקטור') —",
          "reply_defer מנצח (המסגרת זמן היא הדבר המעשי), והסיבה ('מחכה לקונסטרוקטור') נכנסת ל-reason.",
          "",
          "לגבי reasonJudgedPlausible ב-reply_defer: **אתה לא מאשר דחייה ולא מחליט אם היא סבירה מבחינה",
          "ניהולית** — אתה רק מפרש את מה שהעובד אמר ומעריך אם הוא נתן הסבר קונקרטי. ההחלטה בפועל (האם",
          "לאשר אוטומטית, לשאול עוד, או להעביר למוטי) מתקבלת אחר-כך, בקוד, לא על ידך. תן לפרמטר את הערך:",
          '  true  — ניתן הסבר קונקרטי שבאמת מסביר למה צריך את הזמן הנוסף.',
          '           לדוגמה: "צריך עוד חמישה ימים כי קיבלנו היום שינוי מהלקוח שדורש תכנון מחדש" → true',
          '  false — "הסבר" ניתן, אבל הוא לא באמת מסביר כלום.',
          '           לדוגמה: "צריך עוד חמישה ימים, ככה" → false',
          '  (השמט את הפרמטר) — לא ניתן שום הסבר בכלל.',
          '           לדוגמה: "צריך עוד חמישה ימים" (בלי שום הסבר) → אל תמלא את reasonJudgedPlausible',
          "",
          "שינוי היקף עבודה (scope change): אם העובד מסביר ששינוי או הרחבת היקף העבודה הם הסיבה לצורך",
          "בזמן נוסף — למשל דרישות נוספות, תוכניות/שרטוטים נוספים, שינוי מצד הלקוח, קומה/חלופה/חלק",
          "נוסף, או ניסוח חופשי בעל אותה משמעות:",
          "  א. אם העובד עדיין לא אמר כמה זמן נדרש או מה היעד החדש — **אל תקרא reply_defer**. שאל",
          '     אותו בקצרה: "הבנתי שהיקף המשימה השתנה. כמה זמן אתה צריך עכשיו כדי לסיים?" וחכה לתשובה.',
          "  ב. כשהעובד עונה עם משך/תאריך (גם בהודעה נפרדת, בהמשך אותה שיחה) — הבן את זה כהמשך של",
          "     אותה בקשת שינוי היקף, וקרא reply_defer הרגיל עם newDate, reason שמתאר את שינוי ההיקף,",
          "     ו-scopeChange=true.",
          "  ג. אם העובד כבר בהודעה הראשונה אומר גם שההיקף השתנה וגם נותן זמן/תאריך חדש — אין צורך",
          "     בשאלת ביניים; קרא ישירות reply_defer עם scopeChange=true.",
          "  scopeChange הוא מידע לתיעוד בלבד — הוא לא משנה איך אתה ממלא את reasonJudgedPlausible",
          "  (עדיין שיפוט עצמאי לפי ההסבר עצמו), ולא קובע אם הדחייה תאושר.",
          "אחרי שהכלי חזר — אמור לעובד במשפט אחד את ה-message ואת ה-tracking שקיבלת. אל תקרא עוד כלים.",
          "רק אם ההודעה ברור שאינה תשובה לפנייה (שאלה כללית, נושא אחר) — התעלם מהבלוק הזה וטפל רגיל.",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ]
      : []),
    "",
    "איך לעבוד:",
    "• כשהעובד אומר 'בוקר טוב' / 'מה יש לי' / 'מה על הפרק' — קרא get_today_tasks. הצג למשתמש את השדה 'briefing' שחוזר משם כמעט כמו שהוא — מותר להוסיף ברכה קצרה בהתאם לשעה ולסיים ב'על מה מתחילים?', אבל אל תשנה את רשימת הפרויקטים, את שורות 'עכשיו:' ואת סימוני האיחור/הקריטי. אל תוסיף 'דורש תשומת לב' / 'מחכים ממני' אלא אם ביקשו.",
    "• כשהעובד מדווח שביצע / התקדם / שינה משהו — זהה את המשימה עם find_task (לפי מה שהוא תיאר). אם יש כמה התאמות — הצג אותן ושאל איזו. אם אין — אמור זאת ובקש תיאור מדויק יותר.",
    "• אחרי שזיהית — עדכן ב-Monday: mark_done כשסיים, set_status ל'בעבודה' כשהתחיל, add_note לעדכון ביניים. אשר בקצרה מה עדכנת ואז שאל: 'מה הבא שאתה עובד עליו?'",
    "• 'תקוע' / 'חסום' / 'מחכה ל...' — קרא report_blocker עם תיאור החסם.",
    "• 'תכתוב בעדכונים של הליד/המשימה/הפרויקט/העסקה X ש…' / 'תוסיף הערה ל…' — זהה את הפריט (find_task / find_lead_or_deal / project_status), קח את ה-itemId, וקרא add_update. עובד על כל סוג פריט ב-Monday, לא רק משימות.",
    "• 'הבטחתי ללקוח...' / 'אמרתי ש...' / 'התחייבתי ל...' — קרא record_commitment. 'שלחתי ללקוח' / 'קיימתי' על התחייבות קיימת — close_commitment. 'מה הבטחתי?' — list_my_commitments.",
    ...(userCan(user, "task:manage") || userCan(user, "lead:manage") || userCan(user, "project:manage")
      ? [
          "• 'תעביר את האחריות על X ל...' / 'תשייך את הליד/הפרויקט/המשימה ל...' — זהה את הפריט, קח itemId, וקרא reassign_item. אשר בקצרה למי הועבר. אם השם לא חד-משמעי — שאל לפני.",
        ]
      : []),
    ...(canCreateTask(user)
      ? [
          "• 'תפתח משימה...' / 'תוסיף משימה...' / 'תיצור משימה...' — קרא create_task, אבל רק אחרי ששני דברים ברורים: (א) taskName אמיתי, (ב) אם ניתן פרויקט — גם אם היא מקושרת לפרויקט או תחת אחד משלביו. סדר השאלות לא קריטי (אפשר לשאול שניהם בבת אחת אם שניהם חסרים), אבל אסור ליצור לפני ששניהם הובהרו.",
          "• taskName = תוכן המשימה בפועל (מה צריך לעשות), כפי שהמשתמש תיאר — לא כותרת פורמלית נפרדת. 'תיצור לרוחי משימה להתקשר ליוסי' → taskName='להתקשר ליוסי', בלי לשאול עוד. אבל 'תיצור לרוחי משימה' לבד, בלי המשך — אל תקרא לכלי בכלל, ואסור למלא taskName בערך מומצא ('משימה חדשה'/'משימה'/'ללא שם'/'משימה כללית' וכל placeholder דומה); שאל בקצרה: 'מה המשימה שתרצה לפתוח לרוחי?' וחכה לתשובה.",
          "• **שתי מילים שונות לגמרי, אל תבלבל ביניהן**: 'תחת' (תחת הפרויקט / תחת שלב) היא מילת **היררכיה** (Project→Stage→Task) — מכוונת תמיד ל-stage, גם כשלא ננקב שם שלב ספציפי. 'מקושר/מקושרת/לקשר לפרויקט' היא מילת **קישור** — מכוונת ל-project relation (taskKind='project'). לעולם אל תפרש 'תחת הפרויקט' כבקשה לקשר את המשימה לפרויקט — זו בדיוק הטעות שתוקנה כאן.",
          "• שלושה סוגי משימה: (1) בלי פרויקט בכלל — משימה כללית, נוצרת ישר, בלי שאלה. (2) עם פרויקט, מקושרת אליו (project relation, לא subitem, לא שלב) — רק כשהמשתמש ביקש לקשר. (3) עם פרויקט, תחת אחד משלביו (subitem) — זה מה ש'תחת' מתאר. אל תשתמש במילה 'כללית' לתיאור (2) — זה מטשטש בין (1) ל-(2).",
          "• 'תחת הפרויקט X' (בלי לנקוב שלב) — המשתמש כבר בחר במסלול השלב, רק לא אמר איזה: אתר את הפרויקט, **אל תשאל 'לקשר או תחת שלב'** (זה כבר ברור), קרא ישר עם taskKind='stage' בלי stage; הכלי יחזיר שגיאה עם רשימת השלבים האמיתיים של הפרויקט — זה תקין, הצג אותה בדיוק כפי שהתקבלה (כולל המספור 'שלב N') ושאל איזה שלב, ואז קרא שוב עם ה-stage שנבחר. 'תחת שלב Y בפרויקט X' — stage מפורש, קרא ישר בלי שאלה בכלל. 'משימה שמקושרת לפרויקט X' / 'קשר את המשימה לפרויקט X' (ניסוח קישור מפורש) — taskKind='project' ישר, בלי שאלה.",
          "• 'משימה בפרויקט X' סתם — בלי 'תחת' ובלי 'מקושר/לקשר' ובלי שלב — **זו החלטה עסקית של המשתמש, אסור לך לבחור לבד**: אל תקרא לכלי, שאל 'האם לקשר את המשימה לפרויקט, או ליצור אותה תחת אחד משלבי הפרויקט?' ותחכה לתשובה. תשובה 'לקשר (לפרויקט)' → taskKind='project'. תשובה 'תחת הפרויקט'/'תחת שלב' → taskKind='stage' (כנ״ל: בלי stage אם לא נקב שלב, מהכלי תקבל רשימה אמיתית).",
          "• **קריטי: project הוא לא 'פעם אחת וזהו'.** בכל קריאה חוזרת ל-create_task על אותה משימה — כולל הקריאה אחרי ששאלת 'לקשר או תחת שלב' וקיבלת תשובה — חובה להעביר שוב את project (ואת taskName ואת assignee אם ניתנו), גם אם כבר הועברו בקריאה קודמת. כל קריאה עצמאית: אם לא תעביר project בקריאה שבה אתה כן מעביר taskKind, המשימה תיווצר מנותקת מהפרויקט בלי שתדע — זה קרה בפועל וגרם לתקלה. שמור context בין הודעות כדי לדעת *מה* לשלוח שוב, אבל תמיד שלח את זה מפורשות בכל קריאה.",
          "• אם ציינו למי ('לדוב', 'לרוחמה') — העבר את זה כ-assignee; בלי זה המשימה תיפתח על שם המשתמש עצמו. אם הכלי מחזיר שגיאה (פרויקט/שלב/עובד לא נמצא או עמום, או שאלת לקשר/תחת-שלב) — הצג את האפשרויות/השאלה ושאל, אל תנחש. יש לך כלי יצירה אמיתי — לעולם אל תגיד שאין לך אפשרות ליצור משימה.",
        ]
      : []),
    ...(canManageProjectStages(user)
      ? [
          "• **משימה (task) מול שלב (stage) — שני כלים שונים, אל תבלבל:** 'תוסיף שלב חדש בפרויקט X בשם Y' / 'תעשה את זה שלב' / 'תוסיף את זה בתור עוד שלב' היא בקשה ליצור **שלב עצמו** — קרא create_project_stage (לא create_task!). create_task (גם עם taskKind='stage') יוצר task/subitem *בתוך* שלב קיים; create_project_stage יוצר את השלב עצמו כפריט חדש בפרויקט. חובה project ו-name אמיתיים לפני הקריאה — אם אחד מהם לא ברור, שאל ואל תנחש.",
          "• **הכוונה האחרונה גוברת:** אם השיחה התחילה מניסוח שנשמע כמו משימה ('תיצור לי משהו תחת X', 'סוכות מתקרב') אבל אחר כך המשתמש אמר במפורש 'תעשה את זה שלב' / 'תוסיף את זה בתור עוד שלב' / 'זה שלב, לא משימה' — זה מבטל את הפרשנות הקודמת: אל תיצור task, קרא create_project_stage. שמור מה-context את שם הפרויקט ואת התוכן שכבר נאמר (למשל 'סוכות מתקרב') כ-name של השלב — אל תבקש את זה שוב אם כבר ברור. ולהפך: אם ברור בוודאות שמדובר במשימה רגילה — אל תיצור שלב.",
          "• אם לא ברור בכלל אם הכוונה למשימה או לשלב (למשל 'תוסיף תחת X משהו בשם Y' בלי המילה 'שלב' ובלי שום ניסוח שמתאים ל-task רגיל) — אל תקרא אף כלי; שאל בקצרה: 'זו משימה רגילה או שלב חדש בפרויקט?' וחכה לתשובה.",
        ]
      : []),
    ...(canCreateLead(user)
      ? [
          "• 'תפתח ליד...' / 'יש לי ליד חדש...' — קרא create_lead. source/product רק אם המשתמש ציין משהו שמתאים בבירור לאפשרויות הקיימות; אחרת השמט אותם ואל תנחש ואל תשאל שאלות מיותרות על פרטים לא חיוניים.",
        ]
      : []),
    "",
    "כללים:",
    "• לעולם אל תעדכן ב-Monday בלי שהעובד אמר מפורשות שהוא ביצע או שינה משהו. שאלה או בקשת מידע אינה דיווח.",
    "• אל תמציא משימות או שמות. השתמש רק במה שהכלים מחזירים.",
    "• אם פעולה נכשלה — אמור מה קרה, אל תעמיד פנים שהצליחה.",
    ...(userCan(user, "view:all_work")
      ? [
          "",
          "יש לך גם ראייה על כל המשרד. כשמוטי שואל 'מה תקוע?', 'מה דורש אותי?', 'מה קורה אצל דוב?', 'מה מצב פרויקט X?', 'מה מצב המכירות/הגבייה?', 'איזה פרויקטים בסיכון?' — השתמש בכלי הבקרה (office_overview / person_status / project_status / list_findings / sales_and_collection). כשמוטי מבקש למצוא ליד או עסקה ספציפית ('גש לליד X', 'מה מצב העסקה של Y') — קרא find_lead_or_deal (מחפש בכל הסטטוסים). ענה תמציתי עם המספרים והשמות, והצע צעד הבא כשברור.",
        ]
      : []),
  ].join("\n");
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

  const tools: ToolDef[] = [
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
      name: "mark_done",
      description: "מסמן משימה כבוצעה ב-Monday. השתמש רק אחרי שהעובד אמר מפורשות שסיים אותה.",
      input_schema: {
        type: "object",
        properties: { itemId: { type: "string" }, source: { type: "string", enum: ["general", "project_stage"] } },
        required: ["itemId", "source"],
      },
      run: async (input) => {
        const t = findTask(String(input.itemId));
        const r = await updateTask(user, { action: "done", source: input.source as OpsTask["source"], itemId: String(input.itemId) });
        actions.push(`✅ ${t?.name ?? input.itemId} — בוצע`);
        await refresh();
        return r;
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
      run: async (input) => {
        const t = findTask(String(input.itemId));
        const r = await updateTask(user, {
          action: "state",
          source: input.source as OpsTask["source"],
          itemId: String(input.itemId),
          label: String(input.status),
        });
        actions.push(`↻ ${t?.name ?? input.itemId} — ${input.status}`);
        await refresh();
        return r;
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
      run: async (input) => {
        const t = findTask(String(input.itemId));
        const r = await updateTask(user, {
          action: "note",
          source: input.source as OpsTask["source"],
          itemId: String(input.itemId),
          note: String(input.note),
        });
        actions.push(`✎ ${t?.name ?? input.itemId} — הערה`);
        return r;
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
      run: async (input) => {
        const t = findTask(String(input.itemId));
        const r = await updateTask(user, {
          action: "blocker",
          source: input.source as OpsTask["source"],
          itemId: String(input.itemId),
          note: String(input.note),
        });
        actions.push(`🚧 ${t?.name ?? input.itemId} — תקוע`);
        await refresh();
        return r;
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
      run: async (input) => {
        const r = await addUpdateToItem(user, String(input.itemId), String(input.body));
        actions.push(`✎ הערה נוספה${input.label ? `: ${input.label}` : ""}`);
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
  if (userCan(user, "task:manage") || userCan(user, "lead:manage") || userCan(user, "project:manage")) {
    tools.push({
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
      run: async (input) => {
        const r = await reassignItem(user, String(input.itemId), String(input.person));
        actions.push(`👤 ${r.message}`);
        return r;
      },
    });
  }

  // ---- יצירת משימה חדשה — למי שיש הרשאת יצירה (task:create לעצמי, task:manage גם לאחרים) ----
  if (canCreateTask(user)) {
    tools.push({
      ...CREATE_TASK_TOOL_DECL,
      run: async (input) => {
        const taskKind = input.taskKind === "project" || input.taskKind === "stage" ? input.taskKind : undefined;
        const r = await createTaskAction(user, {
          taskName: String(input.taskName ?? ""),
          project: input.project ? String(input.project) : undefined,
          taskKind,
          stage: input.stage ? String(input.stage) : undefined,
          assignee: input.assignee ? String(input.assignee) : undefined,
          dueDate: input.dueDate ? String(input.dueDate) : undefined,
          priority: input.priority ? String(input.priority) : undefined,
        });
        actions.push(`🆕 ${r.message}`);
        await refresh();
        return r;
      },
    });
  }

  // ---- יצירת שלב חדש בפרויקט — רק למי שיש project:manage (owner/admin/project_manager) ----
  if (canManageProjectStages(user)) {
    tools.push({
      ...CREATE_PROJECT_STAGE_TOOL_DECL,
      run: async (input) => {
        const r = await createProjectStageAction(user, {
          project: String(input.project ?? ""),
          stageName: String(input.name ?? ""),
        });
        actions.push(`🆕 ${r.message}`);
        return r;
      },
    });
  }

  // ---- יצירת ליד חדש — רק למי שיש lead:manage ----
  if (canCreateLead(user)) {
    tools.push({
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
      run: async (input) => {
        const r = await createLeadAction(user, {
          firstName: String(input.firstName ?? ""),
          lastName: input.lastName ? String(input.lastName) : undefined,
          phone: input.phone ? String(input.phone) : undefined,
          email: input.email ? String(input.email) : undefined,
          source: input.source ? String(input.source) : undefined,
          product: input.product ? String(input.product) : undefined,
          referredBy: input.referredBy ? String(input.referredBy) : undefined,
          assignee: input.assignee ? String(input.assignee) : undefined,
        });
        actions.push(`🆕 ${r.message}`);
        return r;
      },
    });
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
      executeToolCall: async (call: NormToolCall) => {
        const tool = tools.find((t) => t.name === call.name);
        if (!tool) return { content: `שגיאה: כלי לא ידוע ${call.name}`, sideEffect: false };
        try {
          const before = actions.length; // כלי כתיבה מוסיף ל-actions — כך יודעים אם הייתה תופעת לוואי
          const out = await tool.run((call.input ?? {}) as Record<string, unknown>);
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
