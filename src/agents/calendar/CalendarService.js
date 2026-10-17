import { googleAuth } from '../GoogleAuth.js';

const BASE_URL = 'https://www.googleapis.com/calendar/v3';

/**
 * CalendarService — real Google Calendar API v3 calls. Requires the same
 * Google OAuth credentials as GmailService (see GoogleAuth.js), with the
 * calendar scope granted.
 */
export class CalendarService {
  isConfigured() {
    return googleAuth.isConfigured();
  }

  async _authedFetch(path, options = {}) {
    const token = await googleAuth.getAccessToken();
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`CalendarService: API error ${res.status} - ${errText}`);
    }
    return res.json();
  }

  /** @param {string} timeMin ISO 8601, @param {string} timeMax ISO 8601 */
  async listEvents(timeMin, timeMax, calendarId = 'primary') {
    const data = await this._authedFetch(
      `/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`
    );
    return (data.items ?? []).map((e) => ({
      id: e.id,
      title: e.summary,
      start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date,
      attendees: e.attendees?.map((a) => a.email) ?? [],
    }));
  }

  /** @param {{title:string, start:string, end:string, attendees?:string[]}} params */
  async createEvent({ title, start, end, attendees = [] }, calendarId = 'primary') {
    const body = {
      summary: title,
      start: { dateTime: start },
      end: { dateTime: end },
      attendees: attendees.map((email) => ({ email })),
    };
    const result = await this._authedFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { eventId: result.id, htmlLink: result.htmlLink };
  }

  /** Deletes an event by id — the real undo counterpart to createEvent. */
  async deleteEvent(eventId, calendarId = 'primary') {
    const token = await googleAuth.getAccessToken();
    const res = await fetch(
      `${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    // Google returns 204 No Content on success — not JSON, so don't call _authedFetch here.
    if (!res.ok && res.status !== 410) { // 410 = already gone, treat as success for idempotent undo
      const errText = await res.text();
      throw new Error(`CalendarService: delete failed ${res.status} - ${errText}`);
    }
    return { deleted: true, eventId };
  }

  /**
   * Finds gaps of at least `durationMinutes` between existing events in a window.
   * Real free/busy computation from actual calendar data, not a guess.
   */
  async findAvailableSlots({ timeMin, timeMax, durationMinutes = 30, calendarId = 'primary' }) {
    const events = await this.listEvents(timeMin, timeMax, calendarId);
    const busy = events
      .filter((e) => e.start && e.end)
      .map((e) => ({ start: new Date(e.start), end: new Date(e.end) }))
      .sort((a, b) => a.start - b.start);

    const slots = [];
    let cursor = new Date(timeMin);
    const windowEnd = new Date(timeMax);
    const durationMs = durationMinutes * 60 * 1000;

    for (const b of busy) {
      if (b.start - cursor >= durationMs) {
        slots.push({ start: cursor.toISOString(), end: b.start.toISOString() });
      }
      if (b.end > cursor) cursor = b.end;
    }
    if (windowEnd - cursor >= durationMs) {
      slots.push({ start: cursor.toISOString(), end: windowEnd.toISOString() });
    }
    return slots;
  }
}
