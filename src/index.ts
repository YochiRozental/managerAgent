import fs from "node:fs";
import { allowedWhatsappJids, env } from "./config/env.js";
import { transcribeHebrew } from "./integrations/stt/whisper.js";
import { startLeadEmailWatcher } from "./integrations/google/leadEmailWatcher.js";
import { connectWhatsApp } from "./integrations/whatsapp/client.js";
import { startOutboxDrainer } from "./integrations/whatsapp/outboxDrainer.js";
import { sendText } from "./integrations/whatsapp/send.js";
import { handleIncomingMessage } from "./pipeline/messageHandler.js";
import { recordHeartbeat } from "./db/repositories/systemHealth.js";
import { logger } from "./utils/logger.js";

// Baileys can throw mid-send when the socket dies (e.g. "Connection Closed") without ever firing a
// clean "close" event, so our own reconnect logic in client.ts never triggers and the process is
// left running but unable to talk to WhatsApp. Exiting lets Docker's `restart: unless-stopped`
// bring up a fresh process, which reconnects cleanly from the saved session within seconds.
process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandledRejection", err);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException", err);
  process.exit(1);
});

async function main() {
  if (allowedWhatsappJids.length === 0) {
    logger.warn("ALLOWED_WHATSAPP_JIDS ריק — הסוכן לא יגיב לאף אחד. הוסף/י מספר לקובץ .env");
  } else {
    logger.info({ allowedWhatsappJids }, "הסוכן פעיל ומגיב למספרים הבאים");
  }

  const sock = await connectWhatsApp(
    (jid, text) => {
      if (!allowedWhatsappJids.includes(jid)) return;
      void handleIncomingMessage(sock, jid, text);
    },
    (jid, audioFilePath) => {
      if (!allowedWhatsappJids.includes(jid)) {
        fs.unlink(audioFilePath, () => {});
        return;
      }

      if (!env.ENABLE_VOICE_TRANSCRIPTION) {
        fs.unlink(audioFilePath, () => {});
        void sendText(sock, jid, "כרגע אני לא יכול להבין הודעות קוליות - תוכל בבקשה לכתוב לי בטקסט? 🙂");
        return;
      }

      void (async () => {
        try {
          logger.info({ jid }, "מתמלל הודעת קול...");
          const text = await transcribeHebrew(audioFilePath);
          logger.info({ jid, text }, "תמלול הושלם");
          if (text) await handleIncomingMessage(sock, jid, text, true);
        } catch (err) {
          logger.error(err, "תמלול הודעת קול נכשל");
        } finally {
          fs.unlink(audioFilePath, () => {});
        }
      })();
    },
  );

  startLeadEmailWatcher(sock);
  startOutboxDrainer(sock);

  // פעימת לב — כדי ש-/health (שרת החלונית) ידע שסוכן ה-WhatsApp חי.
  recordHeartbeat("whatsapp-agent", `pid ${process.pid}`);
  setInterval(() => {
    try {
      recordHeartbeat("whatsapp-agent", `pid ${process.pid}`);
    } catch (err) {
      logger.error(err, "כתיבת heartbeat נכשלה");
    }
  }, 60_000).unref();
}

main();
