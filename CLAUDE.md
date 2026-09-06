# גוטליב אדריכלים — סוכן תפעול ובקרה

מסמך הקשר לפיתוח. נטען אוטומטית בכל שיחת Claude Code בפרויקט הזה.
עודכן: 2026-09-02. הפיתוח אצל יוכי (`YochiRozental`). מוטי — מוצר/החלטות/אישורים.
הפרויקט יושב ב-`C:\Users\Yochi\Desktop\managerAgent` (הועבר מהמחשב של מוטי; היה `תיקיית קלוד קוד`).

---

## 1. מה הפרויקט

התחיל כ**סוכן WhatsApp בעברית** למשרד (ניהול משימות Monday + Google Calendar/Gmail + שיחה חופשית).
עכשיו מתרחב ל**סוכן תפעול ובקרה** מלא: שכבת בקרה מעל Monday שסורקת מה תקוע/חסר/מאחר, מניעה מעקב, ומוציאה למנהל רק חריגים — פלוס **חלונית דסקטופ לכל עובד**.

**המהות (מילים של מוטי):** במקום להוסיף למשרד מנהל משרד — בונים סוכן שינהל את הסדר. מוטי נשאר עם כובע הבקרה־על בלבד.

**Monday נשאר מקור האמת.** הסוכן לא מחליף אותו. תפקיד הסוכן: לקרוא → להבין → לבדוק → לשאול → לעדכן → להניע → להתריע → להסלים → לסכם.

**עקרון ארכיטקטוני:** מנוע AI מרכזי אחד. כל בקשה עוברת `זהות משתמש → תפקיד → הרשאות → הקשר → AI → פעולה מותרת`. הסוכן חייב לדעת מי המשתמש לפני החזרת מידע או ביצוע פעולה.

---

## 2. מסמכים

| מה | איפה |
|---|---|
| מפת המערכת + תוכנית עבודה מדורגת (מעוצב) | Artifact: https://claude.ai/code/artifact/57e6ba93-8386-4cfa-b134-d3de72ccaa39 |
| מסמך האפיון המקורי (נבנה עם ChatGPT) | `ops-agent-spec.md` (בשורש הריפו) |
| אפיון קודם של סוכן ה-WhatsApp | `agent-spec-final_3.md` |

---

## 3. ההחלטות שנסגרו (2026-09-01)

- **שרת:** שרת ענן חדש ופשוט (למשל DigitalOcean ~$24/חודש, 4GB). מעבירים לשם גם את סוכן ה-WhatsApp הקיים — מערכת אחת. ה-VM הנוכחי ב-GCP (e2-micro, 1GB) קטן מדי וכבר גרם לתקלות חוזרות.
- **משתמשי חלונית (שלב 1):** מוטי, דוב, איתן, רוחמה, גולדי, יוכי. **הזהות במערכת שלנו — לא מוסיפים משתמשים ל-Monday ולא עמודות ל-Monday.**
- **תפקידים:**
  - מוטי — בעלים / בקרה־על. לא רודף אחרי משימות.
  - דוב, איתן — משרטטים שמנהלים את הפרויקטים שלהם מקצה לקצה, **כולל הרישוי** של אותו פרויקט. "מנהל פרויקט" = מי שמופיע ב"אחראי/ת" של הפרויקט.
  - רוחמה — שרטטת/תכנון בלבד, עובדת על משימות בתוך הפרויקטים של דוב/איתן. לא מנהלת.
  - גולדי — כספים. כל ענייני הכספים מנותבים אליה. לא משתמשת Monday — כתיבה ל-Monday דרך חיבור המערכת.
  - **מנהל המשרד = הסוכן עצמו.**
  - יוכי — פיתוח/אדמין.
- **דיווח שעות:** הכל מהחלונית. כניסה/יציאה → שעון הנוכחות של העובד ב-Monday. טיימר לכל פרויקט → עמודת השעות של אותו עובד בבורד הפרויקטים (`1550734533`, עמודות `time_tracking*`).
- **הסלמה:** אגרסיבי. אין עדכון → תזכורת לעובד אחרי יום עבודה → מנהל הפרויקט אחרי עוד יום → מוטי רק בסיכון/קריטי. ניתן לכוונון אחרי הרצה.
- **אוטונומיה:** מאוזן. עדכונים תפעוליים פנימיים (סטטוס לפי דיווח מפורש של עובד, הוספת Update, יצירת משימת המשך לפי כלל) — הסוכן לבד. לקוח / כסף / מחיקה — מכין ומחכה לאישור אנושי.
- **WhatsApp:** אותו מספר של הסוכן הקיים. הסוכן הקיים + מנוע הבקרה = מערכת אחת. רוב הצוות במכשירים כשרים בלי WhatsApp — לכן החלונית היא הערוץ המרכזי, לא WhatsApp (WhatsApp = מוטי, ודוב).

---

## 4. מפת Monday

חשבון `gottlieb-league.monday.com`, סביבת עבודה **CRM** (`id 2191379`). משתמש API: מוטי (`id 62912552`).
**קרא `get_board_info` לפני עבודה מול בורד — יש הרבה עמודות mirror/formula, וה-IDs של העמודות לא מדברים.**

| בורד | ID | תוכן ליבה |
|---|---|---|
| לידים 💰 | `1550734525` | 134 לידים. סטטוס `color__1` (ליד חדש / ניסיון יצירת קשר / פוטנציאלי / פולואפ / עבר לעסקה / נסגר / לא רלוונטי / הוקפא). `color1__1` מקור הגעה, `color5__1` מוצר, `date__1` "תאריך הבא לתזכורת", `multiple_person__1` אחראי. קשור לעסקאות/לקוחות/פרויקטים/אנשי קשר/פגישות. |
| כל הפרויקטים 🏆 | `1550734533` | 147 פרויקטים. `person` אחראי/ת, `label3__1` תחום, `status1__1` מוצר, `status_17__1` סטטוס פרויקט (טרם החל / בעבודה / תקוע / מוקפא / לקראת היתר / קיבל היתר / קיבל תכניות עבודה / בבניה / לקראת מסירה / הסתיים / במכרז), `date4__1` מסירה משוער, `link_to____________9__1` → מאגר משימות. `time_tracking*` שעות פר-עובד, `formula4__1` עלות עובדים, `formula95__1` רווח הפרויקט, `numbers47__1` תקציב לקוח, `connect_boards2__1` → גבייה. |
| מאגר משימות פרויקטים 🗒️ | `1550734531` | 1012 שורות. קבוצה לכל פרויקט = שלביו. `status` סטטוס שלב (לביצוע / בעבודה / הושלם / תקוע / ממתין ללקוח / ממתין ליועץ / בטיפול ועדה). **תת-פריטים = משימות השלב** (`Subitems of` board `1550734556`): `person` אחראי, `color__1` סוג משימה, `color85__1` סטטוס משימה, `color8__1` תעדוף, `status__1` "אחראי-למנות" (תפקיד: בעלים מעצב/אדריכל, מנהלת רישוי, מנהל/ת משרד, מנהל/ת פרויקט, שרטט/ת, פרילנסר חיצוני), `color2__1` "באחריות" (המשרד / וועדה / הלקוח / קבלן־יועץ), `date__1` תאריכי משימה, `dependency__1` תלות. |
| משימות 📝 | `1550734526` | 404 משימות משרד כלליות. `person` אחראי, `status` סטטוס (לביצוע / בעבודה / בוצע / תקוע / חסר מידע / ממתין להתייחסות / מושהה), `priority` תעדוף (קריטי / גבוה / בינוני / נמוך), `date4` תאריך לביצוע, `link_to_contacts__1` לקוח, `board_relation_mkqzzfgt` פרויקט, `integration_mkzq9wbn` Google Calendar event. תת-פריטים ב-board `1550734559`. |
| גבייה — הכנסות ➕ | `1550734546` | 84 שורות. `status` סטטוס גבייה (ממתין לתשלום / בתהליך / מאחר / שולם / עתידית), `status9__1` אופן תשלום (לפי שלבים / מראש / שוטף+30 / פריסה), `link_to___________1` פרויקט. **תת-פריטים = תשלומים בודדים** (board `1550734569`): `numbers__1` סכום, `date0` תאריך לתשלום, `date__1` תאריך תשלום בפועל, `status__1` אמצעי תשלום, `boolean_mktswhzv` checkbox פינבוט. |
| עובדים ⏳ | `1550734548` | 9 עובדים. `person` משתמש עובד, `numeric` תעריף שעתי-עלות, `status7__1` מתכונת העסקה (פרילנסר / שכיר / בעלים), `board_relation__1` → שעון הנוכחות שלו. |
| נוספים | — | עסקאות `1550734529`, הזמנות והצעות מחיר `1550734530`, לקוחות `1550734534`, אנשי קשר `1550734528`, הסכמים `2124228925`, ספקים ויועצים `1550734532`, פגישות-יומן `1550734535`, מוצרים `1550734527`, הוצאות `1550734547`, שעוני נוכחות פר-עובד. |

**צוות Monday:** מוטי `62912552` (admin) · איתן ברמן `62981836` `eitan@gotlib.biz` · דוב שפירא `62982081` `dov@gotlib.biz` · רוחמה מינצר `62982385` `ruchama@gotlib.biz` · גולדי `63386527` (guest, לא פעילה) · שרה לוי `62982381` (guest) · Yochi `71724151` (admin).

**מה שכבר בנוי ב-Monday ואין לשכפל:** רווחיות פרויקט (formula), מעקב שעות פר-עובד פר-פרויקט, מסלול גבייה עם שלבי תשלום + checkbox פינבוט, פייפליין לידים עם תאריכי תזכורת.

---

## 5. הקוד הקיים

**Stack:** Node.js + TypeScript, `tsx` (ללא שלב build, ללא type-check בזמן ריצה), ES modules (`"type": "module"`, imports עם סיומת `.js`). Docker + docker-compose (`restart: unless-stopped`).

**חבילות מפתח:** `@anthropic-ai/sdk` (orchestrator tool-use, מודל `claude-sonnet-5`) · `@mondaydotcomorg/api` (GraphQL raw) · `googleapis` (Calendar + Gmail) · `@whiskeysockets/baileys` (WhatsApp Web, לא רשמי, מספר ייעודי) · `luxon` (Asia/Jerusalem) · `zod` · `@huggingface/transformers` (Whisper STT — מכובה כרגע).

**מבנה `src/`:**
- `index.ts` — נקודת כניסה: מחבר WhatsApp, מריץ `leadEmailWatcher`. יש `process.exit(1)` על כל שגיאה לא נתפסת (Docker מרים מחדש).
- `config/env.ts` — טעינת env דרך zod. `MONDAY_API_TOKEN` חובה.
- `pipeline/messageHandler.ts` — צינור הודעה נכנסת → orchestrator → תשובה. try/catch עליון.
- `pipeline/confirmation.ts` — פעולות `requiresConfirmation` מחכות לאישור.
- `integrations/claude/orchestrator.ts` + `tools.ts` — לולאת tool-use. הכלים כיום: `list_monday_boards`, `find_monday_board`, `list_monday_tasks`, `list_my_work`, `create_monday_task`, `update_monday_task_status`, `set_monday_task_due_date`, `delete_monday_task` (confirm), `find_monday_user`, `assign_monday_task`, `add_monday_update`, `create_lead`, `list_calendar_events`, `create_calendar_event` (confirm), `update_calendar_event` (confirm), `delete_calendar_event` (confirm), `send_meeting_summary_email` (confirm).
- `integrations/monday/` — `client.ts`, `tasks.ts`, `leads.ts`, `users.ts`.
- `integrations/google/` — `auth.ts`, `calendar.ts`, `gmail.ts`, `leadEmailWatcher.ts` (polls Gmail לטופס יצירת קשר מהאתר → יוצר ליד. יש cutoff floor ב-`data/leadWatcherState.json` — חובה בכל watcher עתידי).
- `integrations/whatsapp/` — `client.ts` (חיבור + `startHealthWatchdog` ping כל 3 דק'), `send.ts` (retry+backoff).
- `integrations/stt/whisper.ts`, `integrations/tts/edgeTts.ts` — קול, כבוי (`ENABLE_VOICE_TRANSCRIPTION`).
- `db/` — `node:sqlite` / `better-sqlite3`, `schema.sql`, `repositories/pendingActions.ts`.

**הרצה:** `npm run dev` (watch) · `npm start` · בדיקות: `npm run test:monday` / `test:google` / `test:whatsapp`.

**דגלים חשובים בקוד הקיים:** `list_my_work` מכוון בכוונה רק לבורד המשימות הראשי + תת-פריטיו (לא בורדי CRM, ששם "אחראי" = בעלים ולא משימה) ומסנן "בוצע".

---

## 6. תוכנית העבודה — והגדרת "בוצע" לכל שלב

| # | שלב | בוצע כאשר |
|---|---|---|
| 0 | תשתית | שרת ענן חדש רץ; סוכן ה-WhatsApp הקיים הועבר ועובד משם; חיבורים ל-Monday/Google/WhatsApp פעילים; שכבת זהות+תפקיד+הרשאות קיימת. |
| 1 | חלונית עובד — צפייה | עובד נכנס עם זהות אישית ורואה 3 מסכים חיים מ-Monday: "היום שלי", "באיחור / דורש תשומת לב", "מחכים ממני". קריאה בלבד. |
| 2 | חלונית עובד — עדכון + שעות | סימון בוצע / הערה / דיווח חסם נכתבים ל-Monday. כניסה/יציאה + טיימר פר-פרויקט מזינים את שעוני הנוכחות ואת עמודות השעות. |
| 3 | צ'אט AI לעובד | שפה חופשית ("סיימתי את התכניות", "מה עליי היום?"). מזוהה לפי משתמש, רק ההרשאות שלו. מעדכן את השלב הנכון ומזהה מה הבא בתור. |
| 4 | מנוע הבקרה | סריקות יזומות: משימה באיחור / בלי אחראי / בלי תאריך / תקועה / חוסמת / שלב פעיל בלי משימה פתוחה. הסלמה אגרסיבית. תדריך בוקר למוטי (WhatsApp + חלונית) — רק מה שדורש תשומת לב ניהולית. |
| 5 | דוחות | שבועי, חודשי, מדדי מכירות (ליד→פגישה→הצעה→חתימה), רווחיות פר-פרויקט, עמידה בזמנים, מצב גבייה. |
| 6 | תפעול יזום מתקדם | פולואפ לידים לפי "תאריך הבא לתזכורת"; לקוח שממתין לעדכון; מעקב מכרזים (מועדים, תנאי סף, מסמכים, חוסרים); גבייה יזומה (תשלום מתקרב/מאחר). |
| 7 | בהמשך | חיבור פינבוט (קישור תשלום/חשבונית, עדכון סטטוס תשלום אוטומטי). בחינת מערכת עצמאית מעבר ל-Monday. |

**"הפעולה הבאה" של פרויקט מחושבת, לא נשמרת:** השלב הפתוח הראשון שאינו חסום ב"מאגר משימות" של הפרויקט, והמשימה הפתוחה הבאה בתוכו. האחראי = עמודת האחראי של המשימה; אם ריקה → לפי "אחראי-למנות" + מפת האחריות (סעיף 3).

---

## 7. פתוח — באחריות מוטי (נדרש לפני שלב 4, לא חוסם 0–3)

- **תבניות שלבים לפי סוג פרויקט** — אילו שלבים סטנדרטיים לבית פרטי / מעון יום / בית כנסת / רישוי בלבד / עיצוב פנים. דרוש לפתיחת פרויקט מתבנית ולחישוב "השלב הבא".
- **מודל תשלומים מול שלבים** — אחוז מקדמה, אבני דרך, מתי מפיקים חשבונית.
- **טון והודעות ללקוח** — נוסחים; מה הסוכן שולח לבד ומה רק מכין.
- **מכרזים** — מה הסוכן עוקב אחריו ומתי מתריע (החלטת GO/NO-GO נשארת אצל מוטי).
- **ספי הסלמה מדויקים** — לכוונן אחרי ~שבועיים הרצה.

---

## 8. מוסכמות ועקרונות

- **כל טקסט מול משתמש — עברית.** אזור זמן `Asia/Jerusalem`. שבוע עבודה א׳–ה׳.
- לפני עבודה מול בורד Monday — `get_board_info` תמיד. אל תניח column IDs.
- כל watcher/poll של מקור חיצוני חייב **activation-time floor** מהיום הראשון (לא רק dedup) — ראה תקרית ה-51 לידים הכפולים ב-`leadEmailWatcher`.
- פעולות הרסניות / מול לקוח / כספיות → `requiresConfirmation: true` ואישור אנושי. אף פעם לא bulk-delete/bulk-update של רשומות אמת ב-Monday בלי לשאול שוב רגע לפני.
- אמינות לפני נוחות — זה מיועד להיות מוצר מסחרי. self-recovery, retry, `process.exit(1)` על שגיאה קטלנית כדי ש-Docker ירים מחדש.
- כתיבת קוד: להתאים לסגנון הקיים (הערות בעברית, בלי build step, imports עם `.js`).

---

## 9. סודות — לא נכנסים ל-git

`.env` · `google-credentials.json` · `data/google-token.json` · `auth/whatsapp/` (session Baileys) · `data/*.db`.
כולם ב-`.gitignore`. בשרת החדש — להעביר בנפרד ובבטחה, לא בקוד.
env keys: `ANTHROPIC_API_KEY`, `MONDAY_API_TOKEN`, `MONDAY_BOARD_ID`, `ALLOWED_WHATSAPP_JIDS`, `USER_EMAIL`, `TIMEZONE`, `ENABLE_VOICE_TRANSCRIPTION`, `PORT` (חלונית, 3001), `SESSION_SECRET` (עוגיית הפעלה), `ACCESS_SECRET` (חתימת קישורי כניסה אישיים), `PUBLIC_URL` (כתובת חיצונית לבניית הקישורים), `REQUIRE_ACCESS_LINK` (true = כניסה רק דרך קישור). כל הסודות כבר ב-`.env` המקומי (ערכים אקראיים נוצרו 2026-09-03).

---

## 10. הצעד הבא

**מצב 2026-09-02:** הקוד עבר למחשב של יוכי (`managerAgent`), `npm install` רץ, מסמך האפיון בריפו כ-`ops-agent-spec.md`, 6 קבצי הזיכרון הוזרקו למחשב הזה.
מאגר פרטי: **https://github.com/YochiRozental/managerAgent** (main, Git Credential Manager). קומיט ראשון נדחף.

**נעשה 2026-09-02:**
- סמוק-טסט: `test:monday` + `test:google` ירוקים מהמחשב של יוכי. (נוצר פריט בדיקה 3200750777 בבורד משימות — למחוק ידנית.)
- **שכבת זהות + תפקיד + הרשאות** נבנתה — `src/identity/` (`directory.ts` ספר 6 המשתמשים, `roles.ts` מטריצת הרשאות, `resolve.ts` זיהוי לפי JID/Monday-id/מייל/key). כל כלי ב-`tools.ts` קיבל `requiredPermission`. ה-orchestrator מקבל `IdentifiedUser`, מסנן כלים לפי הרשאות, מזריק זהות ל-system prompt, ואוכף הרשאה לפני כל הרצה + לפני ביצוע פעולה מאושרת. `messageHandler` מזהה לפי JID. בדיקות: `npm run test:identity`. משתמש לא מזוהה → 0 כלים, אין פעולות. דף לאישור: Artifact `f1e2260e-0877-4115-8726-c21a9ccc88c4`.
- **המטריצה אושרה מול מוטי (2026-09-02):** 14 הרשאות. owner=הכל · admin (יוכי)=הכל למעט `approve:sensitive` — **אישור כסף/מחיקה/לקוח = מוטי בלבד** · project_manager=9 · finance=4 · planner=4. `task:create` הופרד מ-`task:manage`: **רוחמה כן יוצרת לעצמה משימות המשך**, אך לא מקצה לאחרים ולא מנהלת פרויקט. `create_monday_task` → `task:create`.
- פתוח: **WhatsApp כרגע רק למוטי**; מספרי WhatsApp של דוב+איתן ומייל של גולדי עדיין חסרים (מייל יוכי `yochi66850@gmail.com` נוסף); ה-`whatsappJid` בספר אמור בהמשך להחליף את `ALLOWED_WHATSAPP_JIDS`; scope פר-פרויקט למנהלי פרויקט מחושב בשלב 4.
- **שלב 1 — הבקאנד של שלוש התצוגות נבנה ונבדק מול הדאטה האמיתי** (קריאה בלבד). `src/integrations/monday/opsRead.ts` — `fetchUserOpsTasks(mondayUserId)` מושך משימות פתוחות פר-עובד משני מקורות: בורד "משימות 📝" `1550734526` + תת-פריטי "מאגר משימות פרויקטים" (בורד `1550734556`). `src/ops/dashboard.ts` — `getEmployeeDashboard(user)` בונה `myDay` / `needsAttention` / `waitingOnMe` (הגדרות v1, לכיוונון). `client.ts` קיבל `mondayRequest()` עם retry/backoff על rate-limit/complexity. בדיקה: `npm run test:ops -- <key>`. **תובנות מהרצה:** סינון person ב-items_page עובד רק עם `compare_value: ["person-<id>"]`; עמודות board_relation/mirror צריכות `display_value` (ה-`text` מגיע null); עמודות תאריך חוזרות עם שעה — חותכים ל-10 תווים. ספירות אמת: מוטי 292 פתוחות (owner — צריך תצוגת בקרה נפרדת, לא רשימת משימות), דוב 84, איתן 107, רוחמה 18, יוכי 0, גולדי 0.
- **"מחכים ממני" שופר לזיהוי לפי תלות (אושר מוטי):** `getReverseDependencyMap()` ב-`opsRead.ts` סורק תת-פריטים עם `dependency__1` ובונה מפה הפוכה blocker→dependents (cache 5 דק'). משימה נכנסת ל"מחכים ממני" אם משהו תלוי בה, או שיש דדליין/תקועה. `flags.blocking` על כל משימה.
- **חלונית העובד נבנתה** — `src/server/` (שרת `node:http` בלי framework). `npm run window` → `http://localhost:3001`. כניסה לפי בחירת שם/מייל → עוגייה חתומה HMAC (`session.ts`, בלי סיסמאות — כלי פנימי, שלב 2 יצטרך אימות אמיתי). API: `/api/users` `/api/login` `/api/logout` `/api/session` `/api/dashboard` `/api/oversight`. UI: `src/server/ui.html` (עמוד יחיד, vanilla JS, RTL, עברית, light+dark). 3 טאבים + חיפוש חי.
- **שני המצבים של מוטי (אושר):** (א) "המשימות שלי" — בדיוק כמו כל עובד. (ב) "בקרה — כל המשרד" — `src/ops/oversight.ts` `getOversightReport()` (דורש `view:all_work` → מוטי + יוכי): עומס לכל אדם (פתוחות/באיחור/תקועות/חוסם/להיום + 3 הכי-באיחור) + פרויקטים עם דגלים (תקוע/מוקפא/איחור מסירה/משימות באיחור/בלי אחראי). כבד (~30ש' טעינה ראשונה, cache 3 דק'). ספירות אמת: 501 משימות צוות, 41 באיחור, 9 תקועות, 35 פרויקטים מסומנים.
- **לכיוונון:** פרויקטים "מוקפא" אולי לא צריכים דגל אלא אם יש להם גם משימות באיחור; יש משימות באיחור של 400+ ימים (דאטה ישן ב-Monday) — הבקרה חושפת אותן; טעינת הבקרה איטית (5 עובדים בטור) — אפשר concurrency 2.
- **שלב 2א — כתיבה מהחלונית נבנתה ונבדקה מול Monday אמיתי.** `src/integrations/monday/opsWrite.ts` (`setTaskStatus` פר-מקור עם column IDs מפורשים + `assertUserOwnsItem` שמאמת שהמשימה של המשתמש דרך `PeopleValue.persons_and_teams`), `src/ops/actions.ts` `updateTask(user, {action})` — done / state / note / blocker, כל אחת: `task:update_own` → בעלות (אלא אם `task:manage`) → כתיבה. `POST /api/task/update`. בכל כרטיס משימה בחלונית: "✓ סיימתי · ▶ בעבודה · ⚠ חסם · ✎ הערה" + composer להערה/חסם + toast. נבדק: שינוי סטטוס נכתב ל-Monday והוחזר; guard דוחה משימה שאינה של המשתמש; תווית לא חוקית נדחית.

- **שלב 2ב (שעות) — נדחה. חסם טכני:** עמודת `time_tracking` של Monday היא **read-only דרך ה-API** (אין start/stop/כתיבת session — נבדק מול התיעוד). בשילוב "לא מוסיפים עמודות ל-Monday" — התוכנית המקורית לא אפשרית. מוטי החליט לדלג לבינתיים; כשנחזור — מאגר שעות אצלנו (SQLite) + חישוב רווחיות עצמאי בשלב 5.
- **שינוי כיוון (מוטי, 2026-09-03): המערכת עוברת לסגנון שיחה.** במקום טאבים — צ'אט לכל עובד. "בוקר טוב" → העוזר מציג משימות היום → העובד מדווח מה ביצע → העוזר מעדכן Monday → "מה הבא?". נבנה: `src/ops/chat.ts` `runOpsChat(user, history)` — לולאת tool-use (Anthropic SDK, `claude-sonnet-5`) עם כלים ממודרים לעובד: `get_today_tasks` / `find_task` (fuzzy match) / `mark_done` / `set_status` / `add_note` / `report_blocker` — כולם דרך `updateTask` (הרשאה+בעלות). `POST /api/chat` `{messages}`. ה-UI נכתב מחדש כצ'אט (`ui.html`): בועות, היסטוריה ב-localStorage פר-משתמש, quick-replies, "בקרה" כ-overlay למוטי. **נבדק מקצה לקצה בדפדפן:** רוחמה/דוב אומרים "בוקר טוב" → סיכום ממודר; "התחלתי לעבוד על X" → `find_task` → אישור → `set_status בעבודה` נכתב ל-Monday (והוחזר בבדיקה).

- **"הפעולה הבאה" של פרויקט — נבנתה ומחוברת לצ'אט (מוטי ביקש).** `getProjectNextAction(projectId)` ב-`opsRead.ts`: project → `link_to____________9__1` (שלבים) → subitems; ממיין שלבים לפי מספר ("שלב N") כי סדר `items(ids:)` לא אמין; **סטטוס השלב עצמו כמעט תמיד ריק** — קובעים "השלב הנוכחי" = השלב הגבוה ביותר שיש בו משימה שהושלמה, ומשם המשימה הפתוחה הראשונה שאינה חסומה ע"י תלות. `OpsTask.projectId` נוסף (משני הבורדים). `src/ops/chat.ts` `buildTodayBriefing()` — תדריך "בוקר טוב" מקובץ לפי פרויקט, שורת "עכשיו: <משימה> · <שלב>" לכל פרויקט (+"זו המשימה שלך" / "אצל X" / "עדיין לא משויך"), משימות משרד בנפרד. **המודל נטה לנסח מחדש ולאבד את המבנה — לכן `runOpsChat` מגיש את התדריך מילה במילה** (עם ברכה לפי השעה) כשלא בוצעו עדכונים. cache 5 דק' פר-פרויקט. נבדק בדפדפן: רוחמה ודוב מקבלים תדריך מקובץ עם "עכשיו:" לכל פרויקט. איטי בטעינה קרה (~17ש' למנהל פרויקט — סריקת reverse-deps + כמה next-actions; מהיר עם cache).

- **הרצה רציפה + קישורים אישיים (מוטי ביקש, 2026-09-03).** `src/server/accessLink.ts` — קישור magic-link לכל עובד: `/?t=<token>` כאשר `token = base64url(key).hmac(key, ACCESS_SECRET)` (דטרמיניסטי, קבוע, מתבטל ע"י החלפת הסוד). `GET /` בודק `?t=`, מזהה, שם עוגייה, מגיש (ה-token נשאר ב-URL לסימנייה; ה-UI מנקה אותו מסרגל הכתובת אחרי כניסה). `npm run links` מדפיס קישור לכל אחד. `REQUIRE_ACCESS_LINK=true` → מכבה את מסך בחירת השם ו-`/api/login`. `accessLink.ts` + `session.ts` קוראים `dotenv/config` בעצמם (print-links לא עובר דרך env.ts). **PM2:** `ecosystem.config.cjs` קיבל אפליקציית `ops-window`; רץ עכשיו תחת PM2 על המחשב של יוכי (`pm2 save` בוצע). שרידות ריבוט ב-Windows דורשת `pm2-installer` (הרצה כשירות) — עדיין לא נעשה.
- **פתוח — נגישות מבחוץ:** כרגע `localhost:3001` בלבד. כדי שהעובדים ייכנסו מהטלפון צריך כתובת חיצונית: שרת ענן (שלב 0), או Cloudflare Tunnel מהמחשב של יוכי כביניים.

- **שלב 4 — מנוע הבקרה, סריקה ראשונה (2026-09-03).** `src/ops/officeState.ts` `getOfficeState()` — שכבת איסוף משותפת (משימות פר-חבר צוות + פרויקטים + תלויות), cache 3 דק', מקבילות 3. `oversight.ts` שוכתב לצרוך אותה. `src/ops/controlScan.ts` `runControlScan()` — ממצאים מסווגים `critical`/`high`/`normal` לכל חריגה: `stuck` (+חוסם → critical), `blocking_stale` (רק אם *גם* באיחור — במאגר המשימות כמעט הכל שרשור תלויות), `overdue_stale` (≥7 ימים/קריטי → high), `very_stale` (>45 ימים — לניקוי), `project_stuck`, `delivery_overdue`. כל ממצא נושא `who` להסלמה. `forManager` = critical+high בלבד. `GET /api/control` (דורש `view:all_work`). ה-overlay של מוטי מציג "בקרה יזומה" מעל טבלת העומס. `npm run test:control`. **ריצה אמיתית:** 54 ממצאים (1 critical, 21 high, 32 normal). **הושבתו ב-v1:** `no_owner` ו-`stage_gap` — `fetchUserOpsTasks` מסנן לפי אדם, אז משימות בלי אחראי לא נמשכות בכלל; דורש שאילתה ייעודית. **איטי:** סריקה קרה ~32ש' (בעיקר `getReverseDependencyMap` שסורק את כל בורד תת-המשימות). כשירוץ מתוזמן ב-7:00 זה יחמם cache למוטי.

- **שלב 4 — תזמון + הסלמה + תדריך בוקר (2026-09-03).** טבלאות SQLite חדשות: `control_findings` (ממצאים נשמרים בין סריקות עם `first_seen`/`escalation_level`), `notifications` (per-user, נראה בחלונית), `whatsapp_outbox` (הודעות שרק סוכן ה-WhatsApp שולח). `src/ops/escalation.ts` `runDailyControlCycle()`: סריקה → upsert ממצאים → מה שנעלם = resolved → הסלמה לפי ימי עבודה (א׳–ה׳): יום 1 תזכורת לעובד · יום 2 למנהל הפרויקט · יום 3/קריטי למוטי (critical מפעיל את כל הרמות מיד) → תדריך בוקר למוטי (כל ה-critical+high, מקובץ לפי אדם) כ-notification + `whatsapp_outbox`. `src/ops/scheduler.ts` `startScheduler()` — 07:00 `Asia/Jerusalem`, א׳–ה׳, רץ בתוך שרת החלונית. `src/integrations/whatsapp/outboxDrainer.ts` — סוכן ה-WhatsApp מרוקן את התור כל דקה (הודעות ישנות מ-12ש' נזרקות). Endpoints: `POST /api/control/run` (הרצה ידנית), `GET/POST /api/notifications`. באנר התראות בראש הצ'אט + "סמן הכל כנקרא". `resolveUsersByAssigneeText()` ב-identity ממפה "מוטי, דוב שפירא" → משתמשים. `npm run test:cycle`. **נבדק:** הממצא הקריטי (35 ימים, חוסם 2) הפעיל תזכורת לרוחמה + הסלמה לאיתן (מנהל הפרויקט) + למוטי; תדריך בתור ל-WhatsApp של מוטי. הרצה שנייה → 0 הסלמות חדשות (דה-דופ).

- **שלב 4 — בקרת CRM: לידים · עסקאות · גבייה (2026-09-06).** `src/integrations/monday/crmRead.ts` — `fetchOpenLeads` (בורד `1550734525`), `fetchOpenDeals` (`1550734529` = פייפליין המכירות), `fetchOpenCollections` (`1550734546` + תת-פריטי תשלומים `1550734569`). `src/ops/crmScan.ts` `runCrmScan()` (cache 5 דק') — הסיגנל המרכזי: `date__1` "תאריך הבא לתזכורת" שעבר. ממצאים: פולו-אפ ליד/עסקה באיחור · "הצעת מחיר בלי פולו-אפ" (שלב "נשלחה הצעת מחיר"/"ממתין להצעת מחיר") · ליד חדש שלא נלקח (5+ ימים) · ליד/עסקה בלי אחראי · תשלום באיחור (>30 ימים → critical) · גבייה מאחרת · תשלום בלי תאריך. ניתוב: לידים/עסקאות → אחראי או מוטי; גבייה → **גולדי**. מדלגים על סטטוסים "עבר לעסקה"/"הוקפא"/"מוקפא". `runDailyControlCycle` מריץ עכשיו את שתי הסריקות וממזג לפרסיסטנס/הסלמה/תדריך. `GET /api/crm` (דורש `view:all_work` או `view:finance` → מוטי + גולדי). ה-overlay של מוטי קיבל סקשן "מכירות וכספים" מקובץ לגבייה/מכירות/לידים; כפתור "בקרה" נחשף גם ל-`view:finance`. `npm run test:crm`. **ריצה אמיתית:** 26 ממצאים (0 critical, 19 high, 7 normal) — 4 תשלומים באיחור (15K×3 + 24.5K), ~15 עסקאות בלי פולו-אפ, 3 הצעות מחיר תלויות.

- **שלב 4 — תדריך בוקר מלא (2026-09-06, מטרה 17).** `briefingText()` ב-`escalation.ts` שוכתב למקוטע לפי מה שדורש תשומת לב ניהולית: **החלטות שמחכות לך** (עסקאות בשלב "משא ומתן"/"בדרך לסגירה"/"נשלחה הצעת מחיר" — מ-`crmScan.decisions`) · **פרויקטים בסיכון** (`project_stuck`/`delivery_overdue`) · **משימות דחופות ותקיעות** · **מכירות — פולו-אפ** · **גבייה** · **מועדים של היום** (משימות `flags.dueToday` + `crmScan.paymentsDueToday` + פגישות מ-`listCalendarEvents` של היום). כל סקשן חתוך ל-10 עם "…ועוד N". `crmScan` מחזיר עכשיו גם `decisions` ו-`paymentsDueToday`. אותו טקסט נכנס ל-notification של מוטי + `whatsapp_outbox`. נבדק `npm run test:cycle`: תדריך אמיתי עם 3 החלטות, 5 פרויקטים בסיכון, 16 משימות, 13 מכירות, 4 תשלומים, מועדי היום.

- **שלב 4 — שיחה חופשית למוטי מעל כל המשרד (2026-09-06, מטרה 16).** `runOpsChat` מוסיף כלי בקרה כשלמשתמש יש `view:all_work` (מוטי, יוכי): `office_overview` (תמונת מצב + top urgent + החלטות ממתינות) · `person_status {name}` (עומס + הכי-באיחור + ממצאים של אדם) · `project_status {query}` (סטטוס/אחראי/מסירה/פעולה נוכחית/דגלים) · `list_findings {area?, severity?}` (area: tasks/projects/sales/collection) · `sales_and_collection`. ה-system prompt מסביר למודל מתי להשתמש. הכל read-only מעל ה-caches הקיימים. נבדק בדפדפן: "מה תקוע במשרד?" → פירוט לפי אדם עם ימי איחור; "מה מצב הגבייה?" → 4 תשלומים באיחור ~78K ₪ אצל גולדי; "מה קורה אצל רוחמה?" → הספירות שלה.

- **שלב 4 — דוח שבועי (2026-09-06, מטרה 18).** `src/ops/weeklyReport.ts` `buildWeeklyReport()` — רטרוספקטיבה + מבט קדימה: הבקרה השבוע (ממצאים שנפתחו/נסגרו/כרוניים — מ-`control_findings` דרך `findingsOpenedSince`/`findingsResolvedSince`/`chronicFindings`) · מצב הצוות (snapshot מ-oversight) · פרויקטים (פעילים/בסיכון + מסירות בשבוע הקרוב) · מכירות (עסקאות/לידים פתוחים, נחתמו השבוע דרך `fetchSigningsSince`, לידים חדשים, פיזור שלבים) · גבייה (ממצאים + תשלומים צפויים) · צפי לשבוע הבא (משימות/תזכורות עם תאריך ב-7 ימים). `CrmScanReport` הורחב: `pipeline` / `paymentsDueSoon` / `remindersDueSoon`. `src/ops/scheduler.ts` שוכתב — `scheduleLoop()` גנרי; דוח שבועי יום א׳ 08:00. `POST /api/weekly/run`. notification kind "weekly" בבאנר. `npm run test:weekly`.

- **שלב 4 — התחייבויות + לקוחות שמחכים (2026-09-06, מטרות 7+8).** טבלת `commitments` (SQLite) + `src/db/repositories/commitments.ts`. כלי צ'אט לכל עובד: `record_commitment {toWhom, what, dueDate?, project?}` (העובד אומר "הבטחתי ל..." → נרשם, המודל מפרש תאריכים כמו "יום חמישי"), `list_my_commitments` ("מה הבטחתי?"), `close_commitment`. `controlScan` קיבל 2 kinds: `commitment_overdue` (התחייבות שעבר יעדה — who = מי שרשם) ו-`client_waiting` (שלב תקוע ב"ממתין ללקוח" 14+ ימים, או משימה מול-לקוח באיחור 3+ שהכדור אצל המשרד — regex `CLIENT_FACING` על שם המשימה). זורם דרך ההסלמה + התדריך (סקשן חדש "התחייבויות ולקוחות שמחכים") + הדוח השבועי. `GET /api/commitments` + סקשן ב-overlay של מוטי. `enqueueWhatsapp(jid, text, supersede=true)` לתדריך/דוח — מוחק הודעות ישנות שלא נשלחו. נבדק: דוב אמר "הבטחתי לרוזנטל..." → נרשם עם יעד 10/9; "מה הבטחתי?" → הוצג.

- **היסטוריית שיחות בשרת (2026-09-06).** טבלת `chat_messages` (SQLite) + `src/db/repositories/chatHistory.ts`. `POST /api/chat` שומר כל זוג הודעה+תשובה (`appendChatTurn`). ה-UI נגמל מ-localStorage: `state.thread` נטען מהשרת בכל פתיחה.

- **שיחות בדידות + טאב "היסטוריית שיחות" (2026-09-06).** `chat_messages` קיבל `session_id` (מיגרציית `ALTER TABLE` ב-`db.ts`). כל "שיחה חדשה" = `session_id` חדש (`newSessionId()` = `s<base36 timestamp>`). `chatHistory.ts`: `listSessions` (עד 50, כותרת = הודעת המשתמש הראשונה, ממויין לפי אחרונה), `getSessionMessages(userKey, sessionId)`, `latestSessionId`. `POST /api/chat` מקבל ומחזיר `session`; `GET /api/chat/sessions` (רשימה + `latest`), `GET /api/chat/session?id=`. ה-UI: כפתור "היסטוריית שיחות" פותח overlay עם שורות שיחה (כותרת · תאריך · מספר הודעות), קליק טוען את השיחה; בכניסה נטענת השיחה האחרונה; "שיחה חדשה" מאפס `state.session`+`state.thread` — **המסך מתנקה** ומוצג מסך הפתיחה. שיחות ישנות מלפני ה-session_id מקובצות כ-`legacy`. **לא ניתן לשחזר שיחות שנוהלו לפני ה-persistence** (היו רק ב-localStorage). נבדק בדפדפן.

- **שינוי אחראי/ת של פריט מהצ'אט (2026-09-06).** `src/integrations/monday/itemWrite.ts` — `detectPeopleColumn(itemId)` מזהה דינמית את עמודת ה-people של הפריט (טיפוס `people`, מעדיף כותרת "אחרא"/responsible) כי היא שונה בכל בורד; `setItemPeople()` כותב `change_column_value` עם `{personsAndTeams:[{id,kind:"person"}]}`. `src/ops/actions.ts` `reassignItem(user, itemId, person)` — הרשאה (`task:manage`|`lead:manage`|`project:manage` → owner/admin/מנהל פרויקט, לא planner/finance) → פתרון שם דרך ספר הצוות שלנו (`resolveUsersByAssigneeText` — מכיר "יוכי" בעברית) ואז דרך משתמשי Monday (`findUsersByName`), חד-משמעי בלבד → כתיבה + `addTaskNote` שמתעד מי ביצע. כלי צ'אט `reassign_item` (ממודר לאותן הרשאות) + שורת system prompt. עובד על ליד/עסקה/משימה/פרויקט/שלב. **נבדק אמיתי:** הליד `3208185896` ("יוכי גוטליב - דירה בק"ס") הועבר ממוטי ליוכי (עמודה `multiple_person__1`), נרשם Update.

**הבא:** (1) נגישות חיצונית — שרת ענן (מחכה לחשבון מוטי). (2) הרחבת הצ'אט — "מה הבא?" אחרי סיום שלב, יצירת משימות המשך. (3) לכוונן ספי הסלמה אחרי ~שבועיים. (4) מטרות פתוחות: 11 מכרזים (בורד עדיין לא קיים) · 19 זיכרון מובנה · 20 דפוסים. **אופטימיזציה:** לצמצם את `getReverseDependencyMap` (סריקה קרה ~32ש').
