import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { google } from "googleapis";
import open from "open";
import { logger } from "../../utils/logger.js";

const CREDENTIALS_PATH = path.resolve("google-credentials.json");
const TOKEN_PATH = path.resolve("data/google-token.json");

const SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar.events"];

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

interface InstalledCredentialsFile {
  installed: { client_id: string; client_secret: string };
}

function loadClientSecrets() {
  const raw = fs.readFileSync(CREDENTIALS_PATH, "utf-8");
  const parsed = JSON.parse(raw) as InstalledCredentialsFile;
  return parsed.installed;
}

function persistTokens(tokens: object) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  const existing = fs.existsSync(TOKEN_PATH) ? JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8")) : {};
  fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }, null, 2));
}

function interactiveAuth(clientId: string, clientSecret: string): Promise<OAuth2Client> {
  return new Promise((resolve, reject) => {
    let oAuth2Client: OAuth2Client;

    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          const code = url.searchParams.get("code");
          if (!code) {
            res.writeHead(400).end("Missing authorization code");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body><h2>ההרשאה התקבלה, אפשר לסגור את החלון הזה.</h2></body></html>");
          server.close();

          const { tokens } = await oAuth2Client.getToken(code);
          oAuth2Client.setCredentials(tokens);
          persistTokens(tokens);
          oAuth2Client.on("tokens", persistTokens);
          resolve(oAuth2Client);
        } catch (err) {
          reject(err);
        }
      })();
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const redirectUri = `http://127.0.0.1:${port}`;
      oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent",
      });
      logger.info(`פותח דפדפן לאישור גוגל. אם לא נפתח לבד, העתק/י את הכתובת: ${authUrl}`);
      void open(authUrl);
    });
  });
}

export async function getGoogleClient(): Promise<OAuth2Client> {
  const { client_id, client_secret } = loadClientSecrets();

  if (fs.existsSync(TOKEN_PATH)) {
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret);
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    oAuth2Client.setCredentials(tokens);
    oAuth2Client.on("tokens", persistTokens);
    return oAuth2Client;
  }

  return interactiveAuth(client_id, client_secret);
}
