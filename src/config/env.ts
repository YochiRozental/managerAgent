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
  // ניסוי Prompt Caching ל-Web Chat (2026-10-14) — כבוי כברירת מחדל. בכוונה בלי רשימת-פיילוט
  // (כמו ATTENDANCE_PILOT_USER_KEYS) — מוגבל ל"יוכי" בלבד, hardcoded בקוד (ops/chat.ts), לא
  // קונפיגורבילי: זה ניסוי יחיד-משתמש, לא פיילוט מתרחב.
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
