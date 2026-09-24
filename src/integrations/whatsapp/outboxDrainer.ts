/**
 * מרוקן את תור ה-WhatsApp (טבלת whatsapp_outbox) — הודעות שמנוע הבקרה בשרת החלונית מייצר
 * (למשל תדריך הבוקר למוטי) ושרק סוכן ה-WhatsApp יכול לשלוח בפועל.
 *
 * שני התהליכים חולקים את אותו קובץ SQLite. אם הסוכן כבוי — ההודעות מחכות (עד 12 שעות, ואז נזרקות
 * כדי לא להציף אותו כשהוא חוזר).
 */

import { listUnsentWhatsapp, markWhatsappSent } from "../../db/repositories/whatsappOutbox.js";
import { logger } from "../../utils/logger.js";
import { sendText, WhatsAppNotReadyError } from "./send.js";

const POLL_MS = 60_000;

let started = false;
// מונע tick חופף: אם סבב איטי (למשל כמה הודעות עם retry) עדיין רץ כש-setInterval מנסה
// להפעיל את הבא, שני הסבבים היו יכולים למשוך את אותה הודעה שטרם סומנה כנשלחה ולשלוח אותה פעמיים.
let draining = false;

/** סבב ריקון בודד — exported בנפרד מ-startOutboxDrainer כדי שאפשר יהיה לבדוק את ה-re-entrancy guard בבידוד. */
export async function drainOnce(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (const msg of listUnsentWhatsapp()) {
      try {
        await sendText(msg.jid, msg.body, { source: "outbox" });
        markWhatsappSent(msg.id);
        logger.info({ id: msg.id, jid: msg.jid }, "הודעת תור WhatsApp נשלחה");
      } catch (err) {
        if (err instanceof WhatsAppNotReadyError) {
          logger.info({ id: msg.id }, "WhatsApp לא מחובר כרגע — ההודעה תישאר בתור, ננסה שוב בסבב הבא");
        } else {
          logger.warn({ err, id: msg.id }, "שליחת הודעת תור נכשלה — תישאר לניסיון הבא");
        }
        break; // אם השליחה נכשלה/החיבור לא מוכן — לא ממשיכים בסבב הזה
      }
    }
  } catch (err) {
    logger.error(err, "מרוקן תור WhatsApp נכשל");
  } finally {
    draining = false;
  }
}

export function startOutboxDrainer(): void {
  if (started) {
    logger.warn("startOutboxDrainer נקרא פעמיים — מתעלם מהקריאה השנייה");
    return;
  }
  started = true;

  setInterval(() => void drainOnce(), POLL_MS);
  void drainOnce();
}
