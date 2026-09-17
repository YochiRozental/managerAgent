/**
 * בדיקות ל-create_task / create_lead (החלטת 2026-09-17: הסוכן בחלונית לא ידע ליצור פריטים
 * חדשים כי chat.ts היה עם רשימת כלים נפרדת מ-tools.ts, בלי create_monday_task/create_lead).
 *
 * כל side-effect שיכול לגעת ב-Monday מוזרק (fake) — הבדיקות האלה לעולם לא קוראות ל-Monday
 * האמיתי. ה-idempotency table (idempotent_creations) כן נוגעת ב-DB האמיתי בכוונה (SQLite מקומי
 * של האפליקציה עצמה — לא Monday, לא "נתוני production" של הלקוח) כדי להוכיח את זרימת ה-retry
 * מקצה לקצה, בדיוק כמו test-reply-defer.ts / test-loop.ts. כל מפתח idempotency כאן ייחודי
 * להרצה (מזוהה עם Date.now()) כדי שההרצה תהיה חוזרת ולא תתנגש בהרצות קודמות.
 *
 *   npm run test:task-creation
 */

import "dotenv/config";
import { resolveUserByKey } from "../src/identity/index.js";
import {
  createLeadAction,
  createTaskAction,
  type CreateTaskDeps,
  type CreateLeadDeps,
} from "../src/ops/actions.js";
import { canCreateLead, canCreateTask } from "../src/ops/chat.js";
import { LEAD_PRODUCT_OPTIONS, LEAD_SOURCE_OPTIONS } from "../src/integrations/monday/leads.js";
import type { ProjectMeta, ProjectStage } from "../src/integrations/monday/opsRead.js";
import type { MondayUser } from "../src/integrations/monday/users.js";
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

// ---------------------------------------------------------------------------
// Fixtures — פרויקטים/שלבים מזויפים, לא נוגעים ב-Monday האמיתי
// ---------------------------------------------------------------------------

const RUN_TAG = Date.now(); // ייחודיות בין הרצות — לא מתנגש עם idempotent_creations מהרצה קודמת

const DOV_ID = "62982081";
const EITAN_ID = "62981836";

// ownerIds = עמודת "אחראי/ת" בבורד הפרויקטים (1550734533) — מקור האמת ל"מנהל פרויקט" (CLAUDE.md
// §3). מגדל השרון/בלומינג/שלבים-כפולים בניהול דוב; בלומפילד בניהול איתן — ל-scope-check (סעיף 2).
const PROJECTS: ProjectMeta[] = [
  { itemId: "9001", name: "מגדל השרון", owner: "דוב שפירא", ownerIds: [DOV_ID], status: "בעבודה", groupTitle: "g" },
  { itemId: "9002", name: "בלומינג", owner: "דוב שפירא", ownerIds: [DOV_ID], status: "בעבודה", groupTitle: "g" },
  { itemId: "9003", name: "בלומפילד", owner: "איתן ברמן", ownerIds: [EITAN_ID], status: "בעבודה", groupTitle: "g" },
  {
    itemId: "9004",
    name: "פרויקט שלבים כפולים",
    owner: "דוב שפירא",
    ownerIds: [DOV_ID],
    status: "בעבודה",
    groupTitle: "g",
  },
];

// מגדל השרון: שלב 1 כבר הושלם, שלב 2 פתוח — הבדיקה האמיתית של findActiveStage (לא
// currentStageIndex לבד, שהיה מצביע בטעות על שלב 1 — זו בדיוק התקלה שתוקנה תוך כדי המימוש).
const STAGES_MIGDAL: ProjectStage[] = [
  {
    id: "8001",
    name: "שלב 1 - תכנון",
    subitems: [{ id: "7001", name: "סקיצה", status: "הושלם", assignees: "דוב שפירא", blockedBy: [] }],
  },
  {
    id: "8002",
    name: "שלב 2 - היתר",
    subitems: [{ id: "7002", name: "הגשת בקשה", status: "לביצוע", assignees: "", blockedBy: [] }],
  },
];

// שלבים כפולים בשם "שלב 3" — כל התאמה (מספרית וגם מחרוזתית) מחזירה שניים → עמימות.
const STAGES_DUPLICATE: ProjectStage[] = [
  { id: "8010", name: "שלב 3 - היתר", subitems: [{ id: "7010", name: "X", status: "לביצוע", assignees: "", blockedBy: [] }] },
  { id: "8011", name: "שלב 3 - תשלום", subitems: [{ id: "7011", name: "Y", status: "לביצוע", assignees: "", blockedBy: [] }] },
];

function fakeListProjects(): Promise<ProjectMeta[]> {
  return Promise.resolve(PROJECTS);
}
function fakeGetProjectStages(projectId: string): Promise<ProjectStage[]> {
  if (projectId === "9001") return Promise.resolve(STAGES_MIGDAL);
  if (projectId === "9004") return Promise.resolve(STAGES_DUPLICATE);
  return Promise.resolve([]);
}
function fakeFindUsersByNameEmpty(): Promise<MondayUser[]> {
  return Promise.resolve([]);
}

function freshTaskDeps(overrides: Partial<CreateTaskDeps> = {}): CreateTaskDeps {
  return {
    listProjects: fakeListProjects,
    getProjectStages: fakeGetProjectStages,
    findUsersByName: fakeFindUsersByNameEmpty,
    ...overrides,
  };
}

async function main() {
  const dov = resolveUserByKey("dov")!; // project_manager: task:create + task:manage
  const eitan = resolveUserByKey("eitan")!; // project_manager
  const ruchama = resolveUserByKey("ruchama")!; // planner: task:create בלבד, לא task:manage
  const goldi = resolveUserByKey("goldi")!; // finance: לא task:create/task:manage/lead:manage
  const moti = resolveUserByKey("moti")!; // owner: הכל

  // ---- 1. יצירת משימת משרד כללית (רוחמה, task:create בלבד, לעצמה) ----
  {
    const calls: unknown[] = [];
    const r = await createTaskAction(
      ruchama,
      { taskName: `בדיקה כללית ${RUN_TAG}`, dueDate: "2026-10-01" },
      freshTaskDeps({
        createGeneralTask: async (input) => {
          calls.push(input);
          return { id: "g1", name: input.name };
        },
      }),
    );
    check("משימת משרד: נוצרה בהצלחה", r.ok && r.source === "general" && !r.deduped);
    check("משימת משרד: personId = רוחמה עצמה", calls.length === 1 && (calls[0] as { personId: string }).personId === ruchama.mondayUserId);
  }

  // ---- 2. יצירת משימת פרויקט בשלב הנכון (דוב, פרויקט עם שלב 1 סגור + שלב 2 פתוח) ----
  {
    let capturedStageId: string | null = null;
    const r = await createTaskAction(
      dov,
      { taskName: `תכנית חשמל ${RUN_TAG}` , project: "מגדל השרון" },
      freshTaskDeps({
        createStageTask: async (input) => {
          capturedStageId = input.stageItemId;
          return { id: "s1", name: input.name };
        },
      }),
    );
    check("משימת פרויקט: נוצרה בהצלחה", r.ok && r.source === "project_stage");
    check(
      "משימת פרויקט: נבחר השלב הפעיל האמיתי (שלב 2, לא שלב 1 שכבר הושלם)",
      capturedStageId === "8002",
      `בפועל: ${capturedStageId}`,
    );
    check("משימת פרויקט: stageName מדווח נכון", r.stageName === "שלב 2 - היתר");
  }

  // ---- 3. פרויקט לא נמצא ----
  await expectRejects(
    "פרויקט לא נמצא → שגיאה ברורה",
    () => createTaskAction(dov, { taskName: "X", project: "פרויקט שלא קיים בכלל" }, freshTaskDeps()),
    "לא מצאתי פרויקט",
  );

  // ---- 4. כמה פרויקטים תואמים ----
  await expectRejects(
    "כמה פרויקטים תואמים ('בלומ') → שגיאת עמימות עם שתי האפשרויות",
    () => createTaskAction(dov, { taskName: "X", project: "בלומ" }, freshTaskDeps()),
    "מתאים לכמה פרויקטים",
  );

  // ---- 5. שלב עמום ----
  await expectRejects(
    "שלב עמום ('שלב 3' בפרויקט עם שני שלבים כאלה) → שגיאת עמימות",
    () =>
      createTaskAction(
        dov,
        { taskName: "X", project: "פרויקט שלבים כפולים", stage: "שלב 3" },
        freshTaskDeps(),
      ),
    "מתאים לכמה שלבים",
  );

  // ---- 6. עובד לא נמצא / עמום ----
  await expectRejects(
    "עובד לא נמצא → שגיאה ברורה",
    () => createTaskAction(dov, { taskName: "X", assignee: "מישהו שלא קיים בכלל" }, freshTaskDeps()),
    "לא מצאתי עובד",
  );
  await expectRejects(
    "עובד עמום ('דוב ואיתן' → שני אנשים מספר הצוות) → שגיאת עמימות",
    () => createTaskAction(moti, { taskName: "X", assignee: "דוב ואיתן" }, freshTaskDeps()),
    "מתאים לכמה אנשים",
  );

  // ---- 7. create_lead — הצלחה + ולידציית source/product ----
  {
    const created: unknown[] = [];
    const r = await createLeadAction(
      dov,
      {
        firstName: `לקוח בדיקה ${RUN_TAG}`,
        source: LEAD_SOURCE_OPTIONS[0],
        product: LEAD_PRODUCT_OPTIONS[0],
      },
      {
        createLead: async (input) => {
          created.push(input);
          return { id: "l1", name: input.firstName };
        },
      } satisfies CreateLeadDeps,
    );
    check("create_lead: נוצר בהצלחה", r.ok && !r.deduped);
    check(
      "create_lead: אחראי ברירת מחדל = היוצר",
      created.length === 1 && (created[0] as { assigneeId?: string }).assigneeId === dov.mondayUserId,
    );
  }
  await expectRejects(
    "create_lead: source לא חוקי נדחה",
    () =>
      createLeadAction(dov, { firstName: "X", source: "מקור שלא קיים" }, {
        createLead: async () => ({ id: "x", name: "x" }),
      }),
    "אינו מקור ליד חוקי",
  );

  // ---- 8. retry לא יוצר כפילות (idempotency) ----
  {
    let createCalls = 0;
    const deps = freshTaskDeps({
      createGeneralTask: async (input) => {
        createCalls++;
        return { id: "idem1", name: input.name };
      },
    });
    const input = { taskName: `אידמפוטנטיות ${RUN_TAG}`, dueDate: "2026-10-05" };
    const first = await createTaskAction(ruchama, input, deps);
    const second = await createTaskAction(ruchama, input, deps);
    check("idempotency: הקריאה הראשונה יצרה בפועל", first.ok && !first.deduped);
    check("idempotency: הקריאה השנייה זוהתה כ-retry (deduped)", second.ok && second.deduped);
    check("idempotency: אותו itemId בשתי הפעמים", first.itemId === second.itemId);
    check("idempotency: הפונקציה שיוצרת ב-Monday נקראה פעם אחת בלבד", createCalls === 1, `בפועל: ${createCalls}`);
  }

  // ---- 9. משתמש ללא הרשאת יצירה ----
  await expectRejects(
    "רוחמה (task:create בלבד) מנסה ליצור משימה *לדוב* → נדחה (צריך task:manage)",
    () => createTaskAction(ruchama, { taskName: "X", assignee: "דוב" }, freshTaskDeps()),
    "מישהו אחר",
  );
  await expectRejects(
    "גולדי (בלי lead:manage) מנסה ליצור ליד → נדחה",
    () => createLeadAction(goldi, { firstName: "X" }, {}),
    "הרשאה ליצור לידים",
  );

  // ---- 9ב. הקצאה לאדם אחר מפעילה התראה דרך המנגנון הקיים (לא ערוץ חדש) ----
  {
    let notifBody = "";
    let published = false;
    const r = await createTaskAction(
      dov,
      { taskName: `למישהו אחר ${RUN_TAG}`, assignee: "איתן" },
      freshTaskDeps({
        createGeneralTask: async (input) => ({ id: "other1", name: input.name }),
        addNotification: (userKey, kind, body) => {
          notifBody = body;
          return 1;
        },
        publishNotificationLive: () => {
          published = true;
        },
      }),
    );
    check("הקצאה לאחר: הצליחה", r.ok && r.assigneeName === eitan.name);
    check("הקצאה לאחר: נשלחה התראה דרך notifications+SSE הקיימים", notifBody.includes(r.itemName) && published);
  }

  // ---- 9ג. scope פר-פרויקט למנהל פרויקט (החלטה עסקית #2, 2026-09-17) ----
  {
    // דוב מנהל את "מגדל השרון" (ownerIds) → מותר לו להקצות שם משימה לאיתן.
    const r = await createTaskAction(
      dov,
      { taskName: `בתוך הפרויקט שלי ${RUN_TAG}`, project: "מגדל השרון", assignee: "איתן" },
      freshTaskDeps({ createStageTask: async (input) => ({ id: "scope1", name: input.name }) }),
    );
    check("מנהל הפרויקט (דוב) מקצה משימה לאחר *בתוך הפרויקט שלו* → מותר", r.ok);
  }
  await expectRejects(
    "איתן (לא מנהל את 'מגדל השרון') מנסה להקצות שם משימה לדוב → נדחה (scope)",
    () =>
      createTaskAction(
        eitan,
        { taskName: "X", project: "מגדל השרון", assignee: "דוב" },
        freshTaskDeps({ createStageTask: async (input) => ({ id: "scope2", name: input.name }) }),
      ),
    "לא מנהל/ת הפרויקט",
  );
  {
    // owner עוקף scope בכל פרויקט, גם כזה שהוא לא ownerIds שלו (מגדל השרון — בניהול דוב).
    const r = await createTaskAction(
      moti,
      { taskName: `owner בכל פרויקט ${RUN_TAG}`, project: "מגדל השרון", assignee: "איתן" },
      freshTaskDeps({ createStageTask: async (input) => ({ id: "scope3", name: input.name }) }),
    );
    check("owner (מוטי) מקצה משימה בפרויקט שהוא לא ה'אחראי' הרשום שלו → מותר (bypass)", r.ok);
  }
  {
    // יצירה *לעצמי* בתוך פרויקט שאני לא מנהל/ת — לא נכנסת ל-scope check בכלל (אין "לאדם אחר").
    const r = await createTaskAction(
      eitan,
      { taskName: `לעצמי בפרויקט של מישהו אחר ${RUN_TAG}`, project: "מגדל השרון" },
      freshTaskDeps({ createStageTask: async (input) => ({ id: "scope4", name: input.name }) }),
    );
    check("יצירה לעצמי בפרויקט שלא בניהולי → מותר (ה-scope חל רק על הקצאה לאחר)", r.ok);
  }

  // ---- 10. חשיפת הכלים בחלונית לפי הרשאה ----
  check("moti (owner) רואה create_task", canCreateTask(moti));
  check("moti (owner) רואה create_lead", canCreateLead(moti));
  check("דוב (project_manager) רואה create_task", canCreateTask(dov));
  check("דוב (project_manager) רואה create_lead", canCreateLead(dov));
  check("רוחמה (planner) רואה create_task (task:create)", canCreateTask(ruchama));
  check("רוחמה (planner) לא רואה create_lead (אין lead:manage)", !canCreateLead(ruchama));
  check("גולדי (finance) לא רואה create_task", !canCreateTask(goldi));
  check("גולדי (finance) לא רואה create_lead", !canCreateLead(goldi));

  logger.info(failed === 0 ? "\n✅ כל הבדיקות עברו" : `\n❌ ${failed} בדיקות נכשלו`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  logger.error({ err }, "test-task-creation נכשל עם שגיאה לא צפויה");
  process.exit(1);
});
