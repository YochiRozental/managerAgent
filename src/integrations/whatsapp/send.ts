import fs from "node:fs";
import { generateMessageID, type WASocket } from "@whiskeysockets/baileys";
import { logger } from "../../utils/logger.js";
import { getSocket, isReady } from "./connectionState.js";
import { markAsSentByBot } from "./client.js";

/**
 * נזרקת כש-WhatsApp לא מחובר כרגע (עדיין מתחבר / באמצע reconnect / logged-out). מסמנת לקוראים
 * (outboxDrainer בעיקר) שזה מצב זמני-צפוי ולא כשל אמיתי: אין טעם ב-retry פנימי, וההודעה צריכה
 * פשוט להישאר בתור עד שהחיבור חוזר.
 */
export class WhatsAppNotReadyError extends Error {
  constructor() {
    super("WhatsApp אינו מחובר כרגע");
    this.name = "WhatsAppNotReadyError";
  }
}

/**
 * שואב את ה-socket הפעיל *ברגע הקריאה* — לא reference שנשמר מראש — כדי שכל שולח ימשיך לעבוד
 * נכון גם אחרי reconnect (QR שפג, ניתוק זמני, "restart required"), בלי restart של התהליך.
 */
function requireReadySocket(): WASocket {
  const sock = getSocket();
  if (!sock || !isReady()) throw new WhatsAppNotReadyError();
  return sock;
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3, delayMs = 3000): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof WhatsAppNotReadyError) throw err; // לא retry — WhatsApp כבר לא מחובר, לא זמני
      logger.warn({ err, attempt, attempts }, `${label} נכשל, מנסה שוב`);
      if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/** Shows/clears the "typing…" indicator in the chat. Best-effort — never worth failing a reply over. */
export async function setTyping(jid: string, typing: boolean) {
  try {
    await requireReadySocket().sendPresenceUpdate(typing ? "composing" : "paused", jid);
  } catch (err) {
    logger.warn({ err }, "עדכון סטטוס 'מקליד/ה' נכשל");
  }
}

export async function sendText(jid: string, text: string) {
  if (!isReady()) throw new WhatsAppNotReadyError();
  const messageId = generateMessageID();
  // נרשם *לפני* השליחה בפועל, לא אחרי ה-await — סוגר את המירוץ מול ה-echo שהשרת של WhatsApp
  // שולח בחזרה על ההודעה שלנו (type:"notify", fromMe:true, אותו message id — פרוטוקול
  // multi-device sync). אם ה-echo מגיע לפני שנרשם ה-id, הבוט "שומע" את התשובה של עצמו כאילו
  // זו הודעה חדשה מהמשתמש — זה שורש לולאת התשובות האינסופית.
  markAsSentByBot(messageId, jid, text);
  const sent = await withRetry("שליחת טקסט", () =>
    requireReadySocket().sendMessage(jid, { text }, { messageId }),
  );
  markAsSentByBot(sent?.key.id, jid, text);
}

export async function sendVoiceNote(jid: string, oggFilePath: string) {
  if (!isReady()) throw new WhatsAppNotReadyError();
  const audio = fs.readFileSync(oggFilePath);
  const messageId = generateMessageID();
  markAsSentByBot(messageId, jid); // ראו הערה ב-sendText — נרשם לפני השליחה, לא אחריה
  const sent = await withRetry("שליחת הודעת קול", () =>
    requireReadySocket().sendMessage(jid, { audio, mimetype: "audio/ogg; codecs=opus", ptt: true }, { messageId }),
  );
  markAsSentByBot(sent?.key.id, jid);
}
