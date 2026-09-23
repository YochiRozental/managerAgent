import type { WASocket } from "@whiskeysockets/baileys";

/**
 * מחזיק ה-socket הפעיל של WhatsApp ומצב החיבור שלו — מקום יחיד שכל שולח (outboxDrainer,
 * leadEmailWatcher, תשובות בצ'אט) שואל בזמן שליחה, במקום להחזיק reference קבוע מרגע ה-boot.
 * ב-reconnect (תפוגת QR, "stream restart required", ניתוק זמני) client.ts יוצר socket חדש
 * ומעדכן כאן מיד — כל שולח שממתין ושואל את getSocket() בזמן אמת מקבל את המופע העדכני, בלי
 * לדעת שקרה reconnect ובלי restart של התהליך.
 */
export type ConnectionState = "connecting" | "open" | "closed";

let currentSock: WASocket | null = null;
let currentState: ConnectionState = "closed";

export function setSocket(sock: WASocket | null, state: ConnectionState): void {
  currentSock = sock;
  currentState = state;
}

export function setState(state: ConnectionState): void {
  currentState = state;
}

export function getSocket(): WASocket | null {
  return currentSock;
}

export function getConnectionState(): ConnectionState {
  return currentState;
}

/** מוכן לשליחה: מחובר (open) ויש זהות מאומתת (authState.creds.me) על ה-socket הנוכחי. */
export function isReady(): boolean {
  return currentState === "open" && !!currentSock?.authState?.creds?.me;
}
