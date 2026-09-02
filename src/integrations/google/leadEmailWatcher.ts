import fs from "node:fs";
import path from "node:path";
import type { WASocket } from "@whiskeysockets/baileys";
import { google, type gmail_v1 } from "googleapis";
import { allowedWhatsappJids } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { addUpdate } from "../monday/tasks.js";
import { createLead } from "../monday/leads.js";
import { sendText } from "../whatsapp/send.js";
import { getGoogleClient } from "./auth.js";
import { sendEmail } from "./gmail.js";

const LABEL_NAME = "טופל-ע״י-הסוכן";
const POLL_INTERVAL_MS = 60 * 60 * 1000;
const SUBJECT_QUERY = 'subject:"הודעה חדשה מאת"';
const NOTIFY_EMAIL = "info@gotlib.biz";
const STATE_PATH = path.resolve("data/leadWatcherState.json");

let cachedLabelId: string | null = null;
let cachedSinceEpochSeconds: number | null = null;

/**
 * The Gmail search alone (subject + "-label:<processed>") has no time boundary, so on the very
 * first run it matched every "הודעה חדשה מאת" email the account had ever received — years of
 * already-handled inquiries plus every spam-bot submission the site's public form ever caught —
 * and created a real Monday lead + WhatsApp/email notification for every single one of them within
 * about 20 minutes (this actually happened once; ~50 duplicate leads and contacts had to be found
 * and manually reviewed for cleanup afterward). Persisting a fixed "don't look before this moment"
 * cutoff — set once, the first time this ever runs, and never moved — makes that structurally
 * impossible: only mail that arrives after the feature was switched on is ever a candidate,
 * regardless of how large the unlabeled backlog in the inbox is.
 */
function getSinceEpochSeconds(): number {
  if (cachedSinceEpochSeconds !== null) return cachedSinceEpochSeconds;

  if (fs.existsSync(STATE_PATH)) {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as { sinceEpochSeconds: number };
    cachedSinceEpochSeconds = state.sinceEpochSeconds;
    return cachedSinceEpochSeconds;
  }

  const now = Math.floor(Date.now() / 1000);
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ sinceEpochSeconds: now }, null, 2));
  cachedSinceEpochSeconds = now;
  return now;
}

async function getOrCreateLabel(gmail: gmail_v1.Gmail): Promise<string> {
  if (cachedLabelId) return cachedLabelId;

  const { data } = await gmail.users.labels.list({ userId: "me" });
  const existing = data.labels?.find((l) => l.name === LABEL_NAME);
  if (existing?.id) {
    cachedLabelId = existing.id;
    return existing.id;
  }

  const { data: created } = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name: LABEL_NAME, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  if (!created.id) throw new Error("יצירת תווית לסימון לידים מטופלים נכשלה");
  cachedLabelId = created.id;
  return created.id;
}

function findPlainTextPart(part: gmail_v1.Schema$MessagePart): string | null {
  if (part.mimeType === "text/plain" && part.body?.data) return part.body.data;
  for (const child of part.parts ?? []) {
    const found = findPlainTextPart(child);
    if (found) return found;
  }
  return null;
}

/**
 * Some senders (seen in practice: spam bots hitting the site's public contact form) produce a body
 * that never had real line breaks at all — every "line" is joined with a literal "<br>" instead of
 * "\n". Left as-is, the field regexes below (anchored on real newlines) silently swallow the entire
 * rest of the message into whichever field matched first. Normalizing first makes both cases behave
 * the same way.
 */
function decodeBody(payload?: gmail_v1.Schema$MessagePart | null): string {
  if (!payload) return "";
  const data = payload.body?.data ?? findPlainTextPart(payload);
  if (!data) return "";
  const raw = Buffer.from(data, "base64url").toString("utf-8");
  return raw.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
}

interface ParsedLeadEmail {
  name: string;
  phone?: string;
  email?: string;
  message?: string;
}

/**
 * The site's contact form (Elementor) sends a fixed Hebrew layout: labeled "שם:"/"טלפון:"/"אימייל:"/
 * "הודעה:" lines, then a "---" divider before submission metadata (date, page URL, user agent, IP)
 * that we don't care about. Parsed with plain regex rather than an LLM call — the format is rigid
 * enough that it isn't worth the latency/cost of asking Claude to read it.
 */
const MAX_NAME_LENGTH = 60;

function parseLeadEmail(body: string): ParsedLeadEmail | null {
  const nameMatch = body.match(/^שם:\s*(.+)$/m);
  if (!nameMatch) return null;

  const name = nameMatch[1]!.trim();
  // A name this long almost certainly means a field regex swallowed content it shouldn't have
  // (malformed/unexpected email layout) rather than an actual person's name — safer to skip the
  // whole message than create a lead with garbage data.
  if (name.length > MAX_NAME_LENGTH) return null;

  const phoneMatch = body.match(/^טלפון:\s*(.+)$/m);
  const emailMatch = body.match(/^אימייל:\s*(.+)$/m);
  const messageMatch = body.match(/^הודעה:\s*([\s\S]*?)\n\s*---/m) ?? body.match(/^הודעה:\s*([\s\S]*)$/m);

  return {
    name,
    phone: phoneMatch?.[1]?.trim(),
    email: emailMatch?.[1]?.trim(),
    message: messageMatch?.[1]?.trim(),
  };
}

async function notify(sock: WASocket, lead: ParsedLeadEmail) {
  const lines = [
    "🆕 ליד חדש מהאתר!",
    `שם: ${lead.name}`,
    lead.phone ? `טלפון: ${lead.phone}` : null,
    lead.email ? `אימייל: ${lead.email}` : null,
    lead.message ? `הודעה: ${lead.message}` : null,
    "",
    "נא לטפל 🙏",
  ].filter((l): l is string => l !== null);
  const text = lines.join("\n");

  const jid = allowedWhatsappJids[0];
  if (jid) {
    try {
      await sendText(sock, jid, text);
    } catch (err) {
      logger.error(err, "שליחת התראת וואטסאפ על ליד חדש נכשלה");
    }
  }

  try {
    await sendEmail({ to: NOTIFY_EMAIL, subject: `🆕 ליד חדש מהאתר: ${lead.name}`, text });
  } catch (err) {
    logger.error(err, "שליחת מייל התראה על ליד חדש נכשלה");
  }
}

async function processMessage(gmail: gmail_v1.Gmail, sock: WASocket, messageId: string, labelId: string) {
  const { data } = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const body = decodeBody(data.payload);
  const parsed = parseLeadEmail(body);

  if (!parsed) {
    logger.warn({ messageId }, "מייל תואם נושא פנייה מהאתר אך לא הצלחתי לחלץ ממנו פרטי ליד — מסמן ומדלג");
    await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { addLabelIds: [labelId] } });
    return;
  }

  const lead = await createLead({ firstName: parsed.name, phone: parsed.phone, email: parsed.email, source: "אתר" });
  if (parsed.message) {
    await addUpdate(lead.id, `הודעה מקורית מהאתר:\n${parsed.message}`);
  }

  // Only tag for dedup — deliberately not marking read/archived, so the original email stays
  // sitting in the inbox as the user's own reminder that this lead still needs handling.
  await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { addLabelIds: [labelId] } });

  await notify(sock, parsed);
  logger.info({ messageId, name: parsed.name, leadId: lead.id }, "ליד חדש נוצר אוטומטית מפניה במייל");
}

async function poll(sock: WASocket) {
  try {
    const auth = await getGoogleClient();
    const gmail = google.gmail({ version: "v1", auth });
    const labelId = await getOrCreateLabel(gmail);
    const since = getSinceEpochSeconds();

    const { data } = await gmail.users.messages.list({
      userId: "me",
      q: `${SUBJECT_QUERY} -label:"${LABEL_NAME}" after:${since}`,
      maxResults: 20,
    });

    for (const message of data.messages ?? []) {
      if (!message.id) continue;
      try {
        await processMessage(gmail, sock, message.id, labelId);
      } catch (err) {
        logger.error({ err, messageId: message.id }, "עיבוד מייל פנייה מהאתר נכשל");
      }
    }
  } catch (err) {
    logger.error(err, "בדיקת מיילים לאיתור לידים חדשים נכשלה");
  }
}

export function startLeadEmailWatcher(sock: WASocket) {
  void poll(sock);
  setInterval(() => void poll(sock), POLL_INTERVAL_MS);
}
