/**
 * בדיקות דטרמיניסטיות (בלי AI, בלי Monday אמיתי) ל-create_project_stage ולחיפוש הפרויקט המשותף
 * (matchProjectsByQuery) — פער production (2026-09-22): "תוסיף את המשימה בתור עוד שלב" לא היה
 * נתמך בכלל (create_task יודע רק ליצור task/subitem *תחת* שלב קיים, לא ליצור שלב חדש), וחיפוש
 * פרויקט לפי שם חלקי ("תחת גוטליב") לא מצא את "תכנית פרסום ושיווק גוטליב אדריכלים".
 *
 * matchProjectsByQuery עודכן לשכבות עדיפות (exact → contains → word-set → fuzzy שמרני), משותף
 * ל-create_task / create_project_stage / project_status — לא מנחש שם פרויקט, תמיד מתוך הרשימה
 * האמיתית שהתקבלה. ר' test-project-stage-behavior.ts לבדיקה חיה מול מודל אמיתי (multi-turn,
 * הבחנה בין task ל-stage, "הכוונה האחרונה גוברת").
 *
 * כל side-effect שיכול לגעת ב-Monday מוזרק (fake), בדיוק כמו test-task-creation.ts. idempotent_
 * creations כן נוגע ב-DB האמיתי (SQLite מקומי של האפליקציה, לא Monday) בכוונה, כדי להוכיח retry
 * מקצה לקצה — מפתח ייחודי לכל הרצה (RUN_TAG).
 *
 *   npm run test:project-stage
 */

import "dotenv/config";
import { resolveUserByKey } from "../src/identity/index.js";
import {
  createProjectStageAction,
  type CreateProjectStageActionDeps,
} from "../src/ops/actions.js";
import { canManageProjectStages } from "../src/ops/chat.js";
import { matchProjectsByQuery, type ProjectMeta, type ProjectStage } from "../src/integrations/monday/opsRead.js";
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

const RUN_TAG = Date.now();
const DOV_ID = "62982081";
const EITAN_ID = "62981836";

// ---------------------------------------------------------------------------
// שכבה 1: matchProjectsByQuery — שמות מבוססי מקרה production אמיתי (גוטליב), לא בדוי
// ---------------------------------------------------------------------------

const MATCH_PROJECTS: ProjectMeta[] = [
  { itemId: "5001", name: "תכנית פרסום ושיווק גוטליב אדריכלים", owner: "מוטי", ownerIds: [], status: "בעבודה", groupTitle: "g" },
  { itemId: "5002", name: "גוטליב יוחנן מגרש 396 המושבה", owner: "מוטי", ownerIds: [], status: "מוקפא", groupTitle: "g" },
  { itemId: "5003", name: "מגדל השרון", owner: "דוב שפירא", ownerIds: [DOV_ID], status: "בעבודה", groupTitle: "g" },
];

function testMatchProjectsByQuery() {
  logger.info("── matchProjectsByQuery: שכבות עדיפות ──");

  {
    const m = matchProjectsByQuery(MATCH_PROJECTS, "תכנית פרסום ושיווק גוטליב אדריכלים");
    check("exact: שם מלא זהה → התאמה חד-משמעית", m.length === 1 && m[0]!.itemId === "5001", JSON.stringify(m.map((p) => p.name)));
  }
  {
    // "גוטליב" לבדו באמת עמום בדאטה האמיתי (שני פרויקטים אמיתיים מכילים אותו) — 2+ התאמות
    // זו התנהגות נכונה (לא ניחוש), לא כשל.
    const m = matchProjectsByQuery(MATCH_PROJECTS, "גוטליב");
    check(
      "contains: 'גוטליב' לבדו עמום באמת (2 פרויקטים אמיתיים) → מחזיר את שניהם, לא בוחר לבד",
      m.length === 2 && m.some((p) => p.itemId === "5001") && m.some((p) => p.itemId === "5002"),
      JSON.stringify(m.map((p) => p.name)),
    );
  }
  {
    const m = matchProjectsByQuery(MATCH_PROJECTS, "שיווק גוטליב");
    check("contains: 'שיווק גוטליב' (תת-מחרוזת רציפה) → חד-משמעי לפרויקט השיווק בלבד", m.length === 1 && m[0]!.itemId === "5001", JSON.stringify(m.map((p) => p.name)));
  }
  {
    const m = matchProjectsByQuery(MATCH_PROJECTS, "תכנית פרסום");
    check("contains: פרפיקס תואם → חד-משמעי", m.length === 1 && m[0]!.itemId === "5001", JSON.stringify(m.map((p) => p.name)));
  }
  {
    // סדר מילים הפוך — לא substring רציף, אבל שתי המילים קיימות בשם (word-set tier)
    const m = matchProjectsByQuery(MATCH_PROJECTS, "גוטליב תכנית");
    check("word-set: מילים בסדר הפוך (לא substring רציף) → חד-משמעי דרך שכבת המילים", m.length === 1 && m[0]!.itemId === "5001", JSON.stringify(m.map((p) => p.name)));
  }
  {
    // שגיאת כתיב שמרנית — Levenshtein 1 בין "תוכנית"/"תכנית"
    const m = matchProjectsByQuery(MATCH_PROJECTS, "תוכנית פרסום");
    check("fuzzy: שגיאת כתיב שמרנית ('תוכנית' במקום 'תכנית') → עדיין נמצא דרך שכבת ה-fuzzy", m.length === 1 && m[0]!.itemId === "5001", JSON.stringify(m.map((p) => p.name)));
  }
  {
    const m = matchProjectsByQuery(MATCH_PROJECTS, "משהו שלא קיים בעליל בשום פרויקט");
    check("אין התאמה טובה → 0 תוצאות, לא ניחוש", m.length === 0, JSON.stringify(m.map((p) => p.name)));
  }
  {
    const m = matchProjectsByQuery(MATCH_PROJECTS, "");
    check("שאילתה ריקה → 0 תוצאות", m.length === 0);
  }
}

// ---------------------------------------------------------------------------
// שכבה 2: createProjectStageAction — הרשאות/scope/idempotency, ללא Monday אמיתי
// ---------------------------------------------------------------------------

const ACTION_PROJECTS: ProjectMeta[] = [
  { itemId: "9001", name: "מגדל השרון", owner: "דוב שפירא", ownerIds: [DOV_ID], status: "בעבודה", groupTitle: "g" },
  { itemId: "9002", name: "בלומינג", owner: "דוב שפירא", ownerIds: [DOV_ID], status: "בעבודה", groupTitle: "g" },
  { itemId: "9003", name: "בלומפילד", owner: "איתן ברמן", ownerIds: [EITAN_ID], status: "בעבודה", groupTitle: "g" },
];

function fakeListProjects(): Promise<ProjectMeta[]> {
  return Promise.resolve(ACTION_PROJECTS);
}
function fakeGetProjectStages(): Promise<ProjectStage[]> {
  return Promise.resolve([]); // פרויקט בלי שלבים קיימים — מקרה הקצה של יצירת השלב הראשון
}

function freshStageDeps(overrides: Partial<CreateProjectStageActionDeps> = {}): CreateProjectStageActionDeps {
  return {
    listProjects: fakeListProjects,
    getProjectStages: fakeGetProjectStages,
    ...overrides,
  };
}

async function main() {
  testMatchProjectsByQuery();

  const dov = resolveUserByKey("dov")!; // project_manager — מנהל את "מגדל השרון"
  const eitan = resolveUserByKey("eitan")!; // project_manager — מנהל את "בלומפילד", לא את "מגדל השרון"
  const ruchama = resolveUserByKey("ruchama")!; // planner — אין project:manage
  const goldi = resolveUserByKey("goldi")!; // finance — אין project:manage
  const moti = resolveUserByKey("moti")!; // owner

  logger.info("\n── createProjectStageAction ──");

  // ---- 1. מנהל הפרויקט יוצר שלב בפרויקט שהוא מנהל → מותר ----
  {
    const calls: unknown[] = [];
    const r = await createProjectStageAction(
      dov,
      { project: "מגדל השרון", stageName: `סוכות ${RUN_TAG}` },
      freshStageDeps({
        createProjectStage: async (input) => {
          calls.push(input);
          return { id: "st1", name: input.name };
        },
      }),
    );
    check("מנהל הפרויקט יוצר שלב בפרויקט שלו → מותר", r.ok && !r.deduped && r.project === "מגדל השרון");
    check(
      "הקלט שהועבר לכתיבה כולל projectId/projectName נכונים",
      calls.length === 1 && (calls[0] as { projectId: string }).projectId === "9001" && (calls[0] as { projectName: string }).projectName === "מגדל השרון",
    );
  }

  // ---- 2. מנהל פרויקט אחר (איתן, לא מנהל את "מגדל השרון") → נחסם (scope) ----
  await expectRejects(
    "איתן (לא מנהל את 'מגדל השרון') מנסה ליצור שם שלב → נדחה",
    () =>
      createProjectStageAction(
        eitan,
        { project: "מגדל השרון", stageName: "X" },
        freshStageDeps({ createProjectStage: async (input) => ({ id: "blocked1", name: input.name }) }),
      ),
    "לא מנהל/ת את הפרויקט",
  );

  // ---- 3. איתן כן מורשה בפרויקט שהוא כן מנהל ----
  {
    const r = await createProjectStageAction(
      eitan,
      { project: "בלומפילד", stageName: `שלב חדש ${RUN_TAG}` },
      freshStageDeps({ createProjectStage: async (input) => ({ id: "st2", name: input.name }) }),
    );
    check("איתן יוצר שלב בפרויקט שהוא כן מנהל ('בלומפילד') → מותר", r.ok);
  }

  // ---- 4. owner עוקף scope ----
  {
    const r = await createProjectStageAction(
      moti,
      { project: "מגדל השרון", stageName: `owner ${RUN_TAG}` },
      freshStageDeps({ createProjectStage: async (input) => ({ id: "st3", name: input.name }) }),
    );
    check("owner (מוטי) יוצר שלב בכל פרויקט, גם לא בניהולו → מותר (bypass)", r.ok);
  }

  // ---- 5. רוחמה (planner, אין project:manage) → נדחית ----
  await expectRejects(
    "רוחמה (planner, אין project:manage) מנסה ליצור שלב → נדחית",
    () =>
      createProjectStageAction(
        ruchama,
        { project: "מגדל השרון", stageName: "X" },
        freshStageDeps({ createProjectStage: async (input) => ({ id: "blocked2", name: input.name }) }),
      ),
    "אין לך הרשאה ליצור שלבים",
  );

  // ---- 6. גולדי (finance, אין project:manage) → נדחית ----
  await expectRejects(
    "גולדי (finance, אין project:manage) מנסה ליצור שלב → נדחית",
    () =>
      createProjectStageAction(
        goldi,
        { project: "מגדל השרון", stageName: "X" },
        freshStageDeps({ createProjectStage: async (input) => ({ id: "blocked3", name: input.name }) }),
      ),
    "אין לך הרשאה ליצור שלבים",
  );

  // ---- 7. פרויקט לא נמצא ----
  await expectRejects(
    "פרויקט לא נמצא → שגיאה ברורה",
    () => createProjectStageAction(dov, { project: "פרויקט שלא קיים בכלל", stageName: "X" }, freshStageDeps()),
    "לא מצאתי פרויקט",
  );

  // ---- 8. שם פרויקט עמום ----
  await expectRejects(
    "שם פרויקט עמום ('בלומ' מתאים גם לבלומינג וגם לבלומפילד) → שגיאת עמימות עם שתי האפשרויות",
    () => createProjectStageAction(dov, { project: "בלומ", stageName: "X" }, freshStageDeps()),
    "מתאים לכמה פרויקטים",
  );

  // ---- 9. חסר שם שלב ----
  await expectRejects(
    "חסר שם שלב → שגיאה ברורה",
    () => createProjectStageAction(dov, { project: "מגדל השרון", stageName: "   " }, freshStageDeps()),
    "חסר שם לשלב",
  );

  // ---- 10. חסר פרויקט ----
  await expectRejects(
    "חסר פרויקט → שגיאה ברורה",
    () => createProjectStageAction(dov, { project: "", stageName: "X" }, freshStageDeps()),
    "חסר שם הפרויקט",
  );

  // ---- 11. idempotency — retry לא יוצר כפילות ----
  {
    let createCalls = 0;
    const deps = freshStageDeps({
      createProjectStage: async (input) => {
        createCalls++;
        return { id: "idemStage1", name: input.name };
      },
    });
    const input = { project: "מגדל השרון", stageName: `אידמפוטנטיות שלב ${RUN_TAG}` };
    const first = await createProjectStageAction(dov, input, deps);
    const second = await createProjectStageAction(dov, input, deps);
    check("idempotency: הקריאה הראשונה יצרה בפועל", first.ok && !first.deduped);
    check("idempotency: הקריאה השנייה זוהתה כ-retry (deduped)", second.ok && second.deduped);
    check("idempotency: אותו itemId בשתי הפעמים", first.itemId === second.itemId);
    check("idempotency: הפונקציה שכותבת ל-Monday נקראה פעם אחת בלבד", createCalls === 1, `בפועל: ${createCalls}`);
  }

  // ---- 12. חשיפת הכלי בחלונית לפי הרשאה ----
  check("moti (owner) רואה create_project_stage", canManageProjectStages(moti));
  check("דוב (project_manager) רואה create_project_stage", canManageProjectStages(dov));
  check("רוחמה (planner) לא רואה create_project_stage", !canManageProjectStages(ruchama));
  check("גולדי (finance) לא רואה create_project_stage", !canManageProjectStages(goldi));

  logger.info(failed === 0 ? "\n✅ כל הבדיקות עברו" : `\n❌ ${failed} בדיקות נכשלו`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  logger.error({ err }, "test-project-stage נכשל עם שגיאה לא צפויה");
  process.exit(1);
});
