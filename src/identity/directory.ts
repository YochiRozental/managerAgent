/**
 * ספר הצוות — הזהויות שהמערכת שלנו מכירה.
 *
 * החלטה (CLAUDE.md סעיף 3): הזהות חיה כאן, לא ב-Monday. לא מוסיפים משתמשים ל-Monday ולא עמודות.
 * משתמשי שלב 1: מוטי, דוב, איתן, רוחמה, גולדי, יוכי.
 *
 * `mondayUserId` — מזהה המשתמש ב-Monday, לשיוך משימות ולסינון "העבודה שלי". null = לא משתמש/ת
 * Monday פעיל/ה (גולדי עובדת דרך חיבור המערכת בלבד).
 */

import type { Role } from "./roles.js";

export interface TeamMember {
  /** מזהה פנימי יציב, נשאר קבוע גם אם השם/המייל משתנים */
  key: string;
  /** שם לתצוגה בעברית */
  name: string;
  role: Role;
  /** מזהה המשתמש ב-Monday, או null אם אינו משתמש Monday פעיל */
  mondayUserId: string | null;
  /** מייל לזיהוי ולתקשורת; null אם לא ידוע */
  email: string | null;
  /** JID של WhatsApp (מספר@s.whatsapp.net); null אם לא מוגדר ערוץ WhatsApp */
  whatsappJid: string | null;
  /** שמות נוספים שבהם המשתמש עשוי להופיע בעמודות אחראי ב-Monday (למשל שם באנגלית) */
  aliases?: string[];
}

/**
 * צוות Monday (מ-CLAUDE.md): מוטי 62912552 (admin) · איתן ברמן 62981836 · דוב שפירא 62982081 ·
 * רוחמה מינצר 62982385 · גולדי 63386527 (guest, לא פעילה) · Yochi 71724151 (admin).
 */
export const TEAM_DIRECTORY: TeamMember[] = [
  {
    key: "moti",
    name: "מוטי",
    role: "owner",
    mondayUserId: "62912552", // גם משתמש ה-API
    email: "info@gotlib.biz",
    whatsappJid: "972527530044@s.whatsapp.net",
  },
  {
    key: "dov",
    name: "דוב שפירא",
    role: "project_manager",
    mondayUserId: "62982081",
    email: "dov@gotlib.biz",
    whatsappJid: null, // דוב אמור לקבל ערוץ WhatsApp — המספר עדיין לא ידוע
  },
  {
    key: "eitan",
    name: "איתן ברמן",
    role: "project_manager",
    mondayUserId: "62981836",
    email: "eitan@gotlib.biz",
    whatsappJid: null,
  },
  {
    key: "ruchama",
    name: "רוחמה מינצר",
    role: "planner",
    mondayUserId: "62982385",
    email: "ruchama@gotlib.biz",
    whatsappJid: null,
  },
  {
    key: "goldi",
    name: "גולדי",
    role: "finance",
    mondayUserId: null, // guest 63386527 ולא פעילה — כותבת ל-Monday דרך חיבור המערכת
    email: null,
    whatsappJid: null,
  },
  {
    key: "yochi",
    name: "יוכי",
    role: "admin",
    mondayUserId: "71724151",
    email: "yochi66850@gmail.com",
    whatsappJid: null,
    aliases: ["Yochi", "yochi", "Yochi Rozental", "יוכי רוזנטל"],
  },
];

export function getTeamMemberByKey(key: string): TeamMember | undefined {
  return TEAM_DIRECTORY.find((m) => m.key === key);
}
