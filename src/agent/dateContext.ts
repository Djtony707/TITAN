/**
 * TITAN — Date Context for Sub-Agents
 *
 * Single-purpose helper that renders a short, human-readable "current time"
 * block to inject into sub-agent system prompts. Sub-agents previously had
 * no notion of "now", which broke missions that depended on relative-time
 * interpretation (e.g. "the advances since end of March").
 *
 * Pure function. No I/O. Pacific time (America/Los_Angeles) — Tony's TZ.
 */

const TZ = 'America/Los_Angeles';

/**
 * Returns a short prompt block describing the current date/time in Pacific
 * time. Pure — accepts an optional Date for deterministic testing.
 */
export function formatCurrentDateContext(now: Date = new Date()): string {
    // Weekday, Month D, YYYY  (e.g. "Friday, May 15, 2026")
    const dateLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    }).format(now);

    // h:mm AM/PM  (e.g. "9:14 PM")
    const timeLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    }).format(now);

    // Resolve DST suffix (PDT vs PST) and UTC offset dynamically.
    const tzShortFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        timeZoneName: 'short',
    });
    const tzShortPart = tzShortFmt.formatToParts(now).find((p) => p.type === 'timeZoneName');
    const tzShort = tzShortPart?.value ?? 'PT'; // "PDT" in May, "PST" in winter
    const utcOffset = tzShort === 'PDT' ? 'UTC-7' : tzShort === 'PST' ? 'UTC-8' : '';

    const offsetSuffix = utcOffset ? `, ${utcOffset}` : '';

    return [
        `Today's date is ${dateLabel}.`,
        `Current time is ${timeLabel} Pacific (${TZ}${offsetSuffix}).`,
        `Use this when interpreting relative times like "now", "today", "yesterday", "last quarter", "end of March", etc. Anything described as "current" / "latest" / "recent" refers to information dated AFTER this timestamp.`,
    ].join('\n');
}
