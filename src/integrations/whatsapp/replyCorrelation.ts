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

export function createInboundCorrelation(jid: string): string {
  const id = `${jid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
