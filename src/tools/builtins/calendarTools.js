import { Tool, RiskLevel } from '../Tool.js';
import { CalendarService } from '../../agents/calendar/CalendarService.js';

const calendar = new CalendarService();

export function buildCalendarTools() {
  const configured = calendar.isConfigured();
  const status = configured ? 'IMPLEMENTED' : 'REQUIRES_API';

  return [
    new Tool({
      name: 'list_calendar_events',
      description: 'List calendar events in a time window (ISO 8601 datetimes).',
      inputSchema: {
        type: 'object',
        properties: { timeMin: { type: 'string' }, timeMax: { type: 'string' } },
        required: ['timeMin', 'timeMax'],
      },
      riskLevel: RiskLevel.SAFE,
      status,
      execute: async ({ timeMin, timeMax }) => {
        const events = await calendar.listEvents(timeMin, timeMax);
        return { count: events.length, events };
      },
    }),

    new Tool({
      name: 'find_available_time',
      description: 'Find open slots of a given duration in a time window, based on real calendar data.',
      inputSchema: {
        type: 'object',
        properties: {
          timeMin: { type: 'string' },
          timeMax: { type: 'string' },
          durationMinutes: { type: 'number' },
        },
        required: ['timeMin', 'timeMax'],
      },
      riskLevel: RiskLevel.SAFE,
      status,
      execute: async ({ timeMin, timeMax, durationMinutes }) => {
        const slots = await calendar.findAvailableSlots({ timeMin, timeMax, durationMinutes: durationMinutes ?? 30 });
        return { slots };
      },
    }),

    new Tool({
      name: 'create_calendar_event',
      description: "Create an event on the user's calendar.",
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          attendees: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'start', 'end'],
      },
      requiredPermissions: ['calendar.write'],
      riskLevel: RiskLevel.LOW,
      status,
      execute: async ({ title, start, end, attendees }) => {
        const result = await calendar.createEvent({ title, start, end, attendees: attendees ?? [] });
        return { created: true, ...result };
      },
      computeUndo: (_input, result) =>
        result.eventId ? { toolName: 'delete_calendar_event', input: { eventId: result.eventId } } : null,
    }),

    new Tool({
      name: 'delete_calendar_event',
      description: 'Delete a calendar event by its id. Internal — used for rollback, not general use.',
      inputSchema: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] },
      requiredPermissions: ['calendar.write'],
      riskLevel: RiskLevel.LOW,
      status,
      execute: async ({ eventId }) => calendar.deleteEvent(eventId),
    }),
  ];
}
