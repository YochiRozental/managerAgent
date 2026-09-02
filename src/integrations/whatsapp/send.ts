import fs from "node:fs";
import type { WASocket } from "@whiskeysockets/baileys";
import { logger } from "../../utils/logger.js";
import { markAsSentByBot } from "./client.js";

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3, delayMs = 3000): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      logger.warn({ err, attempt, attempts }, `${label} נכשל, מנסה שוב`);
      if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/** Shows/clears the "typing…" indicator in the chat. Best-effort — never worth failing a reply over. */
export async function setTyping(sock: WASocket, jid: string, typing: boolean) {
  try {
    await sock.sendPresenceUpdate(typing ? "composing" : "paused", jid);
  } catch (err) {
    logger.warn({ err }, "עדכון סטטוס 'מקליד/ה' נכשל");
  }
}

export async function sendText(sock: WASocket, jid: string, text: string) {
  const sent = await withRetry("שליחת טקסט", () => sock.sendMessage(jid, { text }));
  markAsSentByBot(sent?.key.id);
}

export async function sendVoiceNote(sock: WASocket, jid: string, oggFilePath: string) {
  const audio = fs.readFileSync(oggFilePath);
  const sent = await withRetry("שליחת הודעת קול", () =>
    sock.sendMessage(jid, { audio, mimetype: "audio/ogg; codecs=opus", ptt: true }),
  );
  markAsSentByBot(sent?.key.id);
}
