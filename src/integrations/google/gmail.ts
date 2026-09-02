import { google } from "googleapis";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { getGoogleClient } from "./auth.js";

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
}

async function buildRawMessage(input: SendEmailInput): Promise<string> {
  const mail = new MailComposer({
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    textEncoding: "base64",
  });
  const message: Buffer = await mail.compile().build();
  return message.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sendEmail(input: SendEmailInput) {
  const auth = await getGoogleClient();
  const gmail = google.gmail({ version: "v1", auth });
  const raw = await buildRawMessage(input);
  const { data } = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return data;
}
