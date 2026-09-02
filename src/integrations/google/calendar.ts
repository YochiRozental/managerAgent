import { google } from "googleapis";
import { DateTime } from "luxon";
import { getGoogleClient } from "./auth.js";

/** Formats a Google Calendar date/dateTime string into a clean "dd/MM HH:mm" (or just the date for all-day events) instead of the raw ISO string with seconds/timezone offset. */
function formatEventTime(dateTime?: string | null, date?: string | null): string | undefined {
  if (dateTime) return DateTime.fromISO(dateTime).setZone("Asia/Jerusalem").toFormat("dd/MM HH:mm");
  if (date) return DateTime.fromISO(date).toFormat("dd/MM");
  return undefined;
}

export interface CreateEventInput {
  summary: string;
  description?: string;
  /** ISO 8601 datetime, e.g. 2026-08-20T10:00:00 */
  startISO: string;
  endISO: string;
  attendeeEmails?: string[];
  timeZone?: string;
}

export interface ListEventsInput {
  /** ISO 8601 datetime lower bound (inclusive) */
  timeMinISO: string;
  /** ISO 8601 datetime upper bound (exclusive) */
  timeMaxISO: string;
}

export interface CalendarEventSummary {
  id?: string | null;
  summary?: string | null;
  start?: string | null;
  end?: string | null;
  attendees?: string[];
}

export async function listCalendarEvents(input: ListEventsInput): Promise<CalendarEventSummary[]> {
  const auth = await getGoogleClient();
  const calendar = google.calendar({ version: "v3", auth });
  const { data } = await calendar.events.list({
    calendarId: "primary",
    timeMin: input.timeMinISO,
    timeMax: input.timeMaxISO,
    singleEvents: true,
    orderBy: "startTime",
  });
  return (data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary,
    start: formatEventTime(e.start?.dateTime, e.start?.date),
    end: formatEventTime(e.end?.dateTime, e.end?.date),
    attendees: e.attendees?.map((a) => a.email ?? "").filter(Boolean),
  }));
}

export interface UpdateEventInput {
  eventId: string;
  summary?: string;
  description?: string;
  startISO?: string;
  endISO?: string;
  attendeeEmails?: string[];
  timeZone?: string;
}

export async function updateCalendarEvent(input: UpdateEventInput) {
  const auth = await getGoogleClient();
  const calendar = google.calendar({ version: "v3", auth });
  const { data } = await calendar.events.patch({
    calendarId: "primary",
    eventId: input.eventId,
    sendUpdates: "all",
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: input.startISO ? { dateTime: input.startISO, timeZone: input.timeZone ?? "Asia/Jerusalem" } : undefined,
      end: input.endISO ? { dateTime: input.endISO, timeZone: input.timeZone ?? "Asia/Jerusalem" } : undefined,
      attendees: input.attendeeEmails?.map((email) => ({ email })),
    },
  });
  return data;
}

export async function deleteCalendarEvent(eventId: string) {
  const auth = await getGoogleClient();
  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({ calendarId: "primary", eventId, sendUpdates: "all" });
  return { deleted: eventId };
}

export async function createCalendarEvent(input: CreateEventInput) {
  const auth = await getGoogleClient();
  const calendar = google.calendar({ version: "v3", auth });
  const { data } = await calendar.events.insert({
    calendarId: "primary",
    sendUpdates: "all",
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.startISO, timeZone: input.timeZone ?? "Asia/Jerusalem" },
      end: { dateTime: input.endISO, timeZone: input.timeZone ?? "Asia/Jerusalem" },
      attendees: input.attendeeEmails?.map((email) => ({ email })),
    },
  });
  return data;
}
