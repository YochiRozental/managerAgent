import { allowedWhatsappJids } from "../src/config/env.js";
import { connectWhatsApp } from "../src/integrations/whatsapp/client.js";
import { sendText } from "../src/integrations/whatsapp/send.js";
import { logger } from "../src/utils/logger.js";

process.on("unhandledRejection", (err) => console.error("[fatal] unhandledRejection", err));
process.on("uncaughtException", (err) => console.error("[fatal] uncaughtException", err));

async function main() {
  logger.info(
    { allowedWhatsappJids },
    allowedWhatsappJids.length > 0
      ? "יגיב (הד) רק להודעות מהמספרים ברשימה"
      : "ALLOWED_WHATSAPP_JIDS ריק — רק יתעד הודעות נכנסות בלוג, לא יענה לאף אחד",
  );

  const sock = await connectWhatsApp((jid, text) => {
    logger.info({ jid, text }, "התקבלה הודעה");

    if (allowedWhatsappJids.length === 0 || !allowedWhatsappJids.includes(jid)) {
      return;
    }

    void sendText(sock, jid, `הד: ${text}`).then(() => logger.info({ jid }, "תשובת הד נשלחה"));
  });
}

main().catch((err) => {
  logger.error(err, "test-whatsapp-echo failed");
  process.exit(1);
});
