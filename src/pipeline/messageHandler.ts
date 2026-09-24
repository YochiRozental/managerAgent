import { createPendingAction, getOpenPendingAction, resolvePendingAction } from "../db/repositories/pendingActions.js";
import { resolveUserByWhatsappJid, type IdentifiedUser } from "../identity/index.js";
import { runOrchestrator, type ConversationMessage } from "../integrations/claude/orchestrator.js";
import { getTool } from "../integrations/claude/tools.js";
import { synthesizeHebrewVoiceNote } from "../integrations/tts/edgeTts.js";
import { normalizeJid } from "../integrations/whatsapp/jid.js";
import { consumeCorrelationForReply, InvalidCorrelationError } from "../integrations/whatsapp/replyCorrelation.js";
import { sendText, sendVoiceNote, setTyping, WhatsAppNotReadyError } from "../integrations/whatsapp/send.js";
import { logBlockedDuplicateReply, newSendTraceId } from "../integrations/whatsapp/trace.js";
import { logger } from "../utils/logger.js";
import { classifyConfirmation, describeAction } from "./confirmation.js";

const MAX_HISTORY = 20;
const conversations = new Map<string, ConversationMessage[]>();

/**
 * לכל היותר עיבוד אחד בכל רגע לכל jid — invariant מבני, לא heuristic: אין מצב שבו שתי קריאות
 * חופפות ל-handleIncomingMessage עבור אותו jid מייצרות שתי תשובות "במקביל" (מה שהיה יכול לבלבל
 * את היסטוריית השיחה גם בלי קשר לבעיית ה-echo). handleIncomingMessage הוא נקודת הכניסה היחידה
 * ל-orchestrator מ-WhatsApp (מגיעה רק מ-client.ts's guardedForward, אחרי כל שכבות הסינון) —
 * כל תשובה, לכן, ניתנת למעקב (correlationId) עד להודעת קלט אמיתית אחת שהתקבלה בזמן שהג'יד היה
 * פנוי, ואף פעם לא מהתשובה של הבוט עצמו. מפתח מנורמל (normalizeJid) — לא raw jid — כדי שסטיית
 * ייצוג jid (device suffix, @c.us) לא תיצור "שני jid-ים" מלאכותיים שחומקים מהנעילה הזו.
 */
const processingJids = new Set<string>();

/**
 * נקודת השער היחידה לתשובה אוטומטית (category A): צורכת את ה-correlation *לפני* השליחה —
 * פעם אחת בדיוק לכל correlation. אם הוא לא תקף/כבר נוצל, consumeCorrelationForReply זורק
 * InvalidCorrelationError — זו האכיפה בפועל של "לכל היותר תשובה אחת per inbound" (Section 7):
 * ניסיון שני נחסם *בשקט* (נרשם blocked_duplicate_reply, לא נשלח כלום, ולא זולג ל-catch הכללי
 * ב-handleIncomingMessage — אחרת היה יכול לצאת "משהו השתבש" כתשובה שנייה בפועל). תשובת קול היא
 * חלק מאותה תשובה (sendTraceId נפרד משלה, אותו correlationId — לא צריכה guard משלה).
 */
async function sendReply(jid: string, text: string, alsoVoice: boolean, correlationId: string | undefined) {
  const sendTraceId = newSendTraceId();
  try {
    consumeCorrelationForReply(correlationId);
  } catch (err) {
    if (err instanceof InvalidCorrelationError) {
      logBlockedDuplicateReply({ correlationId, sendTraceId });
      return;
    }
    throw err;
  }
  await sendText(jid, text, { source: "inbound_reply", correlationId, sendTraceId });
  if (!alsoVoice) return;
  try {
    const oggPath = await synthesizeHebrewVoiceNote(text);
    await sendVoiceNote(jid, oggPath, { source: "inbound_reply", correlationId, sendTraceId: newSendTraceId() });
  } catch (err) {
    logger.error(err, "סינתזת קול נכשלה, נשלח טקסט בלבד");
  }
}

/** לבדיקות בלבד — sendReply הוא ה-gate האמיתי של category A; חשוף כאן כדי לבדוק אותו ישירות. */
export const _sendReplyForTests = sendReply;

/**
 * Resolves an open pending confirmation, if any, and returns the reply to send — or null if
 * there was none (or the reply was inconclusive, in which case the message falls through to be
 * handled normally). Always mutates `history` so later turns have accurate context; forgetting to
 * record what happened here previously caused stale, already-resolved drafts to keep resurfacing.
 */
async function handlePendingConfirmation(
  jid: string,
  text: string,
  history: ConversationMessage[],
  user: IdentifiedUser | null,
): Promise<string | null> {
  const pending = getOpenPendingAction(jid);
  if (!pending) return null;

  const decision = classifyConfirmation(text);

  if (decision === "unclear") {
    // Don't get stuck re-asking forever: if the reply isn't a clear yes/no, treat it as the user
    // moving on to something else. Record that the old draft was dropped so it doesn't keep
    // resurfacing, then let the message fall through to be handled normally.
    logger.info({ jid, pendingId: pending.id }, "תשובה לא ברורה לפעולה ממתינה — מבטל אותה ומטפל בהודעה כרגיל");
    resolvePendingAction(pending.id, "cancelled");
    history.push({ role: "assistant", content: `[ההצעה הקודמת (${pending.draftText}) בוטלה כי לא התקבל אישור ברור]` });
    return null;
  }

  history.push({ role: "user", content: text });

  if (decision === "cancel") {
    resolvePendingAction(pending.id, "cancelled");
    const reply = "בסדר, ביטלתי. לא בוצע כלום.";
    history.push({ role: "assistant", content: reply });
    return reply;
  }

  const tool = getTool(pending.toolName);
  let reply: string;
  try {
    if (!tool) throw new Error(`כלי לא ידוע: ${pending.toolName}`);
    // בדיקת הרשאה חוזרת רגע לפני הביצוע — הטיוטה נוצרה קודם, והמצב יכול היה להשתנות.
    if (tool.requiredPermission && !(user?.permissions.includes(tool.requiredPermission) ?? false)) {
      throw new Error("אין לך הרשאה לבצע את הפעולה הזו");
    }
    await tool.execute(JSON.parse(pending.toolInput), { user });
    reply = `בוצע ✅ (${pending.draftText})`;
  } catch (err) {
    logger.error(err, "ביצוע פעולה מאושרת נכשל");
    reply = `הפעולה נכשלה: ${(err as Error).message}`;
  }
  resolvePendingAction(pending.id, "confirmed");
  history.push({ role: "assistant", content: reply });
  return reply;
}

async function processIncomingMessage(jid: string, text: string, isVoiceOrigin: boolean, correlationId: string | undefined) {
  await setTyping(jid, true);
  try {
    const history = conversations.get(jid) ?? [];

    // זהות → תפקיד → הרשאות. אם ה-JID עבר את שער ALLOWED_WHATSAPP_JIDS אך אינו בספר הצוות,
    // נזהה כ-null וה-orchestrator לא יבצע פעולות ולא יחשוף מידע.
    const user = resolveUserByWhatsappJid(jid);
    if (!user) {
      logger.warn({ jid }, "JID מורשה אך לא מזוהה בספר הצוות — עונה בלי הרשאות");
    }

    const pendingReply = await handlePendingConfirmation(jid, text, history, user);
    if (pendingReply !== null) {
      conversations.set(jid, history.slice(-MAX_HISTORY));
      await sendReply(jid, pendingReply, isVoiceOrigin, correlationId);
      logger.info({ jid }, "תשובה נשלחה (אישור/ביטול פעולה)");
      return;
    }

    history.push({ role: "user", content: text });

    logger.info({ jid, user: user?.key ?? "unidentified" }, "מעבד הודעה נכנסת");
    const result = await runOrchestrator(history, user);

    if (result.type === "confirm") {
      const draft = describeAction(result.toolName, result.input);
      createPendingAction(jid, result.toolName, result.input, draft);
      history.push({ role: "assistant", content: `מציע לבצע: ${draft}\n\n(ממתין לאישור המשתמש - כן/לא)` });
      conversations.set(jid, history.slice(-MAX_HISTORY));
      await sendReply(jid, `${draft}\n\nלאשר? (כן / לא)`, isVoiceOrigin, correlationId);
      logger.info({ jid, toolName: result.toolName }, "טיוטת אישור נשלחה, ממתין לתשובה");
      return;
    }

    history.push({ role: "assistant", content: result.text });
    conversations.set(jid, history.slice(-MAX_HISTORY));

    if (result.text) {
      await sendReply(jid, result.text, isVoiceOrigin, correlationId);
      logger.info({ jid }, "תשובה נשלחה");
    } else {
      logger.warn({ jid }, "לא נוצרה תשובה לשליחה");
    }
  } finally {
    await setTyping(jid, false);
  }
}

/**
 * A failure anywhere in here (Monday/Google/Claude API, or a WhatsApp send that exhausts its
 * retries) must never become an unhandled rejection — that used to crash the whole process on
 * every hiccup, which could silently swallow a reply that had already been composed. Errors are
 * caught, logged, and best-effort reported to the user instead.
 *
 * If WhatsApp is merely disconnected right now (WhatsAppNotReadyError — mid-reconnect, QR expired,
 * a transient network blip), that's expected and self-heals via client.ts's own reconnect logic —
 * exiting the process here would defeat the whole point of pulling the live socket at send time.
 * But if the send genuinely failed while the socket was supposedly ready (sendText already retried
 * 3 times with backoff), that means the socket itself is wedged (seen in practice: Baileys stuck
 * logging "timed out waiting for message" for hours without ever firing "connection closed"). No
 * amount of catching fixes a truly dead-but-reports-open socket, so exit and let Docker's
 * `restart: unless-stopped` bring up a fresh process.
 */
export async function handleIncomingMessage(
  jid: string,
  text: string,
  isVoiceOrigin = false,
  correlationId?: string,
) {
  const lockKey = normalizeJid(jid);
  if (processingJids.has(lockKey)) {
    // לא אמור לקרות בזרימה תקינה (guardedForward כבר ממתן קצב, ו-Node מריץ callbacks של אירוע
    // בודד ברצף) — אם זה בכל זאת קורה, עדיף לדלג מאשר לייצר שתי תשובות חופפות לאותו jid.
    logger.warn({ jid, correlationId }, "עיבוד חופף לאותו jid — מדלג, לא יוצר תשובה נוספת");
    return;
  }
  processingJids.add(lockKey);
  const log = correlationId ? logger.child({ correlationId }) : logger;
  try {
    log.info({ jid }, "מטפל בהודעה נכנסת (מקור אמיתי, לא echo)");
    await processIncomingMessage(jid, text, isVoiceOrigin, correlationId);
  } catch (err) {
    logger.error(err, "טיפול בהודעה נכשל");
    try {
      // לא צורכים correlation נוסף כאן: אם sendReply כבר רץ ונכשל, ה"ניסיון" (השלישייה של
      // withRetry) כבר נוצל — הודעת השגיאה הזו היא הדיווח על אותו ניסיון בודד, לא תשובה שנייה.
      // אם sendReply אף לא הופעל (למשל runOrchestrator עצמו נכשל) — זו התשובה היחידה שתישלח
      // ל-inbound הזה. processingJids כבר מבטיח שהפעולה הזו לא יכולה לרוץ פעמיים במקביל.
      await sendText(jid, "משהו השתבש אצלי בטיפול בהודעה - אפשר לנסות שוב?", { source: "inbound_error", correlationId });
    } catch (sendErr) {
      if (sendErr instanceof WhatsAppNotReadyError) {
        logger.warn({ jid }, "WhatsApp לא מחובר כרגע — לא ניתן לשלוח הודעת שגיאה, מוותרים על התשובה הזו");
        return;
      }
      logger.error(sendErr, "גם שליחת הודעת השגיאה נכשלה — כנראה החיבור לוואטסאפ תקוע, מפעיל מחדש");
      process.exit(1);
    }
  } finally {
    processingJids.delete(lockKey);
  }
}
