import type { WASocket } from "@whiskeysockets/baileys";
import { createPendingAction, getOpenPendingAction, resolvePendingAction } from "../db/repositories/pendingActions.js";
import { resolveUserByWhatsappJid, type IdentifiedUser } from "../identity/index.js";
import { runOrchestrator, type ConversationMessage } from "../integrations/claude/orchestrator.js";
import { getTool } from "../integrations/claude/tools.js";
import { synthesizeHebrewVoiceNote } from "../integrations/tts/edgeTts.js";
import { sendText, sendVoiceNote, setTyping } from "../integrations/whatsapp/send.js";
import { logger } from "../utils/logger.js";
import { classifyConfirmation, describeAction } from "./confirmation.js";

const MAX_HISTORY = 20;
const conversations = new Map<string, ConversationMessage[]>();

async function sendReply(sock: WASocket, jid: string, text: string, alsoVoice: boolean) {
  await sendText(sock, jid, text);
  if (!alsoVoice) return;
  try {
    const oggPath = await synthesizeHebrewVoiceNote(text);
    await sendVoiceNote(sock, jid, oggPath);
  } catch (err) {
    logger.error(err, "סינתזת קול נכשלה, נשלח טקסט בלבד");
  }
}

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
    await tool.execute(JSON.parse(pending.toolInput));
    reply = `בוצע ✅ (${pending.draftText})`;
  } catch (err) {
    logger.error(err, "ביצוע פעולה מאושרת נכשל");
    reply = `הפעולה נכשלה: ${(err as Error).message}`;
  }
  resolvePendingAction(pending.id, "confirmed");
  history.push({ role: "assistant", content: reply });
  return reply;
}

async function processIncomingMessage(sock: WASocket, jid: string, text: string, isVoiceOrigin: boolean) {
  await setTyping(sock, jid, true);
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
      await sendReply(sock, jid, pendingReply, isVoiceOrigin);
      logger.info({ jid, reply: pendingReply }, "תשובה נשלחה (אישור/ביטול פעולה)");
      return;
    }

    history.push({ role: "user", content: text });

    logger.info({ jid, text, user: user?.key ?? "unidentified" }, "מעבד הודעה נכנסת");
    const result = await runOrchestrator(history, user);

    if (result.type === "confirm") {
      const draft = describeAction(result.toolName, result.input);
      createPendingAction(jid, result.toolName, result.input, draft);
      history.push({ role: "assistant", content: `מציע לבצע: ${draft}\n\n(ממתין לאישור המשתמש - כן/לא)` });
      conversations.set(jid, history.slice(-MAX_HISTORY));
      await sendReply(sock, jid, `${draft}\n\nלאשר? (כן / לא)`, isVoiceOrigin);
      logger.info({ jid, toolName: result.toolName }, "טיוטת אישור נשלחה, ממתין לתשובה");
      return;
    }

    history.push({ role: "assistant", content: result.text });
    conversations.set(jid, history.slice(-MAX_HISTORY));

    if (result.text) {
      await sendReply(sock, jid, result.text, isVoiceOrigin);
      logger.info({ jid, reply: result.text }, "תשובה נשלחה");
    } else {
      logger.warn({ jid }, "לא נוצרה תשובה לשליחה");
    }
  } finally {
    await setTyping(sock, jid, false);
  }
}

/**
 * A failure anywhere in here (Monday/Google/Claude API, or a WhatsApp send that exhausts its
 * retries) must never become an unhandled rejection — that used to crash the whole process on
 * every hiccup, which could silently swallow a reply that had already been composed. Errors are
 * caught, logged, and best-effort reported to the user instead.
 *
 * But if even the fallback error message can't be sent, sendText has already retried it 3 times
 * with backoff on top of whatever failed originally — that's not a hiccup, it means the socket
 * itself is wedged (seen in practice: Baileys stuck logging "timed out waiting for message" every
 * few seconds for hours, without ever firing the "connection closed" event our reconnect logic
 * listens for). No amount of catching fixes a dead socket, so exit and let Docker's
 * `restart: unless-stopped` bring up a fresh process that reconnects cleanly.
 */
export async function handleIncomingMessage(sock: WASocket, jid: string, text: string, isVoiceOrigin = false) {
  try {
    await processIncomingMessage(sock, jid, text, isVoiceOrigin);
  } catch (err) {
    logger.error(err, "טיפול בהודעה נכשל");
    try {
      await sendText(sock, jid, "משהו השתבש אצלי בטיפול בהודעה - אפשר לנסות שוב?");
    } catch (sendErr) {
      logger.error(sendErr, "גם שליחת הודעת השגיאה נכשלה — כנראה החיבור לוואטסאפ תקוע, מפעיל מחדש");
      process.exit(1);
    }
  }
}
