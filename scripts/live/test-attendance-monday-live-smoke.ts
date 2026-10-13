/**
 * בדיקת אינטגרציה מבוקרת **אחת** מול Monday האמיתי — מאושרת במפורש, scope מצומצם:
 *   Board 1805215192 (יוכי) · Group group_mm81673r ("דיווחי נוכחות יומיים (סוכן)") בלבד.
 *
 * אינה נוגעת ב-attendance_events/attendance_days המקומיים בכלל — ה"יום" הנבדק נבנה בזיכרון
 * בלבד (לא נקרא מה-DB, לא נכתב ל-DB), כדי שלא תיווצר שום רשומת נוכחות אמיתית מקומית. תאריך
 * פיקטיבי (1999-01-01, הרבה לפני שהמערכת הזו קיימת) מבטיח אפס סיכוי התנגשות עם דיווח אמיתי.
 * שם הפריט נקבע במפורש ("בדיקת סנכרון — לא לשכר") דרך itemNameOverride — לא נגיעה ידנית ב-Monday
 * מחוץ למנגנון (syncAttendanceDayToMonday/MondayAttendanceClient האמיתיים, לא קוד אד-הוק).
 *
 * **לא קוראת ל-runAttendanceMondaySync (ה-job המתוזמן)** — רק syncAttendanceDayToMonday הבודדת,
 * כנדרש. לא מוחקת את פריט הבדיקה בסוף (אישור נוסף נדרש למחיקה).
 *
 *   npx tsx scripts/live/test-attendance-monday-live-smoke.ts
 *
 * מריצים רק באישור מפורש ומודעים — זו הפעלה אמיתית מול Monday live, לא בדיקה אוטומטית שרצה
 * כחלק מ-regression. אסור להוסיף לרשימת npm run test:* השוטפת.
 */

import "dotenv/config";
import { logger } from "../../src/utils/logger.js";
import { getAttendanceBoardId, buildAttendanceSyncId, ATTENDANCE_GROUP_TITLE } from "../../src/integrations/monday/attendanceBoards.js";
import { createRealMondayAttendanceClient } from "../../src/integrations/monday/attendanceMondayClient.js";
import { syncAttendanceDayToMonday } from "../../src/ops/attendanceMondaySync.js";
import type { StoredAttendanceDay } from "../../src/db/repositories/attendanceDays.js";
import { mondayRequest } from "../../src/integrations/monday/client.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const USER_KEY = "yochi";
const BOARD_ID = getAttendanceBoardId(USER_KEY)!;
const TEST_WORK_DATE = "1999-01-01"; // פיקטיבי בכוונה — לפני שהמערכת קיימת, אפס סיכון התנגשות
const TEST_SYNC_ID = buildAttendanceSyncId(USER_KEY, TEST_WORK_DATE);
const TEST_ITEM_NAME = "בדיקת סנכרון — לא לשכר";

function fakeDay(overrides: Partial<StoredAttendanceDay> = {}): StoredAttendanceDay {
  return {
    userKey: USER_KEY,
    workDate: TEST_WORK_DATE,
    status: "closed",
    openedReportedAt: `${TEST_WORK_DATE}T07:00:00.000Z`, // 09:00 מקומי (UTC+2 בינואר)
    closedReportedAt: `${TEST_WORK_DATE}T15:00:00.000Z`, // 17:00 מקומי
    netMinutes: 450, // 7.5 שעות
    breakMinutes: 30,
    segmentCount: 1,
    reminderStatus: "none",
    reminderSentAt: null,
    mondaySyncStatus: "pending",
    mondaySyncRef: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface RawItemSnapshot {
  id: string;
  updated_at: string;
  column_values: Record<string, { text: string | null }>;
}

/** שורה אחת — קריאה גולמית, להשוואת שימור (היסטוריה/אוטומציות) ולאימות ערכי הבדיקה עצמה. */
async function fetchBoardSnapshot(): Promise<{
  items: { id: string; name: string; group: string; time_tracking: string | null; date0: string | null; text: string | null }[];
}> {
  const res = await mondayRequest<{
    boards: {
      items_page: {
        items: {
          id: string;
          name: string;
          group: { id: string; title: string };
          column_values: { id: string; text: string | null }[];
        }[];
      };
    }[];
  }>(
    `query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 50) {
          items { id name group { id title } column_values { id text } }
        }
      }
    }`,
    { boardId: BOARD_ID },
  );
  const items = res.boards[0]?.items_page.items ?? [];
  return {
    items: items.map((it) => ({
      id: it.id,
      name: it.name,
      group: it.group.title,
      time_tracking: it.column_values.find((c) => c.id === "time_tracking__1")?.text ?? null,
      date0: it.column_values.find((c) => c.id === "date0__1")?.text ?? null,
      text: it.column_values.find((c) => c.id === "text__1")?.text ?? null,
    })),
  };
}

async function run() {
  logger.info(`── בדיקת אינטגרציה מבוקרת — board=${BOARD_ID}, syncId=${TEST_SYNC_ID} ──`);

  // ── לפני: תמונת מצב (לאימות שימור בסוף) ──────────────────────────────────────────────────
  const before = await fetchBoardSnapshot();
  const historicalBefore = before.items.filter((i) => i.group !== ATTENDANCE_GROUP_TITLE);
  check("0. לפני השינוי: 3 פריטים היסטוריים (כצפוי)", historicalBefore.length === 3, String(historicalBefore.length));
  check("0b. אין עדיין פריט בדיקה בקבוצה החדשה (ריצה נקייה)", !before.items.some((i) => i.group === ATTENDANCE_GROUP_TITLE));

  const client = createRealMondayAttendanceClient();

  // ── שלב 3: יצירה דרך המנגנון ──────────────────────────────────────────────────────────────
  const createResult = await syncAttendanceDayToMonday(USER_KEY, fakeDay({ mondaySyncRef: null }), client, TEST_ITEM_NAME);
  check("3a. פעולה = created", createResult.action === "created", createResult.action);
  check("3b. יש itemId", !!createResult.itemId);
  const itemId = createResult.itemId!;

  // ── שלב 4: סנכרון חוזר, *בלי* ref מקומי (מדמה "אבד") — חובה למצוא את הקיים, לא ליצור שני ──
  const rerunResult = await syncAttendanceDayToMonday(USER_KEY, fakeDay({ mondaySyncRef: null }), client, TEST_ITEM_NAME);
  check("4a. פעולה שנייה = adopted_existing (לא created שני)", rerunResult.action === "adopted_existing", rerunResult.action);
  check("4b. אותו itemId בדיוק", rerunResult.itemId === itemId, `${rerunResult.itemId} vs ${itemId}`);

  const afterRerun = await fetchBoardSnapshot();
  const testItemsAfterRerun = afterRerun.items.filter((i) => i.group === ATTENDANCE_GROUP_TITLE);
  check("4c. פריט בדיקה *בודד* בקבוצה (אין כפילות)", testItemsAfterRerun.length === 1, String(testItemsAfterRerun.length));

  // ── שלב 5: שינוי שעות נטו (7.5→6.25), עם ref ידוע — צריך לעדכן את *אותו* פריט ──────────────
  const updateResult = await syncAttendanceDayToMonday(
    USER_KEY,
    fakeDay({ mondaySyncRef: itemId, netMinutes: 375, breakMinutes: 45 }), // 6.25h, 45min break
    client,
    TEST_ITEM_NAME,
  );
  check("5a. פעולה = updated", updateResult.action === "updated", updateResult.action);
  check("5b. אותו itemId (לא נוצר פריט שלישי)", updateResult.itemId === itemId);

  // ── שלב 6: קריאה חוזרת — אימות שכל הערכים תואמים למה שנשלח בפועל ───────────────────────────
  const finalRead = await mondayRequest<{
    items: { id: string; name: string; column_values: { id: string; text: string | null }[] }[];
  }>(
    `query ($id: [ID!]) { items(ids: $id) { id name column_values { id text } } }`,
    { id: [itemId] },
  );
  const item = finalRead.items[0];
  const colByTitle = (id: string) => item?.column_values.find((c) => c.id === id)?.text ?? null;
  check("6a. הפריט נמצא בקריאה חוזרת", !!item);
  check("6b. שם הפריט תואם", item?.name === TEST_ITEM_NAME, item?.name);
  check("6c. תאריך עבודה = 1999-01-01", colByTitle("date_mm819w1j") === "1999-01-01", colByTitle("date_mm819w1j") ?? "null");
  // כניסה ראשונה/יציאה אחרונה — מאמת את תיקון אזור-הזמן (toLocalHourMinute): 07:00Z/15:00Z ב-ינואר
  // (בלי שעון קיץ) = 09:00/17:00 ב-Asia/Jerusalem (UTC+2), לא השעה הגולמית ב-UTC ולא לפי אזור-הזמן
  // של המכונה שמריצה את הסקריפט.
  // הערה: עמודת hour של Monday מחזירה את ה-text בפורמט 12 שעות (AM/PM), לא 24 שעות — זה פורמט
  // התצוגה של Monday עצמו, לא קשור לתיקון אזור-הזמן. 09:00 AM / 05:00 PM = 09:00/17:00 מקומי, בדיוק הצפוי.
  check("6c2. כניסה ראשונה = 09:00 AM (לא 07:00 UTC גולמי)", colByTitle("hour_mm818zx7") === "09:00 AM", colByTitle("hour_mm818zx7") ?? "null");
  check("6c3. יציאה אחרונה = 05:00 PM (לא 15:00 UTC גולמי)", colByTitle("hour_mm8123kb") === "05:00 PM", colByTitle("hour_mm8123kb") ?? "null");
  check("6d. דקות הפסקה = 45 (הערך המעודכן, לא 30 המקורי)", colByTitle("numeric_mm8113dp") === "45", colByTitle("numeric_mm8113dp") ?? "null");
  check("6e. שעות נטו = 6.25 (הערך המעודכן, לא 7.5 המקורי)", colByTitle("numeric_mm81gjzw") === "6.25", colByTitle("numeric_mm81gjzw") ?? "null");
  check("6f. מספר מקטעים = 1", colByTitle("numeric_mm817q0k") === "1", colByTitle("numeric_mm817q0k") ?? "null");
  check("6g. סטטוס דיווח = סגור", colByTitle("color_mm81bmng") === "סגור", colByTitle("color_mm81bmng") ?? "null");
  check("6h. מקור דיווח = סוכן", colByTitle("dropdown_mm8156ab") === "סוכן", colByTitle("dropdown_mm8156ab") ?? "null");
  check("6i. מזהה סנכרון = " + TEST_SYNC_ID, colByTitle("text_mm811v67") === TEST_SYNC_ID, colByTitle("text_mm811v67") ?? "null");

  // ── שלב 7: שימור — פריטים היסטוריים/אוטומציות/שאר הלוח לא השתנו ────────────────────────────
  const after = await fetchBoardSnapshot();
  const historicalAfter = after.items.filter((i) => i.group !== ATTENDANCE_GROUP_TITLE);
  check("7a. עדיין 3 פריטים היסטוריים, זהים", historicalAfter.length === 3);
  for (const h of historicalBefore) {
    const match = historicalAfter.find((x) => x.id === h.id);
    check(
      `7b. פריט היסטורי ${h.id} (${h.name}) — time_tracking/date0/text זהים`,
      !!match && match.time_tracking === h.time_tracking && match.date0 === h.date0 && match.text === h.text,
      JSON.stringify({ before: h, after: match }),
    );
  }
  const testItemsFinal = after.items.filter((i) => i.group === ATTENDANCE_GROUP_TITLE);
  check("7c. עדיין רק פריט בדיקה אחד בקבוצה (סה״כ 4 פריטים בלוח)", testItemsFinal.length === 1 && after.items.length === 4);

  logger.info(`\nסיכום: itemId=${itemId}, syncId=${TEST_SYNC_ID}, שם="${TEST_ITEM_NAME}". לא נמחק — ממתין לאישור נוסף.`);
}

run()
  .then(() => {
    if (failed > 0) {
      logger.error(`${failed} בדיקות נכשלו`);
      process.exit(1);
    }
    logger.info("כל הבדיקות עברו ✅");
  })
  .catch((err) => {
    logger.error({ err }, "בדיקה קרסה");
    process.exit(1);
  });
