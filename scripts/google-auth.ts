/**
 * יצירת data/google-token.json (חד-פעמי, בסביבה מקומית עם דפדפן).
 *
 *   npm run google-auth
 *
 * נפתח דפדפן לאישור גוגל → הטוקן נשמר ב-data/google-token.json.
 * אחר כך מעלים את הקובץ לשרת (scp) — בשרת אין דפדפן והזרימה הזו לא תרוץ שם.
 */

process.env.GOOGLE_AUTH_INTERACTIVE = "true";

import { google } from "googleapis";
import { getGoogleClient } from "../src/integrations/google/auth.js";
import { logger } from "../src/utils/logger.js";

async function main() {
  const auth = await getGoogleClient();
  // קריאה טריוויאלית לאימות שהטוקן עובד
  const cal = google.calendar({ version: "v3", auth });
  const list = await cal.calendarList.list({ maxResults: 1 });
  logger.info(
    { calendars: list.data.items?.length ?? 0 },
    "הרשאת Google הושלמה — data/google-token.json נשמר. העלה אותו לשרת: scp data/google-token.json root@<server>:/opt/managerAgent/data/",
  );
}

main().catch((err) => {
  logger.error(err, "google-auth נכשל");
  process.exit(1);
});
