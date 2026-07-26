/**
 * Thin wrapper around the Google Calendar API (FR-28). Auth uses Application
 * Default Credentials — set GOOGLE_APPLICATION_CREDENTIALS to a service
 * account key file path, and share the shared bookings calendar with that
 * service account's email (same pattern as sharing a Slack List with the bot).
 *
 * All locations' bookings live in one shared calendar; each event's `location`
 * field identifies which site it's for (e.g. "WeHo Nashville VizLab 1"), so a
 * per-location `locationMatch` string picks out that location's events.
 */

const { google } = require('googleapis');

function buildCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/calendar.readonly']
  });
  return google.calendar({ version: 'v3', auth });
}

async function fetchUpcomingEvents({ calendar, calendarId, maxResults = 50 }) {
  const res = await calendar.events.list({
    calendarId,
    timeMin: new Date().toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults
  });
  return res.data.items || [];
}

/** True if an event's `location` field contains locationMatch (case-insensitive). */
function matchesLocation(event, locationMatch) {
  const text = String((event && event.location) || '').toLowerCase();
  return text.includes(String(locationMatch || '').toLowerCase());
}

/**
 * Returns the start Date of the next upcoming (or currently in-progress)
 * event whose location matches locationMatch, or undefined if there is none
 * in the fetched window.
 */
async function getNextEventStart({ calendar, calendarId, locationMatch }) {
  const events = await fetchUpcomingEvents({ calendar, calendarId });
  const match = events.find(ev => matchesLocation(ev, locationMatch));
  if (!match) return undefined;

  const start = match.start && (match.start.dateTime || match.start.date);
  return start ? new Date(start) : undefined;
}

module.exports = { buildCalendarClient, getNextEventStart, matchesLocation };
