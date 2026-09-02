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

const AUTH_DIR = "auth/whatsapp";
const VOICE_DIR = "data/voice";
export const QR_IMAGE_PATH = "data/whatsapp-qr.png";

export type MessageHandler = (jid: string, text: string) => void;
export type VoiceMessageHandler = (jid: string, audioFilePath: string) => void;

/**
 * IDs of messages the bot itself just sent, so self-chat commands (fromMe=true, typed by the
 * human from their phone) can still be processed while the bot's own replies are not treated
 * as new incoming commands (which would otherwise cause an infinite reply loop).
 */
const recentlySentIds = new Set<string>();

export function markAsSentByBot(id: string | null | undefined) {
  if (!id) return;
  recentlySentIds.add(id);
  setTimeout(() => recentlySentIds.delete(id), 60_000);
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
        if (watchdogInterval) clearInterval(watchdogInterval);
        watchdogInterval = startHealthWatchdog(sock);
      }
    });

    if (onMessage || onVoiceMessage) {
      sock.ev.on("messages.upsert", ({ messages, type }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
          if (msg.key.fromMe && recentlySentIds.has(msg.key.id ?? "")) continue;
          // Prefer the phone-number JID (remoteJidAlt) over the @lid form when available — replying
          // to a fresh contact's @lid address can throw inside Baileys before its LID<->PN mapping
          // has synced, while the phone-number JID works immediately.
          const jid = msg.key.remoteJidAlt ?? msg.key.remoteJid;
          if (!jid) continue;

          const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "";
          if (text && onMessage) {
            onMessage(jid, text);
            continue;
          }

          if (msg.message?.audioMessage && onVoiceMessage) {
            void downloadVoiceNote(sock, msg)
              .then((filePath) => onVoiceMessage(jid, filePath))
              .catch((err) => logger.error(err, "הורדת הודעת קול נכשלה"));
          }
        }
      });
    }

    return sock;
  })();

  return socketPromise;
}
