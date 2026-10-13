/**
 * בידוד סודות לבדיקות אוטומטיות — לפני שקוד כלשהו מייבא את src/config/env.ts.
 *
 *   • DOTENV_CONFIG_PATH → קובץ שלא קיים בתוך ה-temp, כך ש-`import "dotenv/config"` לא טוען את .env.
 *   • כל משתנה סביבה שנראה כמו סוד (KEY/TOKEN/SECRET/PASSWORD) שהגיע מהטרמינל — נדרס בערך דמה.
 *   • MONDAY_API_TOKEN חובה ב-env.ts → ערך דמה. ALLOWED_WHATSAPP_JIDS ריק.
 *
 * גם אם חסימת הרשת הייתה נכשלת — לא היה בידי הבדיקות שום token אמיתי לשלוח.
 */

import path from "node:path";

export const DUMMY_SECRET = "vitest-dummy-not-a-secret";
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

export function isolateEnv(tmpDir: string): void {
  process.env.DOTENV_CONFIG_PATH = path.join(tmpDir, "no-such.env");
  process.env.DOTENV_CONFIG_QUIET = "true";
  for (const name of Object.keys(process.env)) {
    if (SECRET_NAME.test(name)) process.env[name] = DUMMY_SECRET;
  }
  process.env.MONDAY_API_TOKEN = DUMMY_SECRET;
  process.env.ALLOWED_WHATSAPP_JIDS = "";
}
