import fs from "node:fs";
import path from "node:path";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { logger } from "../../utils/logger.js";
import { setSocket, setState } from "./connectionState.js";
import { createInboundCorrelation } from "./replyCorrelation.js";

export { getSocket, getConnectionState, isReady } from "./connectionState.js";

const AUTH_DIR = "auth/whatsapp";
const VOICE_DIR = "data/voice";
export const QR_IMAGE_PATH = "data/whatsapp-qr.png";

export type MessageMeta = { correlationId: string };
export type MessageHandler = (jid: string, text: string, meta?: MessageMeta) => void;
export type VoiceMessageHandler = (jid: string, audioFilePath: string) => void;

/**
 * INVARIANT: OUTBOUND FROM THIS WHATSAPP ACCOUNT CAN NEVER BECOME AI INPUT.
 *
 * Earlier attempts tried to *distinguish* the bot's own echo from a genuine fromMe:true self-chat
 * command (by message id, then by jid+content, then by a timing blackout) — and each was proven
 * insufficient in production: WhatsApp's multi-device sync can re-wrap our sent message
 * (deviceSentMessage) with a server-assigned stanza id (decode-wa-message.js: `msgId =
 * stanza.attrs.id`) unrelated to what we sent, and/or a different jid representation (@lid vs
 * @s.whatsapp.net, device suffix) — so no combination of id/jid/content/timing matching can be
 * trusted as the *primary* boundary. `fromMe` itself, unlike those, is not in question — it's
 * Baileys' own reliable signal for "this message's sender is our account" (decode-wa-message.js:
 * `isMe(from)/isMeLid(from)`). So handleMessagesUpsert below drops *every* fromMe:true message
 * unconditionally, before any dedup/breaker/correlation logic even runs — a boolean partition,
 * not a heuristic. The deliberate cost: self-chat commands (typed from another device linked to
 * this same WhatsApp account) are no longer processed — see handleMessagesUpsert's comment. Real
 * traffic (team members, clients) is unaffected: they're always a different WhatsApp account than
 * this one, so always fromMe:false.
 */
function normalizedJid(jid: string): string {
  try {
    return jidNormalizedUser(jid) || jid;
  } catch {
    return jid;
  }
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
 * רשת ביטחון per-jid, בלתי-תלויה בכל מנגנון זיהוי-echo: בלי קשר לשאלה *למה* הודעה חזרה כקלט
 * (id, תוכן, או מנגנון שלא חשבנו עליו) — אם יותר מ-MAX_FORWARDS_PER_WINDOW הודעות "חדשות"
 * מגיעות מאותו jid בתוך BREAKER_WINDOW_MS, זה לא בן-אדם מקליד.
 *
 * זו לא ההגנה היחידה: אם echo-ים "מתפזרים" בין ייצוגי jid שונים (@lid מול @s.whatsapp.net,
 * device suffix) — בדיוק מה שקרה ב-production — מונה per-jid יכול לא להצטבר מעבר ל-1-2 לכל
 * וריאציה, ולא להידלק כלל. GLOBAL_MAX_FORWARDS למטה הוא הרשת שלא תלויה בזהות ה-jid בכלל.
 */
const BREAKER_WINDOW_MS = 20_000;
const MAX_FORWARDS_PER_WINDOW = 4;
const BREAKER_COOLDOWN_MS = 2 * 60_000;
const forwardTimestamps = new Map<string, number[]>();
const breakerTrippedUntil = new Map<string, number>();

/**
 * רשת ביטחון גלובלית — סופרת על פני *כל* ה-jid-ים יחד, כי jid בודד אינו סימן אמין (ראו מעלה).
 * אם היא נדלקת, זה סימן שמשהו במערכת מזין את עצמו בחזרה — לא "עומס גבוה מהרגיל".
 *
 * לא process.exit: whatsapp-agent רץ עם `restart: unless-stopped` (docker-compose.yml). אם מה
 * שהדליק את המגן הוא קלט חוזר/מתמשך (למשל היסטוריה שמסתנכרנת שוב בכל reconnect) — יציאה+עלייה
 * מחדש עלולה להיתקל *באותה* תקלה תוך שניות ולהיכנס ל-restart loop של Docker (backoff מתחיל
 * ~100ms), שגרוע לא פחות מהבעיה המקורית: ניתוקים חזרתיים מ-WhatsApp, לא רק תשובות כפולות.
 * במקום זה: halt מלא בזיכרון — מפסיק להעביר *כל* הודעה חדשה לorchestrator, על כל jid, לזמן
 * ארוך בכוונה (GLOBAL_HALT_MS), בלי לנתק את הסוקט או להפיל את התהליך. `/health`/הלוגים חושפים
 * את זה (רמת error), וההתאוששות היחידה בזמן ה-halt היא ידנית (restart מכוון) או המתנה לפקיעתו.
 */
const GLOBAL_BREAKER_WINDOW_MS = 15_000;
const GLOBAL_MAX_FORWARDS = 8;
const GLOBAL_HALT_MS = 30 * 60_000;
let globalForwardTimestamps: number[] = [];
let globalHaltUntil = 0;

/** לבדיקות בלבד — מאפס את כל מצב הזיכרון (dedup/breaker/halt) בין תרחישי טסט עצמאיים. */
export function _resetStateForTests(): void {
  processedMessageIds.clear();
  forwardTimestamps.clear();
  breakerTrippedUntil.clear();
  globalForwardTimestamps = [];
  globalHaltUntil = 0;
}

export function isGloballyHalted(): boolean {
  return Date.now() < globalHaltUntil;
}

function guardedForward(jid: string, text: string, forward: MessageHandler) {
  const now = Date.now();
  const key = normalizedJid(jid);

  if (isGloballyHalted()) {
    logger.error({ jid: key }, "🚨 מגן fail-safe גלובלי פעיל — כל התשובות האוטומטיות מושהות, מתעלם מהודעה");
    return;
  }

  const freshGlobal = globalForwardTimestamps.filter((t) => now - t < GLOBAL_BREAKER_WINDOW_MS);
  freshGlobal.push(now);
  globalForwardTimestamps = freshGlobal;
  if (freshGlobal.length > GLOBAL_MAX_FORWARDS) {
    globalHaltUntil = now + GLOBAL_HALT_MS;
    logger.error(
      { count: freshGlobal.length, windowMs: GLOBAL_BREAKER_WINDOW_MS, haltMinutes: GLOBAL_HALT_MS / 60_000 },
      "🚨 מגן fail-safe גלובלי הופעל: יותר מדי הודעות 'חדשות' על פני כל ה-jid-ים תוך זמן קצר — לא תעבורה אנושית תקינה, נראה כמו לולאה. משהה תשובות אוטומטיות לכל ה-jid-ים (בלי restart)",
    );
    return;
  }

  const trippedUntil = breakerTrippedUntil.get(key);
  if (trippedUntil) {
    if (now < trippedUntil) {
      logger.warn({ jid: key }, "מגן fail-safe פעיל — מתעלם מהודעה עד שהצינון מסתיים");
      return;
    }
    breakerTrippedUntil.delete(key);
  }

  const timestamps = (forwardTimestamps.get(key) ?? []).filter((t) => now - t < BREAKER_WINDOW_MS);
  timestamps.push(now);

  if (timestamps.length > MAX_FORWARDS_PER_WINDOW) {
    forwardTimestamps.delete(key);
    breakerTrippedUntil.set(key, now + BREAKER_COOLDOWN_MS);
    logger.error(
      { jid: key, count: timestamps.length, windowMs: BREAKER_WINDOW_MS },
      "⚠️ מגן fail-safe הופעל: יותר מדי הודעות בזמן קצר מאותו jid — נראה כמו לולאת תשובות. מפסיק להגיב לג'יד הזה לכמה דקות",
    );
    return;
  }

  forwardTimestamps.set(key, timestamps);
  // רגע יצירת ה-correlation היחיד: אחרי שההודעה עברה את כל שכבות הסינון ואומתה כקלט אמיתי.
  // תגובה אוטומטית (messageHandler.ts's sendReply) תצטרך "לצרוך" אותו לפני שליחה — פעם אחת בדיוק.
  const correlationId = createInboundCorrelation(jid);
  forward(jid, text, { correlationId });
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
 * ישירות (הודעות מדומות, בלי socket/חיבור אמיתי). סדר הסינון קבוע ומכוון:
 *   1. type לא "notify" (history/offline sync וכו') → לא ממשיכים בכלל.
 *   2. fromMe:true → DROP IMMEDIATELY. לפני dedup, לפני breakers, לפני יצירת correlation —
 *      ה-invariant המרכזי: פלט של החשבון הזה לעולם לא יכול להפוך לקלט. אין יותר תמיכה בפקודות
 *      self-chat (fromMe:true ממכשיר מקושר אחר) — decision מוצרי מכוון, לא באג: אין ל-Baileys
 *      metadata אמין (id/jid) שמבדיל בין זה לבין ה-echo של הבוט על עצמו (multi-device sync,
 *      deviceSentMessage rewrap — ראו את התיעוד מעל normalizedJid). תעבורה אמיתית (עובדים/
 *      לקוחות) היא תמיד fromMe:false, כי הם חשבון WhatsApp אחר משל הבוט — לא נפגעת.
 *   3. dedup (alreadyProcessed) — upsert כפול/redelivery של אותה הודעה נכנסת אמיתית.
 *   4. breakers (בתוך guardedForward) — per-jid וגלובלי.
 *   5. יצירת correlation (בתוך guardedForward, אחרי כל השאר).
 *   6. forward ל-handler/orchestrator.
 */
export function handleMessagesUpsert(
  update: { messages: UpsertMessage[]; type: string },
  sock: WASocket,
  onMessage?: MessageHandler,
  onVoiceMessage?: VoiceMessageHandler,
): void {
  if (update.type !== "notify") return;
  for (const msg of update.messages) {
    if (msg.key.fromMe) continue; // (2) invariant — ראו התיעוד מעל הפונקציה

    const id = msg.key.id ?? "";
    if (alreadyProcessed(id)) continue; // (3) upsert כפול / redelivery — טופלה כבר

    // Prefer the phone-number JID (remoteJidAlt) over the @lid form when available — replying
    // to a fresh contact's @lid address can throw inside Baileys before its LID<->PN mapping
    // has synced, while the phone-number JID works immediately.
    const jid = msg.key.remoteJidAlt ?? msg.key.remoteJid;
    if (!jid) continue;

    const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "";

    if (text && onMessage) {
      if (id) markProcessed(id);
      guardedForward(jid, text, onMessage); // (4)+(5)+(6)
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
