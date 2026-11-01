/**
 * מדפיס את קישור הכניסה האישי של כל עובד.  npm run links
 *
 * בסיס הכתובת: PUBLIC_URL (למשל https://ops.gotlib.biz) או http://localhost:<PORT>.
 * חובה שיהיה מוגדר אותו ACCESS_SECRET כמו בשרת, אחרת הקישורים לא יעבדו שם.
 */
import { accessLinkFor, allAccessLinks, reissueAccessLink } from "../src/server/accessLink.js";

const base = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`;

// npm run links -- --reissue <key>  → מבטל את הקישור (וה-sessions) של עובד אחד ומדפיס קישור חדש. שאר העובדים לא מושפעים.
const reissueIdx = process.argv.indexOf("--reissue");
if (reissueIdx !== -1) {
  const key = process.argv[reissueIdx + 1];
  if (!key) {
    console.error("שימוש: npm run links -- --reissue <מפתח עובד>");
    process.exit(1);
  }
  const epoch = reissueAccessLink(key);
  console.log(`\nהקישור של ${key} הונפק מחדש (דור ${epoch}). הקישור הישן וה-sessions שלו בוטלו.\n`);
  console.log(`  ${accessLinkFor(key, base)}\n`);
  process.exit(0);
}

console.log(`\nקישורי כניסה אישיים — בסיס: ${base}\n`);
for (const { name, link } of allAccessLinks(base)) {
  console.log(`  ${name}`);
  console.log(`  ${link}\n`);
}
console.log("שולחים לכל אחד את הקישור שלו (וואטסאפ / מייל). הקישור קבוע.");
console.log("להנפקה מחדש לעובד אחד: npm run links -- --reissue <מפתח>  (בשרת: docker compose exec window npm run links -- --reissue <מפתח>)");
console.log("להחלפת כל הקישורים בבת אחת — לשנות ACCESS_SECRET ב-.env ולהריץ שוב.\n");
