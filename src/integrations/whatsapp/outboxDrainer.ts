/**
 * מרוקן את תור ה-WhatsApp (טבלת whatsapp_outbox) — הודעות שמנוע הבקרה בשרת החלונית מייצר
 * (למשל תדריך הבוקר למוטי) ושרק סוכן ה-WhatsApp יכול לשלוח בפועל.
 *
 * שני התהליכים חולקים את אותו קובץ SQLite. אם הסוכן כבוי — ההודעות מחכות (עד 12 שעות, ואז נזרקות
 * כדי לא להציף אותו כשהוא חוזר).
 */

import type { WASocket } from "@whiskeysockets/baileys";
import { listUnsentWhatsapp, markWhatsappSent } from "../../db/repositories/whatsappOutbox.js";
import { logger } from "../../utils/logger.js";
import { sendText } from "./send.js";

const POLL_MS = 60_000;

export function startOutboxDrainer(sock: WASocket): void {
  const tick = async () => {
    try {
      for (const msg of listUnsentWhatsapp()) {
        try {
          await sendText(sock, msg.jid, msg.body);
          markWhatsappSent(msg.id);
          logger.info({ id: msg.id, jid: msg.jid }, "הודעת תור WhatsApp נשלחה");
        } catch (err) {
          logger.warn({ err, id: msg.id }, "שליחת הודעת תור נכשלה — תישאר לניסיון הבא");
          break; // אם השליחה נכשלה, כנראה החיבור בעייתי — לא ממשיכים בסבב הזה
        }
      }
    } catch (err) {
      logger.error(err, "מרוקן תור WhatsApp נכשל");
    }
  };
  setInterval(tick, POLL_MS);
  void tick();
}
