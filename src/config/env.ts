import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  // נדרש רק אם tier כלשהו מוגדר AI_*_PROVIDER=openai (ראה src/ai/tierConfig.ts)
  OPENAI_API_KEY: z.string().optional(),
  MONDAY_API_TOKEN: z.string().min(1),
  MONDAY_BOARD_ID: z.string().optional(),
  ALLOWED_WHATSAPP_JIDS: z.string().default(""),
  USER_EMAIL: z.string().email().optional(),
  TIMEZONE: z.string().default("Asia/Jerusalem"),
  ENABLE_VOICE_TRANSCRIPTION: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
  // מודול נוכחות (2026-10-11, שלב ב) — כבוי כברירת מחדל. ATTENDANCE_PILOT_USER_KEYS: רשימת
  // user_key (ר' identity/directory.ts) מופרדת בפסיקים, בדיוק תבנית ALLOWED_WHATSAPP_JIDS —
  // גם כש-ATTENDANCE_MODULE_ENABLED=true, רק מי שמופיע ברשימה הזו רואה את הכלים/מקבל תזכורות.
  ATTENDANCE_MODULE_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  ATTENDANCE_PILOT_USER_KEYS: z.string().default(""),
  // מדידת זמן עבודה על משימות (Task Timer, 2026-11-02) — כבוי כברירת מחדל. כמו הנוכחות: דגל + רשימת
  // פיילוט (user_key). הטיימר תלוי בנוכחות (attendanceEnabledForUser) — בלי יום נוכחות אין זמן אפקטיבי.
  TASK_TIMER_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  TASK_TIMER_PILOT_USER_KEYS: z.string().default(""),
  // סנכרון "זמן עבודה מצטבר" ל-Monday (2026-11-02) — כבוי כברירת מחדל, בלי תלות בדגל הטיימר עצמו.
  // מזהי העמודות (מספר, שעות) נוצרו ב-Monday ב-2026-11-02; ניתנים לעקיפה, ומאומתים (type=numbers) לפני כתיבה.
  TASK_TIMER_MONDAY_SYNC_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  TASK_TIMER_MONDAY_COLUMN_GENERAL: z.string().default("numeric_mm8q8czr"),
  TASK_TIMER_MONDAY_COLUMN_STAGE: z.string().default("numeric_mm8qnjjb"),
  // עמודות טקסט "זמן עבודה מצטבר (HH)" (HH:MM) — נכתבות באותה קריאה עם העמודה המספרית. ערך ריק = בלי תצוגת HH.
  TASK_TIMER_MONDAY_TEXT_COLUMN_GENERAL: z.string().default("text_mm8q5d4g"),
  TASK_TIMER_MONDAY_TEXT_COLUMN_STAGE: z.string().default("text_mm8q953x"),
  // Prompt Caching ל-Web Chat (2026-10-14, הורחב לכל המשתמשים 2026-10-18) — כבוי כברירת מחדל.
  // דגל גלובלי יחיד, בלי רשימת-פיילוט: כש-מופעל, כל משתמש ב-Web Chat מקבל אותה התנהגות (ר'
  // ops/chat.ts's promptCachingEnabled).
  PROMPT_CACHING_EXPERIMENT_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  // סינון סטטוסים סגורים בצד Monday ל-fetchProjectStageTasks בלבד (2026-10-16) — כבוי כברירת
  // מחדל. כש-false: אפס שינוי התנהגות/קריאות Monday — הקוד החדש (opsRead.ts's
  // getStageDoneLabelResolution) לא נקרא בכלל. ר' CLAUDE.md לרקע המלא ולבדיקת ההיתכנות החיה.
  STAGE_STATUS_SERVER_FILTER_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables — check your .env file against .env.example");
}

export const env = parsed.data;

export const allowedWhatsappJids = env.ALLOWED_WHATSAPP_JIDS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const attendancePilotUserKeys = env.ATTENDANCE_PILOT_USER_KEYS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const taskTimerPilotUserKeys = env.TASK_TIMER_PILOT_USER_KEYS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
