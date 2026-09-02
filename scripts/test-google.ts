import { DateTime } from "luxon";
import { env } from "../src/config/env.js";
import { createCalendarEvent } from "../src/integrations/google/calendar.js";
import { sendEmail } from "../src/integrations/google/gmail.js";
import { logger } from "../src/utils/logger.js";

async function main() {
  if (!env.USER_EMAIL) {
    throw new Error("Set USER_EMAIL in .env first (the Google account you used for the OAuth consent screen)");
  }

  const start = DateTime.now().setZone(env.TIMEZONE).plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0 });
  const end = start.plus({ minutes: 30 });

  logger.info("יוצר אירוע יומן בדיקה עם הזמנה אליך...");
  const event = await createCalendarEvent({
    summary: "בדיקת חיבור מהסוכן ✅",
    description: "אירוע בדיקה אוטומטי מהסוכן האישי",
    startISO: start.toISO()!,
    endISO: end.toISO()!,
    attendeeEmails: [env.USER_EMAIL],
  });
  logger.info({ eventLink: event.htmlLink }, "האירוע נוצר");

  logger.info("שולח מייל בדיקה...");
  const sent = await sendEmail({
    to: env.USER_EMAIL,
    subject: "בדיקת חיבור מהסוכן",
    text: "זהו מייל בדיקה אוטומטי מהסוכן האישי שלך. אם קיבלת את זה - החיבור ל-Gmail עובד!",
  });
  logger.info({ id: sent.id }, "המייל נשלח");
}

main().catch((err) => {
  logger.error(err, "test-google failed");
  process.exit(1);
});
