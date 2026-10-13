# בדיקות Live — הפעלה ידנית בלבד

הסקריפטים כאן מתחברים לשירותים אמיתיים: Monday, Google, WhatsApp ו-AI בתשלום. חלקם גם כותבים ל-`data/agent.db` המקומי. הם **לא** חלק מ-`npm test`: `vitest.config.ts` מריץ רק את רשימת `SAFE_TESTS`, ו-`scripts/**` חסום ב-`exclude`.

מריצים רק באישור מפורש, כשיודעים על איזו סביבה ועל איזה `.env` ההרצה עובדת. כל הסקריפטים טוענים את `.env` ואת ה-DB האמיתי (`data/agent.db`), אלא אם `AGENT_DB_PATH` מפנה למקום אחר.

## הסיכון בהפעלה

מקרא: **קריאה** = קורא משירות חיצוני · **כתיבה** = משנה נתונים אמיתיים · **הודעות** = יוצר הודעות או התראות לאנשים · **חיבור** = חיבור חיצוני מתמשך · **AI** = עלות מודל.

| סקריפט | פקודה | קריאה | כתיבה | הודעות | חיבור | AI | הערות |
|---|---|---|---|---|---|---|---|
| `test-monday.ts` | `npm run test:monday` | Monday | **Monday**: יוצר משימה בכל הרצה | — | — | — | בלי `MONDAY_BOARD_ID` רק מציג את רשימת הלוחות. הפריט שנוצר לא נמחק |
| `test-google.ts` | `npm run test:google` | — | **Google**: יוצר אירוע ביומן | **שולח מייל** ל-`USER_EMAIL` | Google OAuth | — | האירוע והמייל לא נמחקים |
| `test-whatsapp-echo.ts` | `npm run test:whatsapp` | — | — | **עונה** למספרים ב-`ALLOWED_WHATSAPP_JIDS` | **WhatsApp** עם ה-session המקומי (`auth/whatsapp`) | — | עלול להתנגש בחיבור של השרת על אותו מספר. רץ עד שעוצרים אותו |
| `test-cycle.ts` | `npm run test:cycle` | Monday | **DB מקומי**: ממצאים, הסלמות, התראות | **תור WhatsApp**: תדריך והסלמות. נשלחים אם ה-drainer רץ | — | — | מריץ סבב בקרה יומי מלא |
| `test-weekly.ts` | `npm run test:weekly` | Monday, DB | **DB מקומי**: התראה למוטי | **תור WhatsApp** של מוטי | — | — | דורס את הדוח השבועי הקודם שלא נשלח |
| `test-control.ts` | `npm run test:control` | Monday (כל המשרד) | — | — | — | — | קריאה בלבד. איטי (~30 שניות) |
| `test-crm.ts` | `npm run test:crm` | Monday (לידים, עסקאות, גבייה) | — | — | — | — | קריאה בלבד |
| `test-ops.ts` | `npm run test:ops -- <key>` | Monday | — | — | — | — | קריאה בלבד |
| `test-employee-feed-live.ts` | `npm run test:employee-feed-live -- <key>` | Monday | — | — | — | — | קריאה בלבד. מדפיס ספירות בלבד |
| `test-item-project-scope-live.ts` | `npm run test:item-project-scope` | Monday | — | — | — | — | קריאה בלבד. מזהי פריטים אמיתיים קבועים בקוד, ולכן עלול להיכשל אם הפריטים השתנו |
| `test-ai-compare.ts` | `npm run test:ai-compare` | Monday ו-Google (רק עם `--tools`) | — | — | Google OAuth (עם `--tools google/all`) | **כן**, שני מודלים | כלי קריאה בלבד. `--help` ו-`--list-tools` לא מריצים מודל |
| `test-create-task-behavior.ts` | `npm run test:create-task-behavior` | — | — | — | — | **כן** (smart) | הכלים מזויפים, כך שאין כתיבה ל-Monday. התוצאה לא דטרמיניסטית |
| `test-project-stage-behavior.ts` | `npm run test:project-stage-behavior` | — | — | — | — | **כן** (smart) | כמו הקודם |
| `test-attendance-monday-live-smoke.ts` | אין, בכוונה (`npx tsx scripts/live/...`) | Monday | **Monday**: יוצר פריט בלוח הנוכחות של יוכי (`1805215192`) | — | — | — | לא מוחק את הפריט. דורש אישור מפורש לכל הרצה |

## מה נשאר מחוץ לתיקייה הזו

- `scripts/e2e-loop.ts`: בדיקת E2E מלאה. **כותבת** ל-Monday (יוצרת ומוחקת משימת בדיקה), מריצה סבב בקרה על ה-DB, **שולחת פניות** ומפעילה **AI**. נשארה במקומה כי מריצים אותה בשרת אחרי העתקה ל-`/app/data/`. שם ה-import היחסי `../src` מצביע ל-`/app/src`, והעברה הייתה משנה אותו ושוברת את הזרימה הזו.
- `scripts/maintenance/`: כלי תחזוקה (למשל `backfill-escalation-identity.ts`; DRY-RUN כברירת מחדל, `--apply` כותב ל-DB).
- `scripts/google-auth.ts`, `scripts/print-links.ts`: כלי עזר, לא בדיקות.
