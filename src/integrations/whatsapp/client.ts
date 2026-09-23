import fs from "node:fs";
import path from "node:path";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { logger } from "../../utils/logger.js";
import { setSocket, setState } from "./connectionState.js";

export { getSocket, getConnectionState, isReady } from "./connectionState.js";

const AUTH_DIR = "auth/whatsapp";
const VOICE_DIR = "data/voice";
export const QR_IMAGE_PATH = "data/whatsapp-qr.png";

export type MessageHandler = (jid: string, text: string) => void;
export type VoiceMessageHandler = (jid: string, audioFilePath: string) => void;

/**
 * IDs of messages the bot itself just sent, so self-chat commands (fromMe=true, typed by the
 * human from their phone) can still be processed while the bot's own replies are not treated
 * as new incoming commands (which would otherwise cause an infinite reply loop).
 *
 * WhatsApp's server echoes every message we send back to us over the same socket, tagged
 * fromMe:true and type:"notify" (the multi-device-sync mechanism that lets a linked phone/Web
 * session show messages sent from other own devices) — with the *same* message id. If that echo
 * arrives before the id lands here, the bot "hears" its own reply as fresh user input and answers
 * it, which answers itself again, etc. send.ts now registers the id *before* calling
 * sock.sendMessage (not after awaiting it), which closes that race — see markAsSentByBot's jid+text
 * params below for a second, content-based layer of defense that doesn't depend on id matching.
 */
const recentlySentIds = new Set<string>();

interface SentRecord {
  text: string;
  at: number;
}
const ECHO_TEXT_WINDOW_MS = 30_000;
const recentlySentByJid = new Map<string, SentRecord[]>();

export function markAsSentByBot(id: string | null | undefined, jid?: string, text?: string) {
  if (id) {
    recentlySentIds.add(id);
    setTimeout(() => recentlySentIds.delete(id), 60_000);
  }
  if (jid && text) {
    const cutoff = Date.now() - ECHO_TEXT_WINDOW_MS;
    const list = (recentlySentByJid.get(jid) ?? []).filter((r) => r.at >= cutoff);
    list.push({ text, at: Date.now() });
    recentlySentByJid.set(jid, list);
  }
}

/** שכבת הגנה שנייה, בלתי-תלויה ב-id: האם הטקסט הזה משהו שהבוט עצמו שלח ל-jid הזה ממש עכשיו. */
function isOwnRecentEcho(jid: string, text: string): boolean {
  const cutoff = Date.now() - ECHO_TEXT_WINDOW_MS;
  const list = recentlySentByJid.get(jid);
  if (!list) return false;
  const fresh = list.filter((r) => r.at >= cutoff);
  if (fresh.length) recentlySentByJid.set(jid, fresh);
  else recentlySentByJid.delete(jid);
  return fresh.some((r) => r.text === text);
}

/**
 * מזהים של הודעות (נכנסות *או* יוצאות) שכבר טופלו — בלי קשר ל-fromMe. WhatsApp/Baileys יכולים
 * לספק את אותה הודעה פעמיים ב-messages.upsert (redelivery בפרוטוקול, resync אחרי reconnect) —
 * זה לא קשור ל-echo של הבוט על עצמו, אבל גם הוא יכול להפעיל את ה-orchestrator פעמיים על אותה
 * הודעה אנושית. TTL ארוך יחסית (10 דק') כדי לכסות חלון resync סביר בלי לצמוח בלי גבול.
 */
const PROCESSED_ID_TTL_MS = 10 * 60_000;
const processedMessageIds = new Set<string>();

function alreadyProcessed(id: string): boolean {
  return !!id && processedMessageIds.has(id);
}

function markProcessed(id: string) {
  if (!id) return;
  processedMessageIds.add(id);
  setTimeout(() => processedMessageIds.delete(id), PROCESSED_ID_TTL_MS);
}

/**
 * רשת ביטחון קשה, בלתי-תלויה בכל מנגנון זיהוי-echo: בלי קשר לשאלה *למה* הודעה חזרה כקלט (id,
 * תוכן, או מנגנון שלא חשבנו עליו) — אם יותר מ-MAX_FORWARDS_PER_WINDOW הודעות "חדשות" מגיעות
 * מאותו jid בתוך BREAKER_WINDOW_MS, זה לא בן-אדם מקליד, וממשיכים לפני שנפתחת לולאה בלתי חסומה.
 */
const BREAKER_WINDOW_MS = 20_000;
const MAX_FORWARDS_PER_WINDOW = 4;
const BREAKER_COOLDOWN_MS = 2 * 60_000;
const forwardTimestamps = new Map<string, number[]>();
const breakerTrippedUntil = new Map<string, number>();

function guardedForward(jid: string, text: string, forward: MessageHandler) {
  const now = Date.now();
  const trippedUntil = breakerTrippedUntil.get(jid);
  if (trippedUntil) {
    if (now < trippedUntil) {
      logger.warn({ jid }, "מגן fail-safe פעיל — מתעלם מהודעה עד שהצינון מסתיים");
      return;
    }
    breakerTrippedUntil.delete(jid);
  }

  const timestamps = (forwardTimestamps.get(jid) ?? []).filter((t) => now - t < BREAKER_WINDOW_MS);
  timestamps.push(now);

  if (timestamps.length > MAX_FORWARDS_PER_WINDOW) {
    forwardTimestamps.delete(jid);
    breakerTrippedUntil.set(jid, now + BREAKER_COOLDOWN_MS);
    logger.error(
      { jid, count: timestamps.length, windowMs: BREAKER_WINDOW_MS },
      "⚠️ מגן fail-safe הופעל: יותר מדי הודעות בזמן קצר מאותו jid — נראה כמו לולאת תשובות. מפסיק להגיב לג'יד הזה לכמה דקות",
    );
    return;
  }

  forwardTimestamps.set(jid, timestamps);
  forward(jid, text);
}

let socketPromise: Promise<WASocket> | null = null;

const HEALTH_CHECK_INTERVAL_MS = 3 * 60 * 1000;
const HEALTH_CHECK_TIMEOUT_MS = 15_000;

/**
 * Baileys doesn't always fire a clean "close" event when the connection dies — it's been observed
 * staying "open" while every operation silently times out for hours (Baileys logging "timed out
 * waiting for message" internally on a loop), never triggering our reconnect logic in
 * connection.update. A quiet WhatsApp bot is otherwise invisible until someone happens to message
 * it and notices no reply, so this proactively probes the connection every few minutes with a
 * trivial operation; if that hangs or throws, the socket is dead and no amount of retrying inside
 * it will help — exit and let Docker's `restart: unless-stopped` bring up a fresh one.
 */
function startHealthWatchdog(sock: WASocket): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      try {
        await Promise.race([
          sock.sendPresenceUpdate("available"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("health check timed out")), HEALTH_CHECK_TIMEOUT_MS)),
        ]);
      } catch (err) {
        logger.error(err, "בדיקת תקינות תקופתית לחיבור הוואטסאפ נכשלה — נראה שהחיבור תקוע, מפעיל מחדש");
        process.exit(1);
      }
    })();
  }, HEALTH_CHECK_INTERVAL_MS);
}

async function downloadVoiceNote(sock: WASocket, msg: Parameters<typeof downloadMediaMessage>[0]): Promise<string> {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const buffer = (await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage })) as Buffer;
  const filePath = path.join(VOICE_DIR, `${msg.key.id ?? Date.now()}.ogg`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

type UpsertMessage = Parameters<typeof downloadMediaMessage>[0];

/**
 * מטפל באירוע messages.upsert בודד — exported בנפרד מ-connectWhatsApp כדי שאפשר יהיה לבדוק אותו
 * ישירות (הודעות מדומות, בלי socket/חיבור אמיתי): הודעה נכנסת אמיתית → onMessage; echo של הבוט
 * על עצמו (id או תוכן) → מדולג; הודעה (כלשהי) שכבר טופלה → מדולגת; יותר מדי הודעות "חדשות"
 * מאותו jid בזמן קצר → guardedForward עוצר (רשת הביטחון מפני לולאה).
 */
export function handleMessagesUpsert(
  update: { messages: UpsertMessage[]; type: string },
  sock: WASocket,
  onMessage?: MessageHandler,
  onVoiceMessage?: VoiceMessageHandler,
): void {
  if (update.type !== "notify") return;
  for (const msg of update.messages) {
    const id = msg.key.id ?? "";
    if (alreadyProcessed(id)) continue; // upsert כפול / redelivery — טופלה כבר

    // Prefer the phone-number JID (remoteJidAlt) over the @lid form when available — replying
    // to a fresh contact's @lid address can throw inside Baileys before its LID<->PN mapping
    // has synced, while the phone-number JID works immediately.
    const jid = msg.key.remoteJidAlt ?? msg.key.remoteJid;
    if (!jid) continue;

    const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "";

    if (msg.key.fromMe) {
      // fromMe:true covers two very different things: (a) the bot's own reply, echoed back
      // by WhatsApp's server for multi-device sync — must NEVER be treated as input, that's
      // the infinite-loop bug; (b) a command the account owner typed from another linked
      // device into the same self-chat — a real, wanted input. id-match is the primary
      // signal (race-free now that send.ts registers it before sending); text-match is a
      // second, id-independent layer in case Baileys ever surfaces the echo differently.
      if (recentlySentIds.has(id) || (text && isOwnRecentEcho(jid, text))) continue;
    }

    if (text && onMessage) {
      if (id) markProcessed(id);
      guardedForward(jid, text, onMessage);
      continue;
    }

    if (msg.message?.audioMessage && onVoiceMessage) {
      if (id) markProcessed(id);
      void downloadVoiceNote(sock, msg)
        .then((filePath) => onVoiceMessage(jid, filePath))
        .catch((err) => logger.error(err, "הורדת הודעת קול נכשלה"));
    }
  }
}

export async function connectWhatsApp(
  onMessage?: MessageHandler,
  onVoiceMessage?: VoiceMessageHandler,
): Promise<WASocket> {
  if (socketPromise) return socketPromise;

  socketPromise = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[whatsapp] using WA web version ${version.join(".")} (latest: ${isLatest})`);

    const sock = makeWASocket({
      auth: state,
      version,
    });

    // מרגע זה getSocket() משקף את המופע הזה — לפני שנרשם אף listener ולפני שהחיבור "open" בפועל,
    // כדי שאף שולח לא ימשיך להחזיק socket ישן אחרי שהתחיל reconnect.
    setSocket(sock, "connecting");

    sock.ev.on("creds.update", saveCreds);

    let watchdogInterval: NodeJS.Timeout | null = null;

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("[whatsapp] new QR code issued");
        logger.info("סרוק/י את קוד ה-QR עם WhatsApp Business → מכשירים מקושרים → קישור מכשיר:");
        qrcode.generate(qr, { small: true });
        void QRCode.toFile(QR_IMAGE_PATH, qr, { width: 400 }).then(
          () => console.log(`[whatsapp] QR image saved: ${QR_IMAGE_PATH}`),
          (err) => console.error("[whatsapp] failed to save QR image", err),
        );
      }

      if (connection === "close") {
        // מיד — לפני החלטת reconnect/logged-out — כדי שכל שולח שקורא ל-isReady() מהרגע הזה
        // יקבל false ולא ינסה לשלוח על socket שכבר לא חי.
        setState("closed");
        if (watchdogInterval) {
          clearInterval(watchdogInterval);
          watchdogInterval = null;
        }
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log(`[whatsapp] connection closed, statusCode=${statusCode} loggedOut=${loggedOut}`);
        if (lastDisconnect?.error) console.error("[whatsapp] disconnect error:", lastDisconnect.error);
        logger.warn({ statusCode, loggedOut }, "החיבור לוואטסאפ נסגר");
        if (!loggedOut) {
          socketPromise = null;
          void connectWhatsApp(onMessage, onVoiceMessage);
        } else {
          logger.error("נותקת מהחשבון — מחק/י את תיקיית auth/whatsapp וסרוק/י QR מחדש");
        }
      } else if (connection === "open") {
        console.log("[whatsapp] connected!");
        logger.info("מחובר/ת לוואטסאפ ✅");
        setState("open");
        if (watchdogInterval) clearInterval(watchdogInterval);
        watchdogInterval = startHealthWatchdog(sock);
      }
    });

    if (onMessage || onVoiceMessage) {
      sock.ev.on("messages.upsert", (update) => handleMessagesUpsert(update, sock, onMessage, onVoiceMessage));
    }

    return sock;
  })();

  return socketPromise;
}
