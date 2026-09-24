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
