/**
 * בדיקת עקביות (לא איחוד!) בין יכולות-הליבה של שני צרכני tools.ts / chat.ts — WhatsApp
 * (src/integrations/claude/tools.ts, orchestrator.ts) והחלונית (src/ops/chat.ts).
 *
 * למה זה קיים: זו בדיוק התקלה שגילינו ב-2026-09-17 — create_monday_task ו-create_lead היו
 * קיימים ב-tools.ts (WhatsApp) ומעולם לא הגיעו לחלונית, כי chat.ts בונה רשימת כלים נפרדת
 * לגמרי. יוכי ביקש במפורש *לא* לאחד את שתי הרשימות (הן שונות בכוונה — tools.ts חושף
 * boardId/itemId גולמיים, chat.ts מפשט הכל למשתמש) — רק להימנע מפער *לא-מכוון* שנשכח.
 *
 * שלב 2B (2026-10-05): עד כאן המטרה לא השתנתה. מה שהשתנה הוא *איך* מזהים מה קיים ב-Web —
 * קודם זה היה regex על טקסט המקור הגולמי של chat.ts (`name:\s*"([a-z_]+)"`), ששבר ברגע
 * ש-create_task עבר לבוא מ-AgentTool registry (ops/agentTools.ts) במקום מ-string literal
 * מקומי (ר' שלב 2A) — הכלי עובד זהה, אבל ה-regex לא "ראה" אותו יותר בטקסט של chat.ts.
 * זו תקלת-שיטה שהייתה חוזרת על עצמה בכל מעבר עתידי של כלי לרגיסטרי.
 *
 * עכשיו: אפס regex. שלושה exports אמיתיים בזמן ריצה, בלי Monday/AI/WhatsApp/DB-writes:
 *   - whatsappTools             (tools.ts)   — מה ה-WhatsApp בפועל חושף.
 *   - AGENT_TOOLS               (agentTools.ts) — מה *קיים* ב-registry המשותף (capability).
 *   - WEB_CHAT_LOCAL_TOOL_NAMES + WIRED_AGENT_TOOL_NAMES (chat.ts) — מה ה-Web *בפועל* חושף:
 *       local = עדיין מוגדר inline ב-chat.ts (לא עבר migration).
 *       wired = מגיע בפועל מ-AGENT_TOOLS (נגזר מ-.name של אובייקט אמיתי, לא retype).
 *
 * שלוש שאלות נפרדות שלא מתטשטשות זו בזו:
 *   1. קיים ב-registry?        ← חברות ב-AGENT_TOOLS.
 *   2. מחובר בפועל ל-Web?       ← חברות ב-(WEB_CHAT_LOCAL_TOOL_NAMES ∪ WIRED_AGENT_TOOL_NAMES).
 *   3. מחובר בפועל ל-WhatsApp?  ← חברות ב-whatsappWiredAgentToolNames (שלב 3B: add_update/
 *      create_lead — מיובאים בפועל מ-tools.ts, לא retype; שאר הכלים עדיין local ב-WhatsApp).
 * "קיים ב-registry" *אינו* מספיק כדי להסיק "מחובר": 8 מתוך 9 ה-AgentTools כיום (כל מה שאינו
 * create_task) כבר הועתקו לרגיסטרי (שלב 1) אבל chat.ts עדיין לא מחובר דרכם בפועל — זה דווח
 * כ"סטטוס מעבר" (informational), לא כ-❌. CORE_CAPABILITIES (היעד המוצרי, מה *אמור* להיות
 * זהה בין הערוצים) לא השתנה כלל — רק מקור השמות של כל צד.
 *
 * אפס side effects: כל המקורות הם imports של קבועים/exports סטטיים שכבר נבדקו גם ב-
 * test-agent-tools.ts (import chat.ts טוען גם את ה-db/* repositories שלו כרגיל — בלי שום
 * query/write בזמן import עצמו). אין Monday, אין AI, אין WhatsApp, אין שינוי DB.
 *
 *   הועבר מ-scripts/test-tool-parity.ts (הוסר). רץ ב-npm test. דוח "סטטוס המעבר" (informational בלבד) לא הועבר.
 */

import {
  tools as whatsappTools,
  ADD_UPDATE_AGENT_TOOL,
  CREATE_LEAD_AGENT_TOOL,
  MARK_DONE_AGENT_TOOL,
  SET_STATUS_AGENT_TOOL,
  CREATE_TASK_AGENT_TOOL,
  FIND_LEAD_AGENT_TOOL,
  UPDATE_LEAD_CONTACT_AGENT_TOOL,
} from "../../src/integrations/claude/tools.js";
import { AGENT_TOOLS } from "../../src/ops/agentTools.js";
import { WEB_CHAT_LOCAL_TOOL_NAMES, WIRED_AGENT_TOOL_NAMES } from "../../src/ops/chat.js";
import { describe, expect, it } from "vitest";

/**
 * שלב 3B (2026-10-05): add_monday_update/create_lead ב-tools.ts מחוברים בפועל ל-AgentTools
 * (ADD_UPDATE_AGENT_TOOL/CREATE_LEAD_AGENT_TOOL, מיובאים משם — לא retype). שלב 3D (2026-10-07):
 * mark_done/set_status נוספו באותו אופן. שלב 3E (2026-10-07): create_task נוסף באותו אופן בדיוק
 * — domain action נוסף ב-WhatsApp, מגובה ישירות ב-registry. נגזר מהאובייקטים האמיתיים, בדיוק
 * כמו WIRED_AGENT_TOOL_NAMES ב-chat.ts. שאר הכלים (reassign_item/add_note/report_blocker/
 * create_project_stage) עדיין לא מחוברים ל-WhatsApp — לא נוספו כאן, כי לא עברו migration בפועל.
 * update_monday_task_status/create_monday_task *נשארים* מחוץ לרשימה הזו בכוונה — legacy
 * fallbacks עצמאיים (Monday primitives גנריים), לא AgentTools.
 */
const whatsappWiredAgentToolNames: readonly string[] = [
  ADD_UPDATE_AGENT_TOOL.name,
  CREATE_LEAD_AGENT_TOOL.name,
  MARK_DONE_AGENT_TOOL.name,
  SET_STATUS_AGENT_TOOL.name,
  CREATE_TASK_AGENT_TOOL.name,
  FIND_LEAD_AGENT_TOOL.name,
  UPDATE_LEAD_CONTACT_AGENT_TOOL.name,
];

interface CoreCapability {
  label: string;
  whatsappNames: string[];
  windowNames: string[];
  /** יש כאן ערך → היעדרות בחלונית היא כוונה מוצרית ידועה, לא פער */
  windowExempt?: string;
  /** יש כאן ערך → היעדרות ב-WhatsApp היא כוונה מוצרית ידועה, לא פער */
  whatsappExempt?: string;
}

const CORE_CAPABILITIES: CoreCapability[] = [
  { label: "יצירת משימה", whatsappNames: ["create_monday_task"], windowNames: ["create_task"] },
  { label: "יצירת ליד", whatsappNames: ["create_lead"], windowNames: ["create_lead"] },
  {
    label: "איתור/עדכון פרטי קשר של ליד קיים (2026-10-08)",
    whatsappNames: ["find_lead", "update_lead_contact"],
    windowNames: ["find_lead", "update_lead_contact"],
  },
  {
    label: "עדכון סטטוס משימה",
    whatsappNames: ["update_monday_task_status"],
    windowNames: ["set_status", "mark_done"],
  },
  { label: "הוספת הערה/Update לפריט", whatsappNames: ["add_monday_update"], windowNames: ["add_update", "add_note"] },
  { label: "הקצאה/העברת אחראי", whatsappNames: ["assign_monday_task"], windowNames: ["reassign_item"] },
  { label: "צפייה ב'המשימות שלי'", whatsappNames: ["list_my_work"], windowNames: ["get_today_tasks"] },
  {
    label: "קביעת תאריך יעד על משימה קיימת",
    whatsappNames: ["set_monday_task_due_date"],
    windowNames: [],
    windowExempt: "בחלונית תאריך נקבע רק ביצירה (create_task) — אין כלי ייעודי לשינוי תאריך על משימה קיימת. פער אמיתי, לא מטופל בסבב הזה.",
  },
  {
    label: "מחיקת משימה",
    whatsappNames: ["delete_monday_task"],
    windowNames: [],
    windowExempt: "מחיקה לא נחשפת בחלונית בכוונה — פעולה הרסנית, לא בשלב הזה (CLAUDE.md §8).",
  },
  {
    label: "חיפוש משתמש/עובד כשלעצמו",
    whatsappNames: ["find_monday_user"],
    windowNames: [],
    windowExempt: "בחלונית פתרון שם עובד קורה בתוך create_task/reassign_item עצמם, לא ככלי נפרד.",
  },
  {
    label: "יומן Google — צפייה/יצירה/עדכון/מחיקה",
    whatsappNames: ["list_calendar_events", "create_calendar_event", "update_calendar_event", "delete_calendar_event"],
    windowNames: [],
    windowExempt: "Google Calendar לא מחובר לחלונית — כוונה מוצרית קיימת (WhatsApp/מוטי בלבד, CLAUDE.md §3).",
  },
  {
    label: "שליחת מייל",
    whatsappNames: ["send_meeting_summary_email"],
    windowNames: [],
    windowExempt: "כנ״ל — לא ערוץ של החלונית.",
  },
  {
    label: "בקרה על כל המשרד (office/person/project overview, ממצאים, מכירות/גבייה)",
    whatsappNames: [],
    windowNames: ["office_overview", "person_status", "project_status", "list_findings", "sales_and_collection"],
    whatsappExempt: "מנוע הבקרה נחשף רק בחלונית של מוטי/יוכי (view:all_work) — WhatsApp לא מיועד לזה.",
  },
];

// ── 0. עקביות פנימית של המקורות עצמם (defensive — תופס טעות הקלדה/registry drift) ──
describe("עקביות מקורות (WIRED_AGENT_TOOL_NAMES מול AGENT_TOOLS)", () => {
  const agentToolNames = new Set(AGENT_TOOLS.map((t) => t.name));
  for (const name of WIRED_AGENT_TOOL_NAMES) {
    it(`WIRED_AGENT_TOOL_NAMES: "${name}" קיים ב-AGENT_TOOLS`, () => {
      expect(agentToolNames.has(name), `"${name}" לא קיים ב-AGENT_TOOLS בכלל — טעות הקלדה או registry drift`).toBe(true);
    });
  }
  for (const name of WEB_CHAT_LOCAL_TOOL_NAMES) {
    it(`WEB_CHAT_LOCAL_TOOL_NAMES: "${name}" לא מופיע גם ב-WIRED_AGENT_TOOL_NAMES`, () => {
      expect(WIRED_AGENT_TOOL_NAMES.includes(name), `"${name}" מופיע בשתי הרשימות — תעדכן רק אחת מהן`).toBe(false);
    });
  }
});

// ── 1. דוח סטטוס המעבר ל-registry (informational בסקריפט המקורי, לא השפיע על pass/fail) — לא הועבר ──

// ── 2. ה-core capabilities (המטרה המוצרית — אותה לוגיקה בדיוק) ──
describe("tool-parity (WhatsApp ⇄ Web)", () => {
  const waNames = new Set(whatsappTools.map((t) => t.name));
  const winNames = new Set<string>([...WEB_CHAT_LOCAL_TOOL_NAMES, ...WIRED_AGENT_TOOL_NAMES]);
  for (const cap of CORE_CAPABILITIES) {
    it(cap.label, () => {
      const waHas = cap.whatsappNames.some((n) => waNames.has(n));
      const winHas = cap.windowNames.some((n) => winNames.has(n));
      expect(waHas || winHas, `${cap.label} — לא נמצא באף צד. ייתכן ששם הכלי השתנה — עדכן את CORE_CAPABILITIES`).toBe(true);
      if (waHas && !winHas) {
        expect(cap.windowExempt, `${cap.label} — חסר בחלונית ולא מסומן כפער מכוון`).toBeTruthy();
      }
      if (winHas && !waHas) {
        expect(cap.whatsappExempt, `${cap.label} — חסר ב-WhatsApp ולא מסומן כפער מכוון`).toBeTruthy();
      }
    });
  }
});
