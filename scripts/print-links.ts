/**
 * מדפיס את קישור הכניסה האישי של כל עובד.  npm run links
 *
 * בסיס הכתובת: PUBLIC_URL (למשל https://ops.gotlib.biz) או http://localhost:<PORT>.
 * חובה שיהיה מוגדר אותו ACCESS_SECRET כמו בשרת, אחרת הקישורים לא יעבדו שם.
 */
import { allAccessLinks } from "../src/server/accessLink.js";

const base = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;

console.log(`\nקישורי כניסה אישיים — בסיס: ${base}\n`);
for (const { name, link } of allAccessLinks(base)) {
  console.log(`  ${name}`);
  console.log(`  ${link}\n`);
}
console.log("שולחים לכל אחד את הקישור שלו (וואטסאפ / מייל). הקישור קבוע.");
console.log("להחלפת כל הקישורים בבת אחת — לשנות ACCESS_SECRET ב-.env ולהריץ שוב.\n");
