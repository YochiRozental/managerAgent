# בדיקות — Vitest

`npm test` מריץ **רק** את הקבצים ברשימה `SAFE_TESTS` ב-`vitest.config.ts`. בדיקה נכנסת לרשימה רק אחרי שאושרה כבטוחה. השמירה בתיקייה לא מכניסה אותה לרשימה אוטומטית.

| תיקייה | מה נכנס | רץ ב-`npm test`? |
|---|---|---|
| `unit/` | לוגיקה טהורה, בלי רשת ובלי מערכות חיצוניות | כן, אחרי אישור והוספה ל-`SAFE_TESTS` |
| `integration/` | כמה מודולים יחד. DB זמני בלבד, Monday/AI מדומים | רק אחרי אישור פרטני |
| `regression/` | הוכחה שהתנהגות קיימת לא השתנתה | רק אחרי אישור פרטני |
| `live/` | מול Monday אמיתי, AI בתשלום, Google | **אף פעם** (חסום ב-`exclude`) |
| `e2e/` | זרימה מלאה מול מערכות אמיתיות | **אף פעם** (חסום ב-`exclude`) |
| `fixtures/` | נתוני דוגמה לבדיקות | — |

## בידוד

`tests/setup/isolate.ts` רץ לפני כל קובץ ומפעיל שלוש שכבות. אם אחת מהן לא ניתנת להבטחה, ההרצה נכשלת.

1. **רשת** (`networkGuard.ts`): חסימה ברמת `net.Socket.connect`. היא מכסה http/https, tls, undici (`fetch` ו-`WebSocket` המובנים) ואת כל ה-SDKים: Anthropic, OpenAI, Monday (graphql-request), googleapis (gaxios). גם `localhost` חסום. קובץ שניסה לגשת לרשת **נכשל**, גם אם הקוד בלע את השגיאה. רק `isolation.test.ts` פטור, כי שם בודקים את החסימה עצמה.
2. **סודות** (`envIsolation.ts`): `.env` לא נטען (`DOTENV_CONFIG_PATH` מצביע לקובץ שלא קיים), וכל משתנה סביבה שנראה כמו סוד נדרס בערך דמה.
3. **DB** (`dbIsolationGuard.ts`): `AGENT_DB_PATH` מופנה ל-DB חדש בתיקיית temp, מחוץ לריפו. תחת Vitest בלי `AGENT_DB_PATH`, הקובץ `src/db/db.ts` זורק שגיאה ולא נופל בשקט ל-`data/agent.db`. בייצור ההתנהגות זהה לקודם.

`globalSetup.ts` יוצר תיקיית temp אחת לכל הרצה ומוחק אותה בסוף.

**לא מכוסה:** UDP (`dgram`), `child_process` (המקום היחיד שמשתמש בו הוא `whatsappInstrumentation`, ראו למטה), וקריאת קבצים מקומיים כמו `google-credentials.json` ו-`data/google-token.json`. הרשת חסומה, כך שגם אם הקבצים נקראים הם לא נשלחים לשום מקום.

## מה הועבר

כל הסקריפטים הישנים בטבלה **הוסרו**, וגם פקודות ה-`npm run test:<שם>` שלהם. הבדיקות שלהם רצות עכשיו ב-`npm test`.

| קובץ | מקור | בדיקות |
|---|---|---|
| `unit/policy.test.ts` | `scripts/test-policy.ts` | 24 |
| `unit/identity.test.ts` | `scripts/test-identity.ts` | 24 |
| `unit/modelRouter.test.ts` | `scripts/test-model-router.ts` | 18 |
| `unit/myWorkBrief.test.ts` | `scripts/test-mywork-brief.ts` | 59 |
| `unit/aiProviders.test.ts` | `scripts/test-ai-providers.ts` | 40 |
| `unit/attendanceEngine.test.ts` | `scripts/test-attendance-engine.ts` | 41 |
| `unit/employeeFeed.test.ts` | `scripts/test-employee-feed.ts` | 62 |
| `unit/sharedPrompt.test.ts` | `scripts/test-shared-prompt.ts` | 34 |
| `unit/toolRegistry.test.ts` | `scripts/test-tool-registry.ts` | 15 |
| `unit/sharedToolRegistry.test.ts` | `scripts/test-shared-tool-registry.ts` | 69 |
| `unit/sharedDispatcher.test.ts` | `scripts/test-shared-dispatcher.ts` | 92 |
| `unit/toolParity.test.ts` | `scripts/test-tool-parity.ts` | 44 (*) |
| `unit/createTaskPrompt.test.ts` | `scripts/test-create-task-prompt.ts` | 29 |
| `unit/projectScope.test.ts` | `scripts/test-project-scope.ts` | 10 |
| `unit/libsignalLogPatch.test.ts` | `scripts/test-libsignal-log-patch.ts` | 15 |
| `unit/whatsappSelfchatDiscriminator.test.ts` | `scripts/test-whatsapp-selfchat-discriminator.ts` | 5 |
| `unit/agentTools.test.ts` | `scripts/test-agent-tools.ts` (actions ו-Monday מוזרקים) | 140 |
| `unit/webSharedToolDefinition.test.ts` | `scripts/test-web-shared-tool-definition.ts` (רשימת הכלים המקומיים עודכנה, ראו למטה) | 219 |
| `unit/whatsappAgentTools.test.ts` | `scripts/test-whatsapp-agent-tools.ts` (בדיקת `createTask(` הוחלפה, ראו למטה) | 85 |
| `integration/loop.test.ts` | `scripts/test-loop.ts` (כותב ל-DB, ולכן integration) | 21 |
| `integration/approvals.test.ts` | `scripts/test-approvals.ts` | 39 |
| `integration/approvalConversation.test.ts` | `scripts/test-approval-conversation.ts` | 23 |
| `integration/cancellationApproval.test.ts` | `scripts/test-cancellation-approval.ts` | 33 |
| `integration/approvalsAudit.test.ts` | `scripts/test-approvals-audit.ts` (תרחיש 6 עודכן, ראו למטה) | 19 |
| `integration/attendance.test.ts` | `scripts/test-attendance.ts` | 73 |
| `integration/attendanceConcurrency.test.ts` | `scripts/test-attendance-concurrency.ts` | 13 |
| `integration/attendanceTools.test.ts` | `scripts/test-attendance-tools.ts` | 10 |
| `integration/attendanceMondaySync.test.ts` | `scripts/test-attendance-monday-sync.ts` (Monday מדומה בלבד) | 37 |
| `integration/deferralPlan.test.ts` | `scripts/test-deferral-plan.ts` | 15 |
| `integration/followups.test.ts` | `scripts/test-followups.ts` | 64 |
| `integration/followupScheduler.test.ts` | `scripts/test-followup-scheduler.ts` | 23 |
| `integration/initialOverdueNudge.test.ts` | `scripts/test-initial-overdue-nudge.ts` | 31 |
| `integration/escalationContext.test.ts` | `scripts/test-escalation-context.ts` | 16 |
| `integration/findingIdentityHealing.test.ts` | `scripts/test-finding-identity-healing.ts` | 13 |
| `integration/visibleForReports.test.ts` | `scripts/test-visible-for-reports.ts` | 7 |
| `integration/eodEngine.test.ts` | `scripts/test-eod-engine.ts` | 66 |
| `integration/eodSummary.test.ts` | `scripts/test-eod-summary.ts` (Monday מוזרק) | 50 |
| `integration/replyDefer.test.ts` | `scripts/test-reply-defer.ts` (3 בדיקות prompt עודכנו, ראו למטה) | 78 |
| `integration/projectStage.test.ts` | `scripts/test-project-stage.ts` (Monday מוזרק) | 27 |
| `integration/taskCreation.test.ts` | `scripts/test-task-creation.ts` (Monday מוזרק) | 42 |
| `integration/chatDedup.test.ts` | `scripts/test-chat-dedup.ts` | 20 |
| `integration/health.test.ts` | `scripts/test-health.ts` (גיבוי ב-cwd זמני, ראו למטה) | 18 |
| `integration/backfillEscalationIdentity.test.ts` | `scripts/test-backfill-escalation-identity.ts` (כלי התחזוקה עצמו נשאר) | 24 |
| `integration/whatsappLifecycle.test.ts` | `scripts/test-whatsapp-lifecycle.ts` (socket מדומה) | 22 |
| `integration/whatsappInstrumentation.test.ts` | `scripts/test-whatsapp-instrumentation.ts` (socket מדומה) | 24 |
| `integration/whatsappReplyLoop.test.ts` | `scripts/test-whatsapp-reply-loop.ts` (socket מדומה) | 23 |
| `integration/leadContact.test.ts` | `scripts/test-lead-contact.ts` (Monday מוזרק או מודבק זמנית) | 50 |
| `integration/attendancePilotReadiness.test.ts` | `scripts/test-attendance-pilot-readiness.ts` (Monday מדומה) | 23 |
| `regression/centralCore.test.ts` | `scripts/test-central-core-regression.ts` | 45 |

(*) `test-tool-parity` היה דוח ולא רשימת בדיקות. כל בדיקת עקביות בו (שם ב-`WIRED_AGENT_TOOL_NAMES` שחסר ב-registry, או שם שמופיע בשתי רשימות) וכל אחת מ-13 היכולות הפכו לבדיקה נפרדת. דוח "סטטוס המעבר", שהיה מידע בלבד ולא השפיע על הצלחה או כישלון, לא הועבר.

### מערכת האישורים: בידוד ותרחיש 6

- **בידוד:** ארבעת קובצי האישורים כותבים רק ל-DB הזמני של הקובץ. שני הסקריפטים הישנים פתחו "חיבור טרי" לנתיב קשיח `data/agent.db` כדי להוכיח persistence. ב-Vitest החיבור הזה נפתח ל-`isolatedDbPath()` (`tests/setup/dbIsolationGuard.ts`), שמאמת בידוד לפני שהוא מחזיר נתיב.
- **`approvalsAudit` תרחיש 6 (סוג אישור לא נתמך):** במקור התרחיש בדק `cancellation`, שהפך לנתמך ב-2026-09-20, ולכן הסקריפט הישן נכשל עליו. התרחיש עודכן (החלטה, שלב 4ג) ל-`reassignment`: סוג אישור תקף שנשמר ב-DB אבל אין לו executor ב-`KIND_EXECUTORS`. המטרה לא השתנתה: `unsupported_kind`, בלי claim, והאישור נשאר `pending`. הבדיקה גם הורחבה, והיא מוודאת שאף אחת משלוש פעולות Monday (`setTaskDueDate`, `updateTask`, `addTaskNote`) לא נקראה, ולא רק `setTaskDueDate` כמו במקור.

### מודול הנוכחות: בידוד

- **DB:** הסקריפטים הישנים ניקו לפני ואחרי ההרצה לפי `user_key` של משתמשים אמיתיים. `test-attendance`, `-concurrency` ו-`-monday-sync` מחקו את **כל** אירועי, ימי ותיקוני הנוכחות של `yochi` (ושל `dov` בשניים מהם) בלי סינון תאריך. `test-attendance-tools` מחק את הנוכחות של `yochi` בתאריך של היום. בנוסף, `runAttendanceReminderTick` ו-`recover*` פועלים על כל השורות ב-DB. מול ה-DB האמיתי זה היה פוגע בנתוני הפיילוט. ב-Vitest כל זה רץ רק על ה-DB הזמני של הקובץ.
- **Monday:** הסנכרון רץ רק מול `FakeMondayAttendanceClient` בזיכרון, ורשימת משתמשי הפיילוט מוזרקת. חסימת הרשת והכלל "ניסיון רשת = כישלון" מבטיחים שאין קריאה אמיתית.
- **הגדרות פיילוט:** ב-Vitest קובץ `.env` לא נטען, ולכן `ATTENDANCE_MODULE_ENABLED=false` ו-`ATTENDANCE_PILOT_USER_KEYS` ריק תמיד. בדיקות "הגנת-העומק" ב-`attendanceTools` (משתמש שאינו בפיילוט נדחה) דטרמיניסטיות, ולא תלויות בהגדרות הפיילוט במחשב שמריץ אותן.
- **שעון:** `attendance`, `-concurrency` ו-`-monday-sync` עובדים על תאריכים קבועים (2030/2032). `attendanceTools` עובד על התאריך האמיתי של היום, כי הכלים קוראים ל-`DateTime.now()` בעצמם.

### בקרה, מעקב ודוחות: בידוד

- **DB:** הכל רץ על ה-DB הזמני של הקובץ. שלוש פונקציות פועלות על **כל** השורות ב-DB ולא רק על שורות הבדיקה: `runInitialOverdueNudgePass` (שולחת פנייה לכל ממצא פעיל), `runDueFollowups` ו-`recover*`. מול ה-DB האמיתי, הסקריפטים הישנים היו שולחים פניות לעובדים אמיתיים. `followups` פתח "חיבור טרי" בנתיב קשיח `data/agent.db`, וב-Vitest הוא נפתח ל-`isolatedDbPath()`.
- **Monday:** כל קריאה ל-`runDueFollowups` מזריקה `getTaskStatusLabel`. ב-`eodSummary` מוזרקים `fetchCompletedToday`, `getOfficeState` וה-fetchers של `fetchCompletedToday`. `buildEndOfDaySummary` בולע שגיאות של שני אלה, ולכן הכלל "ניסיון רשת = כישלון" הוא שמבטיח שאין קריאה אמיתית שנבלעה בשקט.
- **timers:** `followupScheduler` מחליף זמנית את `globalThis.setInterval` כדי לבדוק את `startFollowupSchedule`/`stopFollowupSchedule`, ומחזיר אותו בסוף. אף timer אמיתי לא נשאר.
- **`replyDefer`, שלוש בדיקות ה-system prompt:** הסקריפט הישן חיפש את הנחיות "שינוי היקף עבודה" ב-`src/ops/chat.ts`, אבל הטקסט עבר ל-`src/ai/prompt.ts` (שלב 3F.1), ולכן הוא נכשל על הקוד הנוכחי. לפי החלטה (שלב 4ה), רק קובץ המקור שהבדיקות האלה קוראות עודכן ל-`prompt.ts`. התנאים עצמם לא השתנו. שתי הבדיקות של ה-schema וה-handler של `reply_defer` ממשיכות לבדוק את `chat.ts`.

### יצירת פריטים, צ'אט, יציבות ו-WhatsApp: בידוד

- **Monday:** ב-`projectStage` וב-`taskCreation` כל פעולת כתיבה (`createStageTask`, `createGeneralTask`, `createProjectStage`, `createLead`) וכל קריאה (`listProjects`, `getProjectStages`, `findUsersByName`) מוזרקות. טבלת `idempotent_creations` נכתבת רק ל-DB הזמני.
- **פעולות על כל ה-DB:** `recoverStuckChatMessageClaims` (`chatDedup`) מוחק **כל** שורת `processing` ב-`chat_message_dedup`. `runBackfill(true)` (`backfillEscalationIdentity`) מעדכן **כל** notification מסוג escalation שחסרה לה זהות. גם `drainOnce` (קובצי WhatsApp) מרוקן את **כל** התור ב-`whatsapp_outbox` ומסמן `sent_at`. מול ה-DB האמיתי כל אלה היו משנים נתוני אמת. ב-Vitest הם רצים רק על ה-DB הזמני של הקובץ. בגלל זה בדיקת ה-drainer ב-`whatsappLifecycle` תמיד רצה, כי התור הזמני ריק, ולא מדולגת כמו שקרה מול DB אמיתי עם הודעות ממתינות.
- **גיבוי (`health`):** `runDbBackup` כותב ל-`data/backups` *יחסית ל-cwd* ומוחק גיבויים מעבר ל-14. מה-cwd של הריפו זה היה דורס את גיבוי היום האמיתי. הקובץ עובר (`process.chdir`) לתיקיית ה-temp שלו לפני ההרצה, ונכשל מיד אם היעד בכל זאת נפתר לתוך הריפו.
- **WhatsApp:** אין חיבור אמיתי. ה-socket הוא אובייקט מדומה, ושום דבר לא נוגע ב-`auth/whatsapp`.
- **`child_process` (`whatsappInstrumentation`, סעיף 11):** הבדיקה מריצה פעמיים `tsx` בתהליך נפרד, שמייבא רק את `src/integrations/whatsapp/trace.ts` (`crypto` ו-logger) ומדפיס `processInstanceId`. התהליך יורש את ה-env המבודד, כלומר בלי `.env`, עם סודות דמה ועם `AGENT_DB_PATH` זמני. חסימת הרשת לא חלה עליו, אבל הקוד שהוא מריץ לא ניגש לרשת. קובץ ה-probe נוצר בתוך ה-temp של הקובץ ולא ב-`os.tmpdir`, כך שהוא נמחק בסוף ההרצה.

### כלי הסוכן, לידים ומוכנות הפיילוט: בידוד

- **`agentTools`:** כל action (`createTaskAction`, `updateTask`, `reassignItem` ועוד) מוזרק דרך `buildAgentTools`. ב-`reassignItem` מוזרקות גם `findUsersByName`, `detectPeopleColumn`, `setItemPeople` ו-`addTaskNote`. הבדיקות שמריצות את ה-execute האמיתי (דחיית הרשאה של גולדי) נעצרות ב-`authorize()` לפני כל קריאה ל-Monday. חסימת הרשת הייתה מכשילה את הקובץ אם לא.
- **`leadContact`:** `createLead`, `searchLeadRecords`, `getLeadRecordById` ו-`updateLeadContactColumns` מוזרקים. בסעיף 12 `mondayClient.request` מוחלף זמנית בפונקציה שתופסת את ה-payload, ומשוחזר ב-`finally`. טבלת `idempotent_creations` נכתבת רק ל-DB הזמני.
- **`attendancePilotReadiness`:** הסקריפט הישן מחק לפני ואחרי ההרצה את **כל** אירועי, ימי ותיקוני הנוכחות של `yochi`, בלי סינון תאריך. מול ה-DB האמיתי זה היה מוחק נתוני פיילוט. ב-Vitest זה רץ רק על ה-DB הזמני. Monday הוא `FakeMondayAttendanceClient` בזיכרון. בסיכום הכיסוי שהקובץ מדפיס עודכנו שמות הקבצים לקובצי ה-Vitest, כי הסקריפטים הישנים שהוא הפנה אליהם נמחקו. זה שינוי בטקסט בלבד, לא בבדיקה.

### שני שינויים מאושרים בבדיקות הכלים

- **`webSharedToolDefinition`, רשימת `WEB_CHAT_LOCAL_TOOL_NAMES`:** הבדיקה ציפתה ל-19 כלים מקומיים. `get_my_pipeline` נוסף כדין ב-2026-10-11 (commit `bc4f78e`): הכלי הוגדר ב-`runOpsChat` ונוסף לרשימה באותו commit. לפי החלטה (שלב 4ז), הוא נוסף לרשימה הצפויה. הבדיקה עדיין משווה את הרשימה **המדויקת**, כך שכלי שנוסף או הוסר בלי עדכון עדיין יכשיל אותה.
- **`whatsappAgentTools`, "אין קריאה ישירה ל-`createTask`":** תחת Vitest קריאה לפונקציה מיובאת נכתבת מחדש ל-`(0,__vite_ssr_import_N__.createTask)(`, ולכן `src.includes("createTask(")` המקורי לא היה תופס הפרה. הוא הוחלף ב-`callsDirectly(src, "createTask")` (`tests/helpers/sourceCalls.ts`), שתופס את הצורה הרגילה ואת הצורה של Vitest. שאר חלקי התנאי לא השתנו. `tests/unit/sourceCalls.test.ts` מוכיח שהבדיקה באמת נכשלת על הפרה, על פונקציות שעברו את אותה טרנספורמציה:
  - adapter שקורא ל-`createTask` ישירות או דרך namespace נתפס.
  - הכלי `create_monday_task` האמיתי (שקורא ל-`createTask` ישירות) נתפס.
  - אין false-positive על `createTaskAction` ועל שלושת ה-adapters התקינים.

### איך הועברו

רוב הסקריפטים בנויים כקוד רציף עם `check(label, cond, extra)` או `assert(cond, msg)`. בהעברה הם נשארו כמעט כפי שהם: אותם קלטים, אותם תנאים, אותן הודעות. רק העזר הוחלף ב-`tests/helpers/check.ts`, שרושם כל קריאה כ-`it` נפרד. הוסרו רק ספירת הכישלונות ו-`process.exit`, ונתיבי ה-import תוקנו.

## הסקריפטים הישנים שנשארו

בדיקות ה-Live נמצאות ב-`scripts/live/` (`npm run test:<שם>`), יחד עם טבלת הסיכונים של כל אחת ב-`scripts/live/README.md`. בדיקת ה-E2E נמצאת ב-`scripts/e2e-loop.ts`. חלקם נוגעים ב-`data/agent.db` המקומי, ב-Monday אמיתי או ב-AI, ולכן הם **לא** חלק מ-`npm test`.
