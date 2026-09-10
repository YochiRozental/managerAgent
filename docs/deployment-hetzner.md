# פריסה — שרת Hetzner `gotlib-production`

הבית הקבוע של הסוכן. השרת כבר קיים ורץ — המסמך מתאר את המבנה, ההקשחה, והעדכון.

## מפרט השרת

| | |
|---|---|
| שם | `gotlib-production` (Hetzner Cloud) |
| סוג | **CPX12** — 1 vCPU (AMD EPYC) / 2 GB RAM / 40 GB SSD |
| מיקום | Nuremberg |
| OS | Ubuntu 24.04 LTS |
| IPv4 | `167.233.150.99` |
| Hetzner Backups | פעילים (snapshot יומי של הדיסק) |
| Swap | 2 GB (`/swapfile`) — נוסף בהקשחה; קריטי, השרת בלי swap עשה OOM ב-8-9/9 בזמן `build` |

**למה CPX12 מספיק (בינתיים):** במנוחה — ~1 GB פנוי, שני הקונטיינרים ~480 MB יחד, load ~0.
העומס (6 משתמשים, סריקות I/O-bound) קטן. ה-OOM היו **בזמן `docker compose build`** של image
כבד (onnxruntime) בלי swap — לא בזמן ריצה. עם swap + `mem_limit` + טעינת transformers עצלה, זה יציב.
**שדרוג ל-CPX22 (2 vCPU / 4 GB)** רק אם יש OOM בזמן ריצה, החלונית מאיטה בסריקת הבוקר, או כשמוסיפים סורקים.

## ארכיטקטורה

```
                        Caddy (host, systemd, :80/:443, TLS אוטומטי)
                             │  /etc/caddy/Caddyfile
                             ▼
              oauth2-proxy  (127.0.0.1:4180, Google, רק @gotlib.biz)   ← profile "auth"
                             ▼
                   window  (127.0.0.1:3001, container)  ── REQUIRE_ACCESS_LINK=true (קישור HMAC אישי)
                             │
        ┌────────────────────┴─────────────────────┐
   whatsapp-agent (container)                 data/agent.db (SQLite, WAL)
   auth/ (Baileys session)                    data/backups/ (14 יום)
```

- הקוד: `/opt/managerAgent` (git clone, `main`).
- Docker: `docker-compose.yml` בריפו → `whatsapp-agent` + `window` (+ `oauth2-proxy` תחת `--profile auth`).
- Caddy **לא** בקונטיינר — systemd על ה-host.
- שני קונטיינרים חולקים `./data` (WAL + busy_timeout).
- `restart: unless-stopped` + `systemctl enable docker` → עולה אחרי reboot.

## הקשחה (בוצע ב-Phase 1c)

1. **Swap 2 GB** — `/swapfile`, `swappiness=10`, ב-`/etc/fstab`.
2. **`mem_limit`** — whatsapp-agent 512 MB, window 768 MB (+ memswap). קונטיינר בודד לא מפיל את השרת.
3. **SSH key-only** — `PasswordAuthentication no`, `PermitRootLogin prohibit-password`. (אומת בחיבור חדש **לפני** ביטול הסיסמה.)
4. **Firewall** — `ufw`: מתיר 22 / 80 / 443, השאר חסום.
5. **fail2ban** — jail ל-sshd (היו ניסיונות brute-force בלוג).
6. **`unattended-upgrades`** — עדכוני אבטחה אוטומטיים (כבר היה פעיל).

## סודות — לא ב-git

`.env` · `google-credentials.json` · `data/google-token.json` · `auth/` · `data/*.db` — כולם ב-`.gitignore`.
מועברים לשרת ב-`scp` ישירות. על השרת: `chmod 600`.

מפתחות `.env` — ראה `.env.example`. חדשים ל-oauth2-proxy: `OAUTH2_PROXY_CLIENT_ID` / `_CLIENT_SECRET`
/ `_COOKIE_SECRET` / `_REDIRECT_URL`.

## עדכון הקוד על השרת

```bash
ssh root@167.233.150.99
cd /opt/managerAgent
git pull
docker compose down                 # לעצור לפני build כבד — הימנעות מ-OOM
docker compose build
docker compose up -d
docker compose ps
curl -s localhost:3001/health | jq .   # מצפים ל-status:"ok" אחרי שהסבב הראשון רץ
```

הסכימה של SQLite מתעדכנת לבד ב-import (`schema.sql` + `ALTER` idempotent). לפני שינוי סכימה גדול —
`docker compose exec window node -e "require('...')"`? לא. פשוט: הגיבוי היומי (`data/backups/`) מכסה.

## שכבת האימות — oauth2-proxy + Google

1. **Google Cloud Console** → APIs & Services → Credentials → **Create OAuth client ID** → *Web application*:
   - Authorized redirect URI: `https://manager-agent.gotlib.biz/oauth2/callback`
   - להעתיק Client ID + Client secret.
2. ב-`.env` על השרת:
   ```
   OAUTH2_PROXY_CLIENT_ID=...
   OAUTH2_PROXY_CLIENT_SECRET=...
   OAUTH2_PROXY_COOKIE_SECRET=<32 bytes base64url>
   OAUTH2_PROXY_REDIRECT_URL=https://manager-agent.gotlib.biz/oauth2/callback
   ```
3. `docker compose --profile auth up -d`
4. `/etc/caddy/Caddyfile` → `reverse_proxy 127.0.0.1:4180` (במקום `:3001`) → `systemctl reload caddy`
5. בדיקה: פתיחת `https://manager-agent.gotlib.biz` → מסך Google → רק `@gotlib.biz` נכנס → משם הקישור האישי.

**שתי השכבות יחד:** Google (מי אתה) + הקישור האישי HMAC (איזה עובד, איזה תפקיד/הרשאות).

## WhatsApp

Baileys שומר session ב-`auth/`. אם הקונטיינר במסך QR (`data/whatsapp-qr.png` מתעדכן) — צריך pairing:
`docker compose logs -f whatsapp-agent` מציג QR; מי שמחזיק את הטלפון של הסוכן סורק
(WhatsApp → Linked Devices). לא נוגעים ב-`auth/` הקיים לפני שיש session חדש עובד.
הודעות יוצאות מצטברות ב-`whatsapp_outbox` עד שהחיבור עולה.

## גיבוי

- **מקומי בשרת:** `src/ops/backup.ts` — `VACUUM INTO data/backups/agent-YYYY-MM-DD.db` יומי (`BACKUP_HOUR`), 14 אחרונים, + catch-up.
- **מחוץ לשרת:** Hetzner Storage Box + `restic` יומי של `data/` (ראה §9 בגרסה הקודמת / להגדיר).
- **רמת מכונה:** Hetzner disk snapshots (פעיל).

## ניטור

- `/health` → `200` תקין, `503` + סיבות בעברית כשלא.
- UptimeRobot / healthchecks.io על `https://manager-agent.gotlib.biz/health` כל 5 דק' → מייל למוטי+יוכי.
- `docker compose logs` — stdout, מומלץ להוסיף `logging: { options: { max-size: "10m", max-file: "3" } }`.

## reboot

`sudo reboot` → Docker service עולה → `restart: unless-stopped` מרים את הקונטיינרים → Caddy (systemd) עולה.
בדיקה: אחרי דקה `curl https://manager-agent.gotlib.biz/health`.
