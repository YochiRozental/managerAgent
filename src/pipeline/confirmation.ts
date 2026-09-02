import { DateTime } from "luxon";

function formatDateTime(iso: string): string {
  const dt = DateTime.fromISO(iso).setZone("Asia/Jerusalem");
  return dt.isValid ? dt.toFormat("dd/MM HH:mm") : iso;
}

const CONFIRM_WORDS = ["כן", "אוקיי", "אוקי", "בסדר", "אישור", "מאשר", "מאשרת", "yes", "ok", "okay"];
const CANCEL_WORDS = ["לא", "ביטול", "בטל", "עצור", "no", "cancel"];

export function classifyConfirmation(text: string): "confirm" | "cancel" | "unclear" {
  const normalized = text.trim().toLowerCase();
  if (CONFIRM_WORDS.some((w) => normalized === w || normalized.startsWith(`${w} `))) return "confirm";
  if (CANCEL_WORDS.some((w) => normalized === w || normalized.startsWith(`${w} `))) return "cancel";
  return "unclear";
}

interface CalendarEventInput {
  summary: string;
  startISO: string;
  endISO: string;
  attendeeEmails?: string[];
}

interface UpdateCalendarEventInput {
  eventId: string;
  summary?: string;
  startISO?: string;
  endISO?: string;
  attendeeEmails?: string[];
}

interface EmailInput {
  to: string[];
  subject: string;
  text: string;
}

export function describeAction(toolName: string, input: unknown): string {
  switch (toolName) {
    case "create_calendar_event": {
      const e = input as CalendarEventInput;
      const attendees = e.attendeeEmails?.length ? e.attendeeEmails.join(", ") : "אין";
      return `📅 יצירת אירוע ביומן:\nכותרת: ${e.summary}\nמתי: ${formatDateTime(e.startISO)} עד ${formatDateTime(e.endISO)}\nמשתתפים: ${attendees}`;
    }
    case "update_calendar_event": {
      const e = input as UpdateCalendarEventInput;
      const parts = [`📅 עדכון אירוע ביומן:`];
      if (e.summary) parts.push(`כותרת חדשה: ${e.summary}`);
      if (e.startISO) parts.push(`התחלה: ${formatDateTime(e.startISO)}`);
      if (e.endISO) parts.push(`סיום: ${formatDateTime(e.endISO)}`);
      if (e.attendeeEmails?.length) parts.push(`משתתפים: ${e.attendeeEmails.join(", ")}`);
      return parts.join("\n");
    }
    case "delete_calendar_event":
      return `🗑️ מחיקת אירוע מהיומן (וביטול אצל המשתתפים).`;
    case "send_meeting_summary_email": {
      const e = input as EmailInput;
      return `✉️ שליחת מייל:\nאל: ${e.to.join(", ")}\nנושא: ${e.subject}\nתוכן:\n${e.text}`;
    }
    default:
      return `ביצוע פעולה: ${toolName}\n${JSON.stringify(input)}`;
  }
}
