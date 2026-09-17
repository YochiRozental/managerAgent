/**
 * בדיקות ל-project scope על reassignItem/updateTask (החלטת יוכי 2026-09-24 — הרחבת ה-scope
 * שכבר יושם ב-create_task גם לפעולות ניהול קיימות). כל קריאה ל-Monday מוזרקת (fake) — הבדיקות
 * האלה לעולם לא קוראות ל-Monday האמיתי. הלוגיקה של *זיהוי* פרויקט (resolveItemProjectScope
 * מול stage/subitem/general-task/lead אמיתיים) נבדקת בנפרד, חי, ב-test-item-project-scope-live.ts
 * — כאן נבדקת רק ה*החלטה* (מותר/חסום) בהינתן תוצאת זיהוי נתונה.
 *
 *   npm run test:project-scope
 */

import "dotenv/config";
import { resolveUserByKey } from "../src/identity/index.js";
import {
  reassignItem,
  updateTask,
  type ReassignItemDeps,
  type ScopeDeps,
  type UpdateTaskDeps,
} from "../src/ops/actions.js";
import { BOARD_PROJECT_STAGE_TASKS } from "../src/integrations/monday/opsRead.js";
import type { PeopleColumnInfo } from "../src/integrations/monday/itemWrite.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
function check(label: string, cond: boolean, extra = "") {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
}

async function expectRejects(label: string, fn: () => Promise<unknown>, messageIncludes: string) {
  try {
    await fn();
    check(label, false, "לא זרק שגיאה בכלל");
  } catch (err) {
    const msg = (err as Error).message;
    check(label, msg.includes(messageIncludes), `הודעה בפועל: "${msg}"`);
  }
}

const DOV_ID = "62982081";
const EITAN_ID = "62981836";
const LEADS_BOARD = "1550734525"; // לא בין BOARDS_WITH_MANDATORY_PROJECT

/** תוצאת resolveItemProjectScope מזויפת — פריט על בורד תת-המשימות, שייך לפרויקט "9001". */
function fakeStageTaskScope(projectId: string | null = "9001") {
  return async () => ({ boardId: BOARD_PROJECT_STAGE_TASKS, projectId });
}

async function main() {
  const dov = resolveUserByKey("dov")!; // project_manager: task:manage, lead:manage, project:manage
  const ruchama = resolveUserByKey("ruchama")!; // planner: task:update_own + task:create, לא task:manage
  const moti = resolveUserByKey("moti")!; // owner

  // ---- 1+2. updateTask — מנהל פרויקט משנה משימה של עובד אחר ----
  {
    const setStatusCalls: unknown[] = [];
    const deps: UpdateTaskDeps = {
      isOwnItem: async () => false, // לא המשימה של דוב עצמו
      resolveItemProjectScope: fakeStageTaskScope("9001"),
      getProjectOwnerIds: async () => [DOV_ID], // דוב כן מנהל את הפרויקט
      setTaskStatus: async (...a) => {
        setStatusCalls.push(a);
      },
    };
    const r = await updateTask(dov, { action: "done", source: "project_stage", itemId: "1" }, deps);
    check("updateTask: מנהל משנה משימה של עובד אחר *בפרויקט שלו* → מותר", r.ok && setStatusCalls.length === 1);
  }
  await expectRejects(
    "updateTask: מנהל משנה משימה של עובד אחר *בפרויקט שאינו שלו* → חסום",
    () =>
      updateTask(
        dov,
        { action: "done", source: "project_stage", itemId: "1" },
        {
          isOwnItem: async () => false,
          resolveItemProjectScope: fakeStageTaskScope("9001"),
          getProjectOwnerIds: async () => [EITAN_ID], // איתן מנהל, לא דוב
        },
      ),
    "לא מנהל/ת את הפרויקט",
  );

  // ---- 3+4. reassignItem — מנהל פרויקט מקצה מחדש משימה ----
  const fakePeopleColumn: PeopleColumnInfo = {
    boardId: BOARD_PROJECT_STAGE_TASKS,
    columnId: "person",
    columnTitle: "אחראי/ת",
    currentIds: [DOV_ID],
    itemName: "משימת בדיקה",
  };
  {
    const setPeopleCalls: unknown[] = [];
    const deps: ReassignItemDeps = {
      resolveItemProjectScope: fakeStageTaskScope("9001"),
      getProjectOwnerIds: async () => [DOV_ID],
      detectPeopleColumn: async () => fakePeopleColumn,
      setItemPeople: async (...a) => {
        setPeopleCalls.push(a);
      },
      addTaskNote: async () => {},
    };
    const r = await reassignItem(dov, "1", "איתן", deps);
    check("reassignItem: מנהל מקצה מחדש משימה *בפרויקט שלו* → מותר", r.ok && setPeopleCalls.length === 1);
  }
  await expectRejects(
    "reassignItem: מנהל מקצה מחדש משימה *בפרויקט שאינו שלו* → חסום",
    () =>
      reassignItem(dov, "1", "איתן", {
        resolveItemProjectScope: fakeStageTaskScope("9001"),
        getProjectOwnerIds: async () => [EITAN_ID],
        detectPeopleColumn: async () => fakePeopleColumn,
      }),
    "לא מנהל/ת את הפרויקט",
  );

  // ---- 5. עובד מעדכן משימה שמוקצית לו, בפרויקט שאינו מנהל → מותר, וללא נגיעה ב-scope בכלל ----
  {
    let scopeChecked = false;
    const deps: UpdateTaskDeps = {
      isOwnItem: async () => true, // המשימה של רוחמה עצמה
      resolveItemProjectScope: async () => {
        scopeChecked = true;
        return { boardId: BOARD_PROJECT_STAGE_TASKS, projectId: "9001" };
      },
      getProjectOwnerIds: async () => {
        scopeChecked = true;
        return [];
      },
      setTaskStatus: async () => {},
    };
    const r = await updateTask(ruchama, { action: "done", source: "project_stage", itemId: "1" }, deps);
    check(
      "updateTask: עובד/ת מעדכן/ת משימה שמוקצית לו בפרויקט שאינו מנהל → מותר, ובלי לבדוק scope בכלל",
      r.ok && !scopeChecked,
    );
  }

  // ---- 6. Owner/Admin — מותר בכל הפרויקטים, וללא בדיקת scope (בייפאס לפני שהיא בכלל נקראת) ----
  {
    let scopeChecked = false;
    const deps: UpdateTaskDeps = {
      isOwnItem: async () => false,
      resolveItemProjectScope: async () => {
        scopeChecked = true;
        return { boardId: BOARD_PROJECT_STAGE_TASKS, projectId: "9999" };
      },
      getProjectOwnerIds: async () => {
        scopeChecked = true;
        return []; // מוטי לא ברשימה — ובכל זאת אמור לעבור, כי owner עוקף
      },
      setTaskStatus: async () => {},
    };
    const r = await updateTask(moti, { action: "done", source: "project_stage", itemId: "1" }, deps);
    check("updateTask: owner (מוטי) מותר בכל פרויקט, בלי לבדוק scope בכלל (bypass מוקדם)", r.ok && !scopeChecked);
  }
  {
    const deps: ReassignItemDeps = {
      resolveItemProjectScope: fakeStageTaskScope("9999"),
      getProjectOwnerIds: async () => [],
      detectPeopleColumn: async () => fakePeopleColumn,
      setItemPeople: async () => {},
      addTaskNote: async () => {},
    };
    const r = await reassignItem(moti, "1", "דוב", deps);
    check("reassignItem: owner (מוטי) מותר בכל פרויקט", r.ok);
  }

  // ---- 7. ליד/עסקה אינם נחסמים בגלל project scope ----
  {
    const deps: ReassignItemDeps = {
      resolveItemProjectScope: async () => ({ boardId: LEADS_BOARD, projectId: null }),
      detectPeopleColumn: async () => ({ ...fakePeopleColumn, boardId: LEADS_BOARD }),
      setItemPeople: async () => {},
      addTaskNote: async () => {},
    };
    const r = await reassignItem(dov, "1", "איתן", deps); // דוב לא "מנהל" שום פרויקט כאן — לא רלוונטי
    check("reassignItem: ליד (projectId=null, בורד בלי מושג פרויקט) → לא נחסם ע\"י scope", r.ok);
  }

  // ---- 8. "אל תעקוף בשקט" — בורד שחובה בו פרויקט, אבל לא זוהה אחד בפועל → חסום, לא מותר ----
  await expectRejects(
    "updateTask: subitem בלי פרויקט מזוהה (דאטה חריגה) → חסום, לא עוקף בשקט",
    () =>
      updateTask(
        dov,
        { action: "done", source: "project_stage", itemId: "1" },
        { isOwnItem: async () => false, resolveItemProjectScope: fakeStageTaskScope(null) },
      ),
    "לא הצלחתי לזהות את הפרויקט",
  );
  await expectRejects(
    "updateTask: פריט שלא נמצא בכלל (resolveItemProjectScope=null) → חסום",
    () =>
      updateTask(
        dov,
        { action: "done", source: "project_stage", itemId: "1" },
        { isOwnItem: async () => false, resolveItemProjectScope: async () => null },
      ),
    "לא הצלחתי לזהות את הפריט",
  );

  logger.info(failed === 0 ? "\n✅ כל הבדיקות עברו" : `\n❌ ${failed} בדיקות נכשלו`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  logger.error({ err }, "test-project-scope נכשל עם שגיאה לא צפויה");
  process.exit(1);
});
