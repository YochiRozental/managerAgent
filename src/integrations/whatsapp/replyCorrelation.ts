/**
 * אכיפה בפועל של "לכל היותר תשובה אוטומטית אחת עבור הודעה נכנסת אחת" — לא רק tracing.
 *
 * category A (תגובה אוטומטית להודעה נכנסת) מול category B (הודעה יזומה/מערכת — outbox,
 * תדריכים, נדנודים): רק A עוברת כאן. B ממשיכה להשתמש ב-sendText/sendVoiceNote הגולמי ישירות,
 * בלי correlation בכלל — היא לא תגובה לשום דבר, ואין לה מה "לצרוך".
 *
 * הזרימה: client.ts's guardedForward קורא ל-createInboundCorrelation() *רק* אחרי שהודעה עברה
 * את כל שכבות הסינון (blackout/id/content/dedup/breaker) ואומתה כקלט נכנס אמיתי — זו הפעם
 * היחידה שנוצר correlation. messageHandler.ts's sendReply (ורק הוא, בנתיב A) קורא ל-
 * consumeCorrelationForReply() ממש לפני השליחה. ניסיון שני לצרוך את אותו correlation — בין אם
 * כי handleIncomingMessage הופעל פעמיים, ובין אם כי משהו אחר ניסה לשלוח תגובה בלי הודעה נכנסת
 * חדשה — נכשל. bot echo, אם בכלל יעבור את כל שכבות הסינון ב-client.ts (לא אמור), יקבל
 * correlation *חדש* משלו — אבל השליחה הבודדת הזו מוגבלת ל-response אחד, לא לשרשרת.
 */
import { randomUUID } from "node:crypto";

export class InvalidCorrelationError extends Error {
  constructor(reason: string) {
    super(`תשובה אוטומטית נדחתה — correlation לא תקף: ${reason}`);
    this.name = "InvalidCorrelationError";
  }
}

interface CorrelationRecord {
  jid: string;
  consumed: boolean;
}

const CORRELATION_TTL_MS = 5 * 60_000;
const correlations = new Map<string, CorrelationRecord>();

/**
 * מזהה אקראי טהור — אף פעם לא נגזר מ-jid/מספר טלפון (לא כתוכן, לא כ-prefix/suffix). הקישור
 * לנמען נשמר רק *פנימית* ב-CorrelationRecord (jid, לא חשוף ב-id עצמו) — כל מה שמופיע בלוגים
 * (whatsapp_inbound/whatsapp_send) הוא ה-correlationId האטום הזה, ולצדו jidHash/recipientHash
 * נפרד; אף אחד מהם, גם ביחד, לא משחזר את ה-jid המקורי.
 */
export function createInboundCorrelation(jid: string): string {
  const id = randomUUID();
  correlations.set(id, { jid, consumed: false });
  setTimeout(() => correlations.delete(id), CORRELATION_TTL_MS);
  return id;
}

/** זורק InvalidCorrelationError אם אין correlationId תקף, לא קיים/פג, או שכבר נוצל. */
export function consumeCorrelationForReply(correlationId: string | undefined): void {
  if (!correlationId) throw new InvalidCorrelationError("לא הועבר correlationId (לא מקור inbound מאומת)");
  const record = correlations.get(correlationId);
  if (!record) throw new InvalidCorrelationError(`לא קיים או פג (TTL) — ${correlationId}`);
  if (record.consumed) throw new InvalidCorrelationError(`כבר נוצל לתשובה אחת — ${correlationId}`);
  record.consumed = true;
}

export function _resetCorrelationsForTests(): void {
  correlations.clear();
}
