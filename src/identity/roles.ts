/**
 * תפקידים והרשאות — הליבה של שכבת הזהות.
 *
 * העיקרון (מתוך CLAUDE.md): כל בקשה עוברת `זהות משתמש → תפקיד → הרשאות → הקשר → AI → פעולה מותרת`.
 * הקובץ הזה מגדיר את שני השלבים האמצעיים: מה התפקידים הקיימים ומה כל תפקיד מורשה לעשות.
 *
 * ההרשאות כאן הן "מה מותר בכלל" (capability). ה-*היקף* (scope) — למשל "מנהל פרויקט רואה רק
 * את הפרויקטים שהוא האחראי עליהם" — מחושב בזמן שאילתה במנוע הבקרה, לא כאן.
 */

export type Role = "owner" | "project_manager" | "planner" | "finance" | "admin";

export type Permission =
  /** לראות את המשימות/העבודה של עצמי */
  | "view:own_work"
  /** לראות עבודה מעבר לעצמי — מוגבל בזמן שאילתה לפרויקטים שאני מנהל */
  | "view:managed_projects"
  /** לראות הכל בכל הפרויקטים והצוות (בקרה־על) */
  | "view:all_work"
  /** לראות גבייה, תשלומים, רווחיות */
  | "view:finance"
  /** דיווח נוכחות וטיימרים מהחלונית */
  | "report:hours"
  /** לעדכן סטטוס/הערה/חסם על משימה שלי */
  | "task:update_own"
  /** ליצור משימה חדשה — בעיקר משימת המשך לעצמי */
  | "task:create"
  /** להקצות לאחרים, לקבוע תאריכים, לנהל משימות בכל הפרויקט */
  | "task:manage"
  /** לנהל מחזור חיים של פרויקט כולל רישוי */
  | "project:manage"
  /** לנהל את פייפליין הלידים והפולואפים */
  | "lead:manage"
  /** לנהל גבייה והפקת חשבוניות */
  | "finance:manage"
  /** להכין ולשלוח תקשורת מול לקוח (עדיין דורש אישור אנושי בפעולות רגישות) */
  | "client:communicate"
  /** לאשר פעולות רגישות — לקוח / כסף / מחיקה */
  | "approve:sensitive"
  /** קונפיגורציה של המערכת, פיתוח, אדמין */
  | "system:admin";

const ALL_PERMISSIONS: Permission[] = [
  "view:own_work",
  "view:managed_projects",
  "view:all_work",
  "view:finance",
  "report:hours",
  "task:update_own",
  "task:create",
  "task:manage",
  "project:manage",
  "lead:manage",
  "finance:manage",
  "client:communicate",
  "approve:sensitive",
  "system:admin",
];

/**
 * מטריצת ההרשאות (סעיף 3 ב-CLAUDE.md, מאושר מול מוטי 2026-09-02).
 * - מוטי (owner) — הכל, כולל אישור פעולות רגישות.
 * - יוכי (admin) — הכל למעט אישור פעולות רגישות. אישור כסף/מחיקה/לקוח = מוטי בלבד.
 * - שאר התפקידים — בדיוק מה שנדרש.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [...ALL_PERMISSIONS],
  admin: ALL_PERMISSIONS.filter((p) => p !== "approve:sensitive"),
  project_manager: [
    "view:own_work",
    "view:managed_projects",
    "report:hours",
    "task:update_own",
    "task:create",
    "task:manage",
    "project:manage",
    "lead:manage",
    "client:communicate",
  ],
  planner: ["view:own_work", "report:hours", "task:update_own", "task:create"],
  finance: ["view:own_work", "view:finance", "finance:manage", "report:hours"],
};

/** תיאור התפקיד בעברית — נכנס ל-system prompt כדי שה-AI יידע מול מי הוא מדבר. */
export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: "בעלים ובקרת־על. רואה הכל, מאשר פעולות רגישות, לא רודף אחרי משימות בעצמו.",
  project_manager: "מנהל/ת פרויקטים מקצה לקצה כולל הרישוי. אחראי/ת על הפרויקטים שהוא/היא רשום/ה עליהם.",
  planner: "שרטוט ותכנון. עובד/ת על משימות בתוך הפרויקטים של מנהלי הפרויקטים ויוצר/ת לעצמו/ה משימות המשך. לא מנהל/ת פרויקטים ולא מקצה/ה לאחרים.",
  finance: "כספים. כל ענייני הגבייה, התשלומים והחשבוניות מנותבים אליו/ה.",
  admin: "פיתוח ואדמיניסטרציה של המערכת.",
};

export function permissionsForRole(role: Role): Set<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}
