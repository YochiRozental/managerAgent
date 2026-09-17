/**
 * בדיקת עקביות (לא איחוד!) בין יכולות-הליבה של שני צרכני tools.ts / chat.ts — WhatsApp
 * (src/integrations/claude/tools.ts, orchestrator.ts) והחלונית (src/ops/chat.ts).
 *
 * למה זה קיים: זו בדיוק התקלה שגילינו ב-2026-09-17 — create_monday_task ו-create_lead היו
 * קיימים ב-tools.ts (WhatsApp) ומעולם לא הגיעו לחלונית, כי chat.ts בונה רשימת כלים נפרדת
 * לגמרי. יוכי ביקש במפורש *לא* לאחד את שתי הרשימות (הן שונות בכוונה — tools.ts חושף
 * boardId/itemId גולמיים, chat.ts מפשט הכל למשתמש) — רק להימנע מפער *לא-מכוון* שנשכח.
 *
 * לא בודקת קוד חי: chat.ts בונה את רשימת הכלים שלו בתוך runOpsChat, תלוי בנתוני Monday/AI
 * חיים. במקום זאת סורקת את שמות הכלים ישירות מקוד המקור (regex על "name: "...""), בלי להריץ
 * כלום. תוצאה: דוח יכולות-ליבה לסקירה תקופתית — עוברת (exit 0) אם כל פער חד-צדדי מסומן
 * במפורש כמכוון (windowExempt/whatsappExempt); נכשלת (exit 1) על פער חדש שלא סומן, כדי
 * שהוא "יוצג בדוח" ולא יתגלה שוב במקרה על ידי משתמש.
 *
 *   npm run test:tool-parity
 */

import fs from "node:fs";
import { tools as whatsappTools } from "../src/integrations/claude/tools.js";
import { logger } from "../src/utils/logger.js";

const CHAT_TS_PATH = new URL("../src/ops/chat.ts", import.meta.url);

function extractWindowToolNames(): Set<string> {
  const src = fs.readFileSync(CHAT_TS_PATH, "utf-8");
  const names = new Set<string>();
  const re = /name:\s*"([a-z_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) names.add(m[1]!);
  return names;
}

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

function main() {
  const waNames = new Set(whatsappTools.map((t) => t.name));
  const winNames = extractWindowToolNames();

  let unexpectedGaps = 0;
  logger.info("— דוח tool-parity (WhatsApp ⇄ חלונית) —");
  for (const cap of CORE_CAPABILITIES) {
    const waHas = cap.whatsappNames.some((n) => waNames.has(n));
    const winHas = cap.windowNames.some((n) => winNames.has(n));

    if (waHas && winHas) {
      logger.info(`✅ ${cap.label} — קיים בשני הצדדים`);
      continue;
    }

    const missingOnWindow = waHas && !winHas;
    const missingOnWhatsapp = winHas && !waHas;

    if (missingOnWindow) {
      if (cap.windowExempt) {
        logger.info(`◻️  ${cap.label} — חסר בחלונית (מכוון: ${cap.windowExempt})`);
      } else {
        logger.error(`❌ ${cap.label} — חסר בחלונית ולא מסומן כפער מכוון!`);
        unexpectedGaps++;
      }
    } else if (missingOnWhatsapp) {
      if (cap.whatsappExempt) {
        logger.info(`◻️  ${cap.label} — חסר ב-WhatsApp (מכוון: ${cap.whatsappExempt})`);
      } else {
        logger.error(`❌ ${cap.label} — חסר ב-WhatsApp ולא מסומן כפער מכוון!`);
        unexpectedGaps++;
      }
    } else {
      logger.warn(`⚠️  ${cap.label} — לא נמצא באף צד. ייתכן ששם הכלי השתנה — עדכן את CORE_CAPABILITIES.`);
      unexpectedGaps++;
    }
  }

  if (unexpectedGaps > 0) {
    logger.error(`\n${unexpectedGaps} פערים לא-מוסברים. עדכן את CORE_CAPABILITIES (סימון exempt) או הוסף/תקן את הכלי החסר.`);
    process.exit(1);
  }
  logger.info("\nאין פערים בלתי-מוסברים ✅");
}

main();
