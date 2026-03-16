/**
 * TITAN — Calendar Skill (Built-in)
 * Integrate with Google Calendar via REST API.
 * Requires GOOGLE_CALENDAR_API_KEY and GOOGLE_CALENDAR_ID environment variables.
 */
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Calendar';

/**
 * Get the calendar ID from environment or use 'primary'
 * For 'primary' calendar, OAuth is required; for service account calendars, API key works.
 */
function getCalendarId(): string {
    return process.env.GOOGLE_CALENDAR_ID || 'primary';
}

/**
 * Get the API key from environment
 */
function getApiKey(): string | null {
    return process.env.GOOGLE_CALENDAR_API_KEY || null;
}

/**
 * Parse ISO string to UTC RFC3339 format for Google Calendar API
 */
function toRfc3339(isoString: string): string {
    const date = new Date(isoString);
    return date.toISOString();
}

/**
 * Validate ISO datetime string
 */
function isValidIsoDate(dateStr: string): boolean {
    try {
        const date = new Date(dateStr);
        return !isNaN(date.getTime());
    } catch {
        return false;
    }
}

export function registerCalendarSkill(): void {
    registerSkill(
        { name: 'calendar', description: 'Google Calendar integration for scheduling and event management. USE THIS WHEN Tony says: "schedule a meeting", "add event", "what\'s on my calendar", "what do I have today/this week", "am I free on X", "cancel meeting", "delete event". WORKFLOW: Before creating an event, always call action=list first to check for conflicts. Then call action=create with the confirmed details. RULES: Never create duplicate events — check first.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'calendar',
            description: 'Manages Google Calendar events: list upcoming events, create new events, or delete events. USE THIS WHEN Tony says: "schedule a meeting", "add event", "what\'s on my calendar", "what do I have today/this week", "am I free on X", "cancel meeting", "delete event". WORKFLOW: 1) Call action=list to check existing events and avoid conflicts. 2) Call action=create with confirmed title, startTime, and endTime. RULES: Always check calendar before adding — never create duplicate events.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'create', 'delete'], description: 'Action to perform' },
                    days: { type: 'number', description: 'Number of days to look ahead (default: 7)' },
                    maxResults: { type: 'number', description: 'Max events to return (default: 10)' },
                    title: { type: 'string', description: 'Event title (required for create)' },
                    startTime: { type: 'string', description: 'Event start time in ISO format (required for create)' },
                    endTime: { type: 'string', description: 'Event end time in ISO format (required for create)' },
                    description: { type: 'string', description: 'Event description' },
                    location: { type: 'string', description: 'Event location' },
                    eventId: { type: 'string', description: 'Event ID (required for delete)' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;
                const apiKey = getApiKey();
                const calendarId = getCalendarId();

                if (!apiKey) {
                    return `Error: GOOGLE_CALENDAR_API_KEY not configured.\n\nSetup instructions:\n1. Go to https://console.cloud.google.com/\n2. Create a new project or select existing\n3. Enable Google Calendar API\n4. Create an API key or Service Account\n5. Set environment variable: export GOOGLE_CALENDAR_API_KEY="your-api-key"\n6. Optionally set: export GOOGLE_CALENDAR_ID="calendar-id"\n   (If not set, 'primary' calendar is used, which requires OAuth)`;
                }

                try {
                    switch (action) {
                        case 'list':
                            return await handleCalendarList(apiKey, calendarId, args);
                        case 'create':
                            return await handleCalendarCreate(apiKey, calendarId, args);
                        case 'delete':
                            return await handleCalendarDelete(apiKey, calendarId, args);
                        default:
                            return `Unknown action: ${action}`;
                    }
                } catch (e) {
                    const errorMsg = (e as Error).message;
                    logger.error(COMPONENT, `Calendar operation failed: ${errorMsg}`);
                    return `Error: ${errorMsg}`;
                }
            },
        },
    );
}

/**
 * Handle calendar_list action
 */
async function handleCalendarList(apiKey: string, calendarId: string, args: Record<string, unknown>): Promise<string> {
    const days = Math.min((args.days as number) || 7, 365); // Cap at 1 year
    const maxResults = Math.min((args.maxResults as number) || 10, 250); // Cap at Google's max

    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.append('key', apiKey);
    url.searchParams.append('timeMin', timeMin);
    url.searchParams.append('timeMax', timeMax);
    url.searchParams.append('maxResults', String(maxResults));
    url.searchParams.append('orderBy', 'startTime');
    url.searchParams.append('singleEvents', 'true');

    const response = await fetch(url.toString(), {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Google Calendar API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as { items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; description?: string; location?: string }> };

    if (!data.items || data.items.length === 0) {
        return `No events found in the next ${days} days.`;
    }

    const eventLines = data.items.map((event) => {
        const startStr = event.start?.dateTime || event.start?.date || 'Unknown';
        const endStr = event.end?.dateTime || event.end?.date || 'Unknown';
        const title = event.summary || 'Untitled';
        const location = event.location ? ` at ${event.location}` : '';
        const description = event.description ? `\n  Description: ${event.description.slice(0, 100)}...` : '';
        return `• ${title}\n  ID: ${event.id}\n  Start: ${startStr}\n  End: ${endStr}${location}${description}`;
    });

    return `Events for the next ${days} days:\n\n${eventLines.join('\n\n')}`;
}

/**
 * Handle calendar_create action
 */
async function handleCalendarCreate(apiKey: string, calendarId: string, args: Record<string, unknown>): Promise<string> {
    const title = args.title as string | undefined;
    const startTime = args.startTime as string | undefined;
    const endTime = args.endTime as string | undefined;

    if (!title || !startTime || !endTime) {
        return 'Error: title, startTime, and endTime are required for create action.';
    }

    if (!isValidIsoDate(startTime) || !isValidIsoDate(endTime)) {
        return 'Error: startTime and endTime must be valid ISO 8601 datetime strings (e.g., 2026-03-15T10:00:00Z).';
    }

    const start = new Date(startTime);
    const end = new Date(endTime);
    if (start >= end) {
        return 'Error: startTime must be before endTime.';
    }

    const eventBody = {
        summary: title,
        start: {
            dateTime: toRfc3339(startTime),
            timeZone: 'UTC',
        },
        end: {
            dateTime: toRfc3339(endTime),
            timeZone: 'UTC',
        },
        description: (args.description as string) || '',
        location: (args.location as string) || '',
    };

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventBody),
        signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Google Calendar API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as { id: string; htmlLink?: string };

    logger.info(COMPONENT, `Created event: ${title} (${data.id})`);
    return `Created event "${title}"\n  Event ID: ${data.id}\n  Start: ${startTime}\n  End: ${endTime}${data.htmlLink ? `\n  Link: ${data.htmlLink}` : ''}`;
}

/**
 * Handle calendar_delete action
 */
async function handleCalendarDelete(apiKey: string, calendarId: string, args: Record<string, unknown>): Promise<string> {
    const eventId = args.eventId as string | undefined;

    if (!eventId) {
        return 'Error: eventId is required for delete action.';
    }

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10000),
    });

    if (response.status === 404) {
        return `Error: Event not found (ID: ${eventId}).`;
    }

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Google Calendar API error: ${response.status} - ${error}`);
    }

    logger.info(COMPONENT, `Deleted event: ${eventId}`);
    return `Deleted event: ${eventId}`;
}
