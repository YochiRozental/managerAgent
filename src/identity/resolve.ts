/**
 * זיהוי משתמש — נקודת הכניסה לשכבת הזהות.
 *
 * כל ערוץ (WhatsApp, חלונית, בהמשך צ'אט AI) מזהה את המשתמש לפי מפתח אחר: JID, מזהה Monday, מייל.
 * הפונקציות כאן ממירות כל אחד מאלה ל-`IdentifiedUser` — חבר צוות + קבוצת ההרשאות שלו.
 *
 * אם לא מצליחים לזהות — מחזירים null. הקוראים חייבים לטפל בזה (לא לענות, לבקש הזדהות וכו').
 */

import { TEAM_DIRECTORY, type TeamMember } from "./directory.js";
import { permissionsForRole, ROLE_DESCRIPTION, type Permission } from "./roles.js";

export interface IdentifiedUser extends TeamMember {
  permissions: Permission[];
  roleDescription: string;
}

function identify(member: TeamMember): IdentifiedUser {
  return {
    ...member,
    permissions: [...permissionsForRole(member.role)],
    roleDescription: ROLE_DESCRIPTION[member.role],
  };
}

export function resolveUserByWhatsappJid(jid: string): IdentifiedUser | null {
  const member = TEAM_DIRECTORY.find((m) => m.whatsappJid === jid);
  return member ? identify(member) : null;
}

export function resolveUserByMondayId(mondayUserId: string): IdentifiedUser | null {
  const member = TEAM_DIRECTORY.find((m) => m.mondayUserId === mondayUserId);
  return member ? identify(member) : null;
}

export function resolveUserByEmail(email: string): IdentifiedUser | null {
  const needle = email.trim().toLowerCase();
  const member = TEAM_DIRECTORY.find((m) => m.email?.toLowerCase() === needle);
  return member ? identify(member) : null;
}

export function resolveUserByKey(key: string): IdentifiedUser | null {
  const member = TEAM_DIRECTORY.find((m) => m.key === key);
  return member ? identify(member) : null;
}

export function userCan(user: IdentifiedUser | null, permission: Permission): boolean {
  return user?.permissions.includes(permission) ?? false;
}
