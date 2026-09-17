/**
 * פעולות עדכון מהחלונית (שלב 2). כל פעולה עוברת: הרשאה → בעלות על המשימה → כתיבה ל-Monday.
 *
 * מותר: סימון בוצע / שינוי סטטוס / הערה / דיווח חסם. אלו עדכונים תפעוליים פנימיים שהסוכן עושה
 * לבד. מחיקה / לקוח / כסף — לא כאן.
 */

import { resolveUsersByAssigneeText, TEAM_DIRECTORY, userCan, type IdentifiedUser } from "../identity/index.js";
import {
  BOARDS_WITH_MANDATORY_PROJECT,
  currentStageIndex,
  fetchActiveProjects,
  findActiveStage,
  getProjectOwnerIds,
  getProjectStages,
  matchProjectsByQuery,
  matchStagesByQuery,
  resolveItemProjectScope,
  type OpsTaskSource,
  type ProjectMeta,
  type ProjectStage,
} from "../integrations/monday/opsRead.js";
import {
  addTaskNote,
  assertUserOwnsItem,
  createGeneralTask,
  createStageTask,
  DONE_LABEL,
  setTaskStatus,
  type CreateGeneralTaskInput,
  type CreateStageTaskInput,
} from "../integrations/monday/opsWrite.js";
import { detectPeopleColumn, setItemPeople, type PeopleColumnInfo } from "../integrations/monday/itemWrite.js";
import { findUsersByName, type MondayUser } from "../integrations/monday/users.js";
import {
  createLead as createLeadMonday,
  LEAD_PRODUCT_OPTIONS,
  LEAD_SOURCE_OPTIONS,
  type CreateLeadInput,
} from "../integrations/monday/leads.js";
import { getCachedCreation, recordCreation } from "../db/repositories/idempotentCreations.js";
import { addNotification } from "../db/repositories/notifications.js";
import { publishNotificationLive } from "./notificationBus.js";

/**
 * side-effects הניתנים להזרקה לבדיקת scope/בעלות — בלי לגעת ב-Monday האמיתי (אותו pattern
 * כמו ReplyDeferDeps ב-loopReply.ts). ברירת המחדל תמיד הפונקציה האמיתית.
 */
export interface ScopeDeps {
  isOwnItem?: (itemId: string, mondayUserId: string) => Promise<boolean>;
  resolveItemProjectScope?: typeof resolveItemProjectScope;
  getProjectOwnerIds?: typeof getProjectOwnerIds;
}

/** גרסה לא-זורקת של assertUserOwnsItem — כדי לענף לוגיקה לפי "האם זו המשימה של המשתמש עצמו". */
async function isOwnItem(itemId: string, mondayUserId: string): Promise<boolean> {
  try {
    await assertUserOwnsItem(itemId, mondayUserId);
    return true;
  } catch {
    return false;
  }
}

/**
 * מנהל/ת את הפרויקט שהפריט (מכל סוג — משימה/שלב/פרויקט/משימת משרד מקושרת) שייך אליו —
 * owner/admin תמיד (בקרה־על כל המשרד); כל תפקיד אחר רק אם מזהה ה-Monday שלו מופיע ב"אחראי/ת"
 * של הפרויקט עצמו (getProjectOwnerIds — אותו מקור אמת בדיוק כמו managesProject ב-create_task).
 *
 * "אל תאפשר לעקוף בשקט" (החלטת יוכי, סעיף 5): פריט על בורד שבו *לכל* פריט חייב להיות פרויקט
 * (project/stage/subitem) אבל לא הצלחנו לזהות אחד בפועל → נחסם, לא מנחשים ולא מרשים. רק פריט
 * בלי מושג "פרויקט" בכלל (ליד/עסקה/משימת משרד שלא קושרה לשום פרויקט) עובר בלי בדיקה — אין שם
 * מה לאכוף.
 */
async function assertManagesItemProject(user: IdentifiedUser, itemId: string, deps: ScopeDeps = {}): Promise<void> {
  const doResolveScope = deps.resolveItemProjectScope ?? resolveItemProjectScope;
  const doGetProjectOwnerIds = deps.getProjectOwnerIds ?? getProjectOwnerIds;
  if (user.role === "owner" || user.role === "admin") return;
  const scope = await doResolveScope(itemId);
  if (!scope) {
    throw new Error("לא הצלחתי לזהות את הפריט ב-Monday — אי אפשר לאמת הרשאת ניהול.");
  }
  if (!scope.projectId) {
    if (BOARDS_WITH_MANDATORY_PROJECT.has(scope.boardId)) {
      throw new Error("לא הצלחתי לזהות את הפרויקט של הפריט הזה — הפעולה נחסמה לבטיחות במקום לעקוף הרשאה בלי לדעת.");
    }
    return; // אין קשר פרויקט בכלל (ליד/עסקה/משימת משרד לא-מקושרת) — אין scope לאכוף
  }
  const ownerIds = await doGetProjectOwnerIds(scope.projectId);
  if (!isProjectManagerOf(user, ownerIds)) {
    throw new Error(
      "אתה לא מנהל/ת את הפרויקט שהפריט הזה שייך אליו — פעולת ניהול על עבודה של מישהו אחר שמורה למנהל/ת הפרויקט, לבעלים או לאדמין.",
    );
  }
}

/**
 * עדכון משימה (סטטוס/הערה/חסם/בוצע). "המשימה שלי" → תמיד מותר לפי task:update_own, בלי קשר
 * ל-scope פרויקט (סעיף 4+6 בהחלטה: project scope מגביל סמכות ניהול על עבודה של *אחרים*, לא
 * דיווח/עדכון עצמי). לא המשימה שלי → צריך task:manage, ובנוסף — אם זו משימת פרויקט — ניהול
 * בפועל של אותו פרויקט (owner/admin עוקפים).
 */
async function authorize(user: IdentifiedUser, itemId: string, deps: ScopeDeps = {}): Promise<void> {
  const doIsOwnItem = deps.isOwnItem ?? isOwnItem;
  if (!userCan(user, "task:update_own")) throw new Error("אין לך הרשאה לעדכן משימות");
  if (!user.mondayUserId) throw new Error("אין חשבון Monday מקושר למשתמש");

  if (await doIsOwnItem(itemId, user.mondayUserId)) return;

  if (!userCan(user, "task:manage")) {
    throw new Error("המשימה הזו לא משויכת אליך");
  }
  if (user.role === "owner" || user.role === "admin") return;
  await assertManagesItemProject(user, itemId, deps);
}

export type TaskUpdateAction = "done" | "state" | "note" | "blocker";

export interface TaskUpdateInput {
  action: TaskUpdateAction;
  source: OpsTaskSource;
  itemId: string;
  label?: string;
  note?: string;
}

/**
 * הוספת הערת עדכון (Update) לכל פריט ב-Monday — ליד / משימה / פרויקט / עסקה / גבייה.
 * הערה היא פעולה תפעולית פנימית ובלתי-הרסנית, לכן מותרת לכל מי שיש לו הרשאת "נגיעה" כלשהי,
 * ובלי בדיקת בעלות (בניגוד לשינוי סטטוס). לא כותב ללקוח — רק ל-Updates הפנימיים.
 */
export async function addUpdateToItem(
  user: IdentifiedUser,
  itemId: string,
  body: string,
): Promise<{ ok: true; message: string }> {
  const canNote =
    userCan(user, "task:update_own") ||
    userCan(user, "task:create") ||
    userCan(user, "lead:manage") ||
    userCan(user, "finance:manage") ||
    userCan(user, "project:manage");
  if (!canNote) throw new Error("אין לך הרשאה להוסיף הערות");
  if (!body.trim()) throw new Error("הערה ריקה");
  if (!/^\d+$/.test(itemId)) throw new Error("מזהה פריט לא תקין");
  // כל כתיבה ל-Monday רשומה על חשבון ה-API (מוטי). השורה הראשונה היא מי באמת רשם.
  await addTaskNote(itemId, `✍️ נרשם ע"י ${user.name} (דרך העוזר התפעולי)\n\n${body.trim()}`);
  return { ok: true, message: "ההערה נוספה ל-Monday" };
}

export interface ReassignItemDeps extends ScopeDeps {
  findUsersByName?: (query: string) => Promise<MondayUser[]>;
  detectPeopleColumn?: (itemId: string) => Promise<PeopleColumnInfo>;
  setItemPeople?: (boardId: string, itemId: string, columnId: string, personIds: string[]) => Promise<void>;
  addTaskNote?: (itemId: string, body: string) => Promise<void>;
}

/**
 * החלפת האחראי/ת של פריט Monday (ליד / עסקה / משימה / פרויקט / שלב).
 * שינוי תפעולי פנימי — מותר למי שמנהל משימות/לידים/פרויקטים (owner, admin, מנהל פרויקט).
 * לא כספים ולא שרטוט. כל החלפה מתועדת ב-Update עם שם המבצע.
 *
 * project scope (2026-09-24): על משימה/שלב/פרויקט — מנהל/ת פרויקט (לא owner/admin) מורשה
 * להעביר אחראי/ת רק בפרויקט שהוא/היא עצמו/ה מנהל/ת (assertManagesItemProject). על ליד/עסקה —
 * אין scope כזה, ממשיך להיות מסונן רק לפי lead:manage/project:manage כמו קודם.
 */
export async function reassignItem(
  user: IdentifiedUser,
  itemId: string,
  person: string,
  deps: ReassignItemDeps = {},
): Promise<{ ok: true; message: string }> {
  const doFindUsersByName = deps.findUsersByName ?? findUsersByName;
  const doDetectPeopleColumn = deps.detectPeopleColumn ?? detectPeopleColumn;
  const doSetItemPeople = deps.setItemPeople ?? setItemPeople;
  const doAddTaskNote = deps.addTaskNote ?? addTaskNote;

  const canReassign =
    userCan(user, "task:manage") || userCan(user, "lead:manage") || userCan(user, "project:manage");
  if (!canReassign) throw new Error("אין לך הרשאה לשנות אחראי/ת על פריטים");
  if (!/^\d+$/.test(itemId)) throw new Error("מזהה פריט לא תקין");
  // scope פר-פרויקט: על ליד/עסקה לא חל בכלל (assertManagesItemProject לא נוגע שם) — ממשיך
  // להיות מסונן רק לפי lead:manage/project:manage כמו קודם.
  await assertManagesItemProject(user, itemId, deps);
  const wanted = person.trim();
  if (!wanted) throw new Error("לא צוין למי להעביר");

  // קודם ספר הצוות שלנו (מכיר "יוכי" בעברית), אחר כך חיפוש משתמשי Monday.
  let targetId: string | undefined;
  let targetName = wanted;
  const fromDirectory = resolveUsersByAssigneeText(wanted);
  if (fromDirectory.length === 1) {
    if (!fromDirectory[0]!.mondayUserId) {
      throw new Error(`ל${fromDirectory[0]!.name} אין חשבון Monday פעיל — אי אפשר להקצות אליו/ה`);
    }
    targetId = fromDirectory[0]!.mondayUserId;
    targetName = fromDirectory[0]!.name;
  } else if (fromDirectory.length > 1) {
    throw new Error(`"${wanted}" מתאים לכמה אנשים: ${fromDirectory.map((u) => u.name).join(", ")}. מי בדיוק?`);
  } else {
    const mondayMatches = await doFindUsersByName(wanted);
    if (mondayMatches.length === 0) throw new Error(`לא מצאתי משתמש/ת בשם "${wanted}" ב-Monday`);
    if (mondayMatches.length > 1) {
      throw new Error(`"${wanted}" מתאים לכמה: ${mondayMatches.map((u) => u.name).join(", ")}. מי בדיוק?`);
    }
    targetId = mondayMatches[0]!.id;
    targetName = mondayMatches[0]!.name;
  }

  const col = await doDetectPeopleColumn(itemId);
  if (col.currentIds.length === 1 && col.currentIds[0] === targetId) {
    return { ok: true, message: `"${col.itemName}" כבר משויך/ת ל${targetName}` };
  }
  await doSetItemPeople(col.boardId, itemId, col.columnId, [targetId]);
  await doAddTaskNote(
    itemId,
    `👤 ${col.columnTitle} שונה/תה ל${targetName} — ע"י ${user.name} דרך העוזר התפעולי`,
  );
  return { ok: true, message: `${col.columnTitle} של "${col.itemName}" עודכן/ה ל${targetName}` };
}

export interface UpdateTaskDeps extends ScopeDeps {
  setTaskStatus?: (source: OpsTaskSource, itemId: string, label: string) => Promise<void>;
  addTaskNote?: (itemId: string, body: string) => Promise<void>;
}

export async function updateTask(
  user: IdentifiedUser,
  input: TaskUpdateInput,
  deps: UpdateTaskDeps = {},
): Promise<{ ok: true; message: string }> {
  const doSetTaskStatus = deps.setTaskStatus ?? setTaskStatus;
  const doAddTaskNote = deps.addTaskNote ?? addTaskNote;
  await authorize(user, input.itemId, deps);

  switch (input.action) {
    case "done":
      await doSetTaskStatus(input.source, input.itemId, DONE_LABEL[input.source]);
      return { ok: true, message: "סומן כבוצע ✅" };

    case "state":
      if (!input.label) throw new Error("חסר סטטוס");
      await doSetTaskStatus(input.source, input.itemId, input.label);
      return { ok: true, message: `הסטטוס עודכן ל"${input.label}"` };

    case "note":
      if (!input.note?.trim()) throw new Error("הערה ריקה");
      await doAddTaskNote(input.itemId, input.note);
      return { ok: true, message: "ההערה נוספה" };

    case "blocker":
      await doSetTaskStatus(input.source, input.itemId, "תקוע");
      if (input.note?.trim()) await doAddTaskNote(input.itemId, `🚧 חסם: ${input.note.trim()}`);
      return { ok: true, message: "דווח כתקוע" };

    default:
      throw new Error("פעולה לא מוכרת");
  }
}

// ---------------------------------------------------------------------------
// יצירת משימה חדשה / ליד חדש מהחלונית (create_task / create_lead) — 2026-09-17.
//
// עיצוב: המשתמש אף פעם לא מוסר boardId/itemId. פרויקט/שלב/מבצע מזוהים לפי טקסט חופשי;
// עמימות (כמה התאמות) → שגיאה שמזמינה את המודל לשאול, בדיוק כמו reassignItem. אין ניחוש שלב:
// בלי ציון שלב מפורש נבחר "השלב הנוכחי" (currentStageIndex, אותה הגדרה כמו "הפעולה הבאה"),
// ורק אם יש שלבים בכלל.
//
// הרשאות (סעיף 5 בבקשת יוכי — נבדק מול roles.ts + CLAUDE.md §5, לא ניחוש):
//   - יצירה *לעצמי* → מספיק task:create (זה בדיוק למה task:create הופרד מ-task:manage — כדי
//     שרוחמה תוכל ליצור לעצמה משימות המשך בלי יכולת להקצות לאחרים, ר' CLAUDE.md §5).
//   - יצירה *לאדם אחר* → צריך task:manage (אותה הרשאה שכבר שולטת על reassignItem/הקצאה).
//   - create_lead: lead:manage בלבד, גם ליצירה עצמה וגם לקביעת אחראי/ת אחר/ת — אין ב-CLAUDE.md
//     שום פיצול דומה בין "ליד לעצמי" ל"ליד לאחר" (בשונה מ-task:create/task:manage), ו-lead:manage
//     כבר שולט היום גם על reassignItem של לידים. לא הומצא פיצול חדש.
//   פתוח: project_manager (task:manage) לא מוגבל כרגע לפרויקטים שהוא/היא מנהל/ת בפועל — התנהגות
//   זהה למה שכבר קיים היום ב-reassignItem/updateTask (אין scope פר-פרויקט בקוד בכלל, CLAUDE.md §7
//   מציין את זה כפער פתוח שנדחה ל"שלב 4"). לא הוספתי הגבלה חדשה כאן — זו החלטת מדיניות עסקית
//   שלא הוגדרה, ומדווחת למוטי/יוכי בנפרד, לא מוכרעת בשקט בקוד.
// ---------------------------------------------------------------------------

export type AssigneeResolution =
  | { ok: true; mondayUserId: string; name: string }
  | { ok: false; reason: "ambiguous"; options: string[] }
  | { ok: false; reason: "not_found" };

export interface ResolveAssigneeDeps {
  findUsersByName?: (query: string) => Promise<MondayUser[]>;
}

/**
 * פותר שם עובד/ת חופשי למשתמש Monday — קודם ספר הצוות שלנו (מכיר "יוכי" בעברית), אחר כך חיפוש
 * משתמשי Monday. במתכוון לא עובר דרך reassignItem (שם הלוגיקה כבר בדוקה בפרודקשן) — כפילות
 * קטנה ומבודדת עדיפה כאן על ריפקטור של קוד קיים ועובד, לפי בקשת הזהירות של יוכי.
 */
export async function resolveAssigneeByText(
  text: string,
  deps: ResolveAssigneeDeps = {},
): Promise<AssigneeResolution> {
  const doFindUsersByName = deps.findUsersByName ?? findUsersByName;
  const wanted = text.trim();
  if (!wanted) return { ok: false, reason: "not_found" };

  const fromDirectory = resolveUsersByAssigneeText(wanted);
  if (fromDirectory.length === 1) {
    const u = fromDirectory[0]!;
    if (!u.mondayUserId) return { ok: false, reason: "not_found" };
    return { ok: true, mondayUserId: u.mondayUserId, name: u.name };
  }
  if (fromDirectory.length > 1) {
    return { ok: false, reason: "ambiguous", options: fromDirectory.map((u) => u.name) };
  }

  const mondayMatches = await doFindUsersByName(wanted);
  if (mondayMatches.length === 0) return { ok: false, reason: "not_found" };
  if (mondayMatches.length > 1) {
    return { ok: false, reason: "ambiguous", options: mondayMatches.map((u) => u.name) };
  }
  return { ok: true, mondayUserId: mondayMatches[0]!.id, name: mondayMatches[0]!.name };
}

/**
 * האם המשתמש "מנהל/ת" את הפרויקט הנתון — owner/admin תמיד (בקרה־על, כל המשרד); כל תפקיד אחר
 * רק אם מזהה ה-Monday שלו מופיע בעמודת האחראי/ת (person) של הפרויקט עצמו (ProjectMeta.ownerIds,
 * מקור האמת היחיד — CLAUDE.md §3: "מנהל פרויקט = מי שמופיע ב'אחראי/ת' של הפרויקט"). ID ולא
 * טקסט, כדי לא להתבסס על התאמת שם.
 */
/** owner/admin — תמיד; כל תפקיד אחר — רק אם מזהה ה-Monday שלו ברשימת האחראים שהתקבלה. */
function isProjectManagerOf(user: IdentifiedUser, ownerIds: string[]): boolean {
  if (user.role === "owner" || user.role === "admin") return true;
  return !!user.mondayUserId && ownerIds.includes(user.mondayUserId);
}

function managesProject(user: IdentifiedUser, project: ProjectMeta): boolean {
  return isProjectManagerOf(user, project.ownerIds);
}

/**
 * הרשאה ליצירת משימה: task:create מספיק *לעצמי בלבד* (בדיוק למה task:create הופרד מ-task:manage,
 * ר' CLAUDE.md §5 — רוחמה יוצרת לעצמה, לא מקצה לאחרים). ליצירה *לאדם אחר* צריך task:manage —
 * ואם המשימה שייכת לפרויקט, task:manage לבד לא מספיק יותר: סגירת הפער שמוטי ביקש (2026-09-17,
 * החלטה עסקית #2) — מנהל/ת פרויקט (role project_manager) מורשה ליצור/להקצות משימות של-*אחרים*
 * רק בפרויקטים שהוא/היא בעצמו/ה מנהל/ת אותם (managesProject); owner/admin בכל פרויקט, תמיד.
 * משימת משרד כללית (project=undefined) לא נכנסת לבדיקת ה-scope הזו — אין לה "מנהל פרויקט".
 */
function authorizeCreateTask(user: IdentifiedUser, assigneeMondayId: string, project?: ProjectMeta): void {
  if (!user.mondayUserId) throw new Error("אין חשבון Monday מקושר למשתמש — אי אפשר ליצור משימה");
  const forSelf = user.mondayUserId === assigneeMondayId;
  if (forSelf) {
    if (!userCan(user, "task:create") && !userCan(user, "task:manage")) {
      throw new Error("אין לך הרשאה ליצור משימות");
    }
    return;
  }
  if (!userCan(user, "task:manage")) {
    throw new Error("אין לך הרשאה ליצור משימה עבור מישהו אחר — רק ליצור משימות לעצמך");
  }
  if (project && !managesProject(user, project)) {
    throw new Error(
      `אתה לא מנהל/ת הפרויקט "${project.name}" — הקצאת משימה לאדם אחר בפרויקט הזה שמורה למנהל/ת הפרויקט, לבעלים או לאדמין.`,
    );
  }
}

export interface CreateTaskInput {
  taskName: string;
  /** שם הפרויקט, אם המשימה שייכת לפרויקט. בלי זה — משימת משרד כללית. */
  project?: string;
  /** שם/מספר שלב, רק אם העובד ציין במפורש. בלי זה — נבחר השלב הפעיל אוטומטית. */
  stage?: string;
  /** שם עובד/ת חופשי. בלי זה — המשתמש עצמו. */
  assignee?: string;
  /** YYYY-MM-DD */
  dueDate?: string;
  priority?: string;
}

export interface CreateTaskResult {
  ok: true;
  itemId: string;
  itemName: string;
  source: OpsTaskSource;
  project?: string;
  stageName?: string;
  assigneeName: string;
  message: string;
  /** true אם זו לא יצירה חדשה אלא תוצאה קודמת שנמצאה לפי idempotency key (retry) */
  deduped: boolean;
}

export interface CreateTaskDeps {
  listProjects?: () => Promise<ProjectMeta[]>;
  getProjectStages?: (projectId: string) => Promise<ProjectStage[]>;
  findUsersByName?: (query: string) => Promise<MondayUser[]>;
  createStageTask?: (input: CreateStageTaskInput) => Promise<{ id: string; name: string }>;
  createGeneralTask?: (input: CreateGeneralTaskInput) => Promise<{ id: string; name: string }>;
  getCachedCreation?: typeof getCachedCreation;
  recordCreation?: typeof recordCreation;
  addNotification?: typeof addNotification;
  publishNotificationLive?: typeof publishNotificationLive;
}

/**
 * יוצר משימה חדשה ב-Monday במקום הנכון: subitem בשלב הפעיל של הפרויקט אם ניתן שם פרויקט,
 * אחרת item במאגר המשימות הכלליות. זורק Error עם טקסט מיועד למודל (לשאול את המשתמש) על כל
 * עמימות/אי-התאמה — אותו pattern כמו reassignItem/updateTask. אידמפוטנטי: אותו קלט מנורמל
 * בתוך חלון זמן לא יוצר כפילות (ר' idempotentCreations.ts).
 */
export async function createTaskAction(
  user: IdentifiedUser,
  input: CreateTaskInput,
  deps: CreateTaskDeps = {},
): Promise<CreateTaskResult> {
  const doListProjects = deps.listProjects ?? fetchActiveProjects;
  const doGetProjectStages = deps.getProjectStages ?? getProjectStages;
  const doFindUsersByName = deps.findUsersByName ?? findUsersByName;
  const doCreateStageTask = deps.createStageTask ?? createStageTask;
  const doCreateGeneralTask = deps.createGeneralTask ?? createGeneralTask;
  const doGetCachedCreation = deps.getCachedCreation ?? getCachedCreation;
  const doRecordCreation = deps.recordCreation ?? recordCreation;
  const doAddNotification = deps.addNotification ?? addNotification;
  const doPublishNotificationLive = deps.publishNotificationLive ?? publishNotificationLive;

  if (!user.mondayUserId) throw new Error("אין חשבון Monday מקושר למשתמש — אי אפשר ליצור משימה");
  const taskName = input.taskName.trim();
  if (!taskName) throw new Error("חסר שם למשימה");
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
    throw new Error(`תאריך לא תקין: "${input.dueDate}" (צריך YYYY-MM-DD)`);
  }

  // ---- מבצע ----
  let assigneeId = user.mondayUserId;
  let assigneeName = user.name;
  if (input.assignee?.trim()) {
    const resolved = await resolveAssigneeByText(input.assignee, { findUsersByName: doFindUsersByName });
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        throw new Error(`"${input.assignee}" מתאים לכמה אנשים: ${resolved.options.join(", ")}. מי בדיוק?`);
      }
      throw new Error(`לא מצאתי עובד/ת בשם "${input.assignee}"`);
    }
    assigneeId = resolved.mondayUserId;
    assigneeName = resolved.name;
  }

  // ---- פרויקט + שלב (רק אם ניתן פרויקט) — לפני ההרשאה, כי scope הפרויקט צריך את ProjectMeta ----
  let projectId: string | undefined;
  let projectName: string | undefined;
  let stageItemId: string | undefined;
  let stageName: string | undefined;
  let resolvedProject: ProjectMeta | undefined;

  if (input.project?.trim()) {
    const projects = await doListProjects();
    const matches = matchProjectsByQuery(projects, input.project);
    if (matches.length === 0) throw new Error(`לא מצאתי פרויקט שמתאים ל-"${input.project}"`);
    if (matches.length > 1) {
      throw new Error(
        `"${input.project}" מתאים לכמה פרויקטים: ${matches.map((p) => p.name).join(", ")}. לאיזה בדיוק?`,
      );
    }
    const project = matches[0]!;
    resolvedProject = project;
    projectId = project.itemId;
    projectName = project.name;

    const stages = await doGetProjectStages(projectId);
    if (stages.length === 0) {
      throw new Error(`לפרויקט "${project.name}" אין שלבים מוגדרים ב-Monday — אי אפשר לשייך אליו משימה.`);
    }

    if (input.stage?.trim()) {
      const stageMatches = matchStagesByQuery(stages, input.stage);
      if (stageMatches.length === 0) {
        throw new Error(
          `לא מצאתי שלב שמתאים ל-"${input.stage}" בפרויקט "${project.name}". השלבים הקיימים: ${stages
            .map((s) => s.name)
            .join(", ")}`,
        );
      }
      if (stageMatches.length > 1) {
        throw new Error(
          `"${input.stage}" מתאים לכמה שלבים: ${stageMatches.map((s) => s.name).join(", ")}. לאיזה בדיוק?`,
        );
      }
      stageItemId = stageMatches[0]!.id;
      stageName = stageMatches[0]!.name;
    } else {
      // בלי שלב מפורש — השלב הפעיל האמיתי (findActiveStage, אותה הגדרה כמו "עכשיו:" בתדריך
      // היומי). אם כל השלבים סגורים/חסומים (אין "שלב פעיל" ברור) — נופלים ל-currentStageIndex
      // (השלב האחרון שנגעו בו) כברירת מחדל סבירה, לא ניחוש שרירותי.
      const active = findActiveStage(stages);
      const fallbackIdx = currentStageIndex(stages);
      const chosen = active?.stage ?? stages[fallbackIdx]!;
      stageItemId = chosen.id;
      stageName = chosen.name;
    }
  }

  authorizeCreateTask(user, assigneeId, resolvedProject);

  // ---- idempotency: retry של אותו tool call (timeout/תקלה) לא יוצר כפילות ----
  const idKey = [
    "create_task",
    user.key,
    taskName.toLowerCase(),
    projectId ?? "",
    stageItemId ?? "",
    assigneeId,
    input.dueDate ?? "",
  ].join("|");
  const cached = doGetCachedCreation(idKey);
  if (cached) {
    const c = cached.result as { itemId: string; itemName: string; source: OpsTaskSource };
    return {
      ok: true,
      itemId: c.itemId,
      itemName: c.itemName,
      source: c.source,
      project: projectName,
      stageName,
      assigneeName,
      message: `המשימה "${c.itemName}" כבר נוצרה קודם (מזהה תואם) — לא יצרתי כפילות.`,
      deduped: true,
    };
  }

  // ---- יצירה בפועל ----
  let created: { id: string; name: string };
  let source: OpsTaskSource;
  if (stageItemId) {
    created = await doCreateStageTask({
      stageItemId,
      name: taskName,
      personId: assigneeId,
      dueDate: input.dueDate,
      priority: input.priority,
    });
    source = "project_stage";
  } else {
    created = await doCreateGeneralTask({
      name: taskName,
      personId: assigneeId,
      dueDate: input.dueDate,
      priority: input.priority,
      projectId,
    });
    source = "general";
  }

  doRecordCreation(idKey, { itemId: created.id, itemName: created.name, source });

  // הקצאה לאדם אחר → פינג דרך מנגנון ההתראות הקיים (notifications+SSE), לא ערוץ חדש —
  // ר' CLAUDE.md replyAwaitManager לתקדים זהה (loopReply.ts).
  if (assigneeId !== user.mondayUserId) {
    const assignee = TEAM_DIRECTORY.find((m) => m.mondayUserId === assigneeId);
    if (assignee) {
      const where = projectName ? ` בפרויקט "${projectName}"${stageName ? ` · ${stageName}` : ""}` : "";
      const dueTxt = input.dueDate ? ` · יעד ${input.dueDate}` : "";
      const body = `${user.name} פתח/ה לך משימה חדשה: "${created.name}"${where}${dueTxt}`;
      const notifId = doAddNotification(assignee.key, "task_assigned", body, undefined, {
        itemId: created.id,
        itemSource: source,
      });
      doPublishNotificationLive({
        userKey: assignee.key,
        id: notifId,
        kind: "task_assigned",
        body,
        findingKey: null,
        itemId: created.id,
        itemSource: source,
        context: null,
        createdAt: new Date().toISOString(),
      });
    }
  }

  const forOther = assigneeName !== user.name ? ` ל${assigneeName}` : "";
  const inProject = projectName ? ` בפרויקט "${projectName}"${stageName ? ` · ${stageName}` : ""}` : "";
  const dueSuffix = input.dueDate ? ` · יעד ${input.dueDate}` : "";
  return {
    ok: true,
    itemId: created.id,
    itemName: created.name,
    source,
    project: projectName,
    stageName,
    assigneeName,
    message: `נוצרה משימה "${created.name}"${forOther}${inProject}${dueSuffix}`,
    deduped: false,
  };
}

export interface CreateLeadActionInput {
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  source?: string;
  product?: string;
  referredBy?: string;
  /** שם עובד/ת חופשי. בלי זה — המשתמש היוצר. */
  assignee?: string;
}

export interface CreateLeadResult {
  ok: true;
  itemId: string;
  itemName: string;
  message: string;
  deduped: boolean;
}

export interface CreateLeadDeps {
  createLead?: (input: CreateLeadInput) => Promise<{ id: string; name: string }>;
  findUsersByName?: (query: string) => Promise<MondayUser[]>;
  getCachedCreation?: typeof getCachedCreation;
  recordCreation?: typeof recordCreation;
}

/**
 * יוצר ליד חדש דרך createLead() הקיימת (leads.ts) — היא כן תואמת למבנה בורד הלידים (column ids
 * מאומתים מול CLAUDE.md §4). תוספת יחידה: אחראי/ת, ברירת מחדל = המשתמש היוצר (אם lead:manage
 * ולא צוין אחרת) — כדי שלא ייווצרו לידים בלי אחראי (ר' crmScan.ts, שכבר מזהה את זה כממצא).
 */
export async function createLeadAction(
  user: IdentifiedUser,
  input: CreateLeadActionInput,
  deps: CreateLeadDeps = {},
): Promise<CreateLeadResult> {
  if (!userCan(user, "lead:manage")) throw new Error("אין לך הרשאה ליצור לידים");
  const firstName = input.firstName.trim();
  if (!firstName) throw new Error("חסר שם פרטי לליד");
  if (input.source && !(LEAD_SOURCE_OPTIONS as readonly string[]).includes(input.source)) {
    throw new Error(`"${input.source}" אינו מקור ליד חוקי. אפשרויות: ${LEAD_SOURCE_OPTIONS.join(", ")}`);
  }
  if (input.product && !(LEAD_PRODUCT_OPTIONS as readonly string[]).includes(input.product)) {
    throw new Error(`"${input.product}" אינו מוצר חוקי. אפשרויות: ${LEAD_PRODUCT_OPTIONS.join(", ")}`);
  }

  const doCreateLead = deps.createLead ?? createLeadMonday;
  const doFindUsersByName = deps.findUsersByName ?? findUsersByName;
  const doGetCachedCreation = deps.getCachedCreation ?? getCachedCreation;
  const doRecordCreation = deps.recordCreation ?? recordCreation;

  let assigneeId: string | undefined = user.mondayUserId ?? undefined;
  let assigneeName: string | undefined = user.name;
  if (input.assignee?.trim()) {
    const resolved = await resolveAssigneeByText(input.assignee, { findUsersByName: doFindUsersByName });
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        throw new Error(`"${input.assignee}" מתאים לכמה אנשים: ${resolved.options.join(", ")}. מי בדיוק?`);
      }
      throw new Error(`לא מצאתי עובד/ת בשם "${input.assignee}"`);
    }
    assigneeId = resolved.mondayUserId;
    assigneeName = resolved.name;
  }

  const idKey = [
    "create_lead",
    user.key,
    firstName.toLowerCase(),
    (input.lastName ?? "").trim().toLowerCase(),
    (input.phone ?? "").trim(),
    (input.email ?? "").trim().toLowerCase(),
  ].join("|");
  const cached = doGetCachedCreation(idKey);
  if (cached) {
    const c = cached.result as { itemId: string; itemName: string };
    return {
      ok: true,
      itemId: c.itemId,
      itemName: c.itemName,
      message: `הליד "${c.itemName}" כבר נוצר קודם (מזהה תואם) — לא יצרתי כפילות.`,
      deduped: true,
    };
  }

  const created = await doCreateLead({
    firstName,
    lastName: input.lastName,
    phone: input.phone,
    email: input.email,
    source: input.source as CreateLeadInput["source"],
    product: input.product as CreateLeadInput["product"],
    referredBy: input.referredBy,
    assigneeId,
  });

  doRecordCreation(idKey, { itemId: created.id, itemName: created.name });

  return {
    ok: true,
    itemId: created.id,
    itemName: created.name,
    message: `נוצר ליד "${created.name}"${assigneeName ? ` (אחראי/ת: ${assigneeName})` : ""}`,
    deduped: false,
  };
}
