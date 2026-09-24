/**
 * Diagnostic instrumentation לכל שליחת/קליטת WhatsApp — metadata בלבד, אף פעם לא תוכן הודעה,
 * jid מלא, או auth/session/crypto. המטרה: בניסוי הבא לדעת בוודאות *מי* (איזה source, איזה
 * process, איזה correlation) יצר כל שליחה בפועל — במקום להשוות תוכן טקסט בין תשובות.
 *
 * לוגי pino רגילים (event field + מבנה קבוע) — לא persisted ב-DB, לא stream נפרד. אם בעתיד יתגלה
 * שהלוגים לא מספיקים (pino-pretty איבד/מיזג שורות תחת עומס — לא ראינו לזה עדות, אבל לא הוכחנו
 * שלילית) יהיה צריך persistence ייעודי; לא נבנה כאן כי אין evidence שנדרש.
 */
import { randomUUID, createHash } from "node:crypto";
import { logger } from "../../utils/logger.js";

/** קבוע לכל חיי התהליך — נוצר פעם אחת בטעינת המודול (import יחיד לכל process). */
export const processInstanceId = randomUUID().slice(0, 8);

/** hash קצר ויציב — לא הפיך בפועל בלוג, אבל לא auth/session/crypto data של WhatsApp עצמו. */
export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

export function newSendTraceId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * מקור השליחה — כל מקום בקוד שקורא ל-sendText/sendVoiceNote חייב לספק אחד מאלה. "unknown" קיים
 * כרשת ביטחון טיפוסית, לא כברירת מחדל שקטה — כל call site קיים מספק ערך מפורש (ראו send.ts).
 */
export type SendSource =
  | "inbound_reply" // תשובה אוטומטית ל-handleIncomingMessage, דרך sendReply, דורשת correlationId תקף
  | "inbound_error" // הודעת השתבש-משהו כשעיבוד ה-inbound נכשל
  | "voice_disabled" // fallback קבוע כשהתקבלה הודעת קול וה-transcription כבוי
  | "outbox" // הודעה יזומה שהמתינה ב-whatsapp_outbox (תדריך/דוח, נכתב מ-window process)
  | "lead_email_watcher" // התראת ליד חדש מהאתר (poll שעתי על Gmail)
  | "manual_test" // סקריפטי בדיקה/הד ידניים (scripts/test-whatsapp-*.ts)
  | "unknown";

export type InboundDecision =
  | "accepted"
  | "drop_from_me" // OPTION SAFE invariant — לפני כל דבר אחר
  | "drop_duplicate_id" // אותו message id כבר טופל (alreadyProcessed)
  | "drop_breaker" // circuit breaker (per-jid/גלובלי) או halt גלובלי פעיל
  | "drop_unsupported"; // לא טקסט ולא הודעת קול, או בלי jid תקין

/**
 * seams לבדיקות בלבד (כמו `_runModel` ב-agentLoop.ts) — כדי שטסט יוכל להוכיח *בפועל* מה נרשם
 * (record מלא, לא רק שלא נזרקה שגיאה), בלי לפרסר פלט pino-pretty. אף קריאה אמיתית לא תלויה בהם.
 */
type TraceSink = (record: Record<string, unknown>) => void;
let inboundSink: TraceSink | null = null;
let sendSink: TraceSink | null = null;
let blockedSink: TraceSink | null = null;

export function _setInboundTraceSinkForTests(sink: TraceSink | null): void {
  inboundSink = sink;
}

export function _setSendTraceSinkForTests(sink: TraceSink | null): void {
  sendSink = sink;
}

export function _setBlockedReplySinkForTests(sink: TraceSink | null): void {
  blockedSink = sink;
}

export function logProcessStarted(): void {
  logger.info(
    { event: "whatsapp_process_started", processInstanceId, pid: process.pid, startedAt: new Date().toISOString() },
    "whatsapp-agent process started",
  );
}

export function logInboundTrace(params: {
  correlationId?: string;
  messageId: string;
  jid: string;
  fromMe: boolean;
  messageType: string;
  decision: InboundDecision;
}): void {
  const record = {
    event: "whatsapp_inbound",
    processInstanceId,
    correlationId: params.correlationId,
    messageIdHash: params.messageId ? shortHash(params.messageId) : null,
    jidHash: params.jid ? shortHash(params.jid) : null,
    fromMe: params.fromMe,
    messageType: params.messageType,
    decision: params.decision,
    timestamp: new Date().toISOString(),
  };
  logger.info(record, `whatsapp inbound: ${params.decision}`);
  inboundSink?.(record);
}

export function logSendTrace(params: {
  sendTraceId: string;
  source: SendSource;
  correlationId?: string;
  jid: string;
  whatsappMessageId: string | null;
}): void {
  const record = {
    event: "whatsapp_send",
    processInstanceId,
    sendTraceId: params.sendTraceId,
    source: params.source,
    correlationId: params.correlationId,
    recipientHash: params.jid ? shortHash(params.jid) : null,
    whatsappMessageId: params.whatsappMessageId,
    timestamp: new Date().toISOString(),
  };
  logger.info(record, `whatsapp send: ${params.source}`);
  sendSink?.(record);
}

export function logBlockedDuplicateReply(params: { correlationId: string | undefined; sendTraceId: string }): void {
  const record = {
    event: "blocked_duplicate_reply",
    processInstanceId,
    correlationId: params.correlationId,
    sendTraceId: params.sendTraceId,
    timestamp: new Date().toISOString(),
  };
  logger.warn(record, "blocked a second inbound_reply for a correlation already used");
  blockedSink?.(record);
}
