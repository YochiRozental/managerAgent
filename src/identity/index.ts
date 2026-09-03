/**
 * שכבת הזהות — נקודת ה-import היחידה לשאר המערכת.
 *
 * שימוש טיפוסי:
 *   const user = resolveUserByWhatsappJid(jid);
 *   if (!user) return;                       // לא מזוהה — לא מגיבים
 *   if (!userCan(user, "task:manage")) ...   // בדיקת הרשאה לפני פעולה
 */

export type { Role, Permission } from "./roles.js";
export { ROLE_PERMISSIONS, ROLE_DESCRIPTION, permissionsForRole } from "./roles.js";
export type { TeamMember } from "./directory.js";
export { TEAM_DIRECTORY, getTeamMemberByKey } from "./directory.js";
export type { IdentifiedUser } from "./resolve.js";
export {
  resolveUserByWhatsappJid,
  resolveUserByMondayId,
  resolveUserByEmail,
  resolveUserByKey,
  resolveUsersByAssigneeText,
  userCan,
} from "./resolve.js";
