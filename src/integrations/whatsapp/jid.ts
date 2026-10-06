import { jidNormalizedUser } from "@whiskeysockets/baileys";

/**
 * מנרמל jid לשימוש כמפתח קיבוץ/נעילה/dedup (מוריד device suffix, מאחד @c.us ל-@s.whatsapp.net).
 * לא מאחד @lid מול מספר טלפון — אלה namespaces נפרדים ב-WhatsApp, ואין מיפוי מקומי ביניהם.
 * שיתוף פונקציה אחת בין client.ts (breakers) ל-messageHandler.ts (processingJids) כדי שלא
 * יהיו שני מימושי נרמול שסוטים זה מזה — בדיוק כזה סטיה הייתה חלק מהבעיה (jid ייחודי-למראה
 * שגרם ל-lock/breaker per-jid לא לזהות שתי הודעות כשייכות לאותה שיחה).
 */
export function normalizeJid(jid: string): string {
  try {
    return jidNormalizedUser(jid) || jid;
  } catch {
    return jid;
  }
}

export type JidType = "lid" | "pn" | "group" | "status" | "broadcast" | "newsletter" | "unknown";

/**
 * מסווגת jid לקטגוריה גסה לפי ה-suffix שלו בלבד (לא חושפת את המספר/ה-id עצמו) — לאבחון
 * אבחון LID-vs-PN (Baileys 7, addressing mode חדש ל-WhatsApp) מעל הודעות נכנסות, בלי לרשום
 * jid גולמי בלוגים.
 */
export function classifyJidType(jid: string | null | undefined): JidType {
  if (!jid) return "unknown";
  if (jid === "status@broadcast") return "status";
  if (jid.endsWith("@g.us")) return "group";
  if (jid.endsWith("@broadcast")) return "broadcast";
  if (jid.endsWith("@lid")) return "lid";
  if (jid.endsWith("@s.whatsapp.net")) return "pn";
  if (jid.endsWith("@newsletter")) return "newsletter";
  return "unknown";
}
