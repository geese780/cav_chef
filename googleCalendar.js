/**
 * Thin wrapper around the Google Calendar API (FR-28). Auth uses Application
 * Default Credentials — set GOOGLE_APPLICATION_CREDENTIALS to a service
 * account key file path, and share each location's calendar with that
 * service account's email (same pattern as sharing a Slack List with the bot).
 */

const { google } = require('googleapis');

function buildCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/calendar.readonly']
  });
  return google.calendar({ version: 'v3', auth });
}

/**
 * Returns the start Date of the next upcoming (or currently in-progress)
 * event on a calendar, or undefined if there is none.
 */
async function getNextEventStart({ calendar, calendarId }) {
  const res = await calendar.events.list({
    calendarId,
    timeMin: new Date().toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 1
  });
  const event = res.data.items && res.data.items[0];
  if (!event) return undefined;

  const start = event.start && (event.start.dateTime || event.start.date);
  return start ? new Date(start) : undefined;
}

module.exports = { buildCalendarClient, getNextEventStart };
