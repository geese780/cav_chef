/**
 * Startup config validation (FR-01). Runs before app.start() so a bad
 * config fails fast with one clear error instead of surfacing partway
 * through the first reorder cycle. Validates every configured location
 * (FR-27), including calendar access for any location with a calendarId
 * set (FR-28) — locations without one just skip the calendar check.
 */

const { validateInventoryListConfig } = require('./inventoryList');
const { parseLocations } = require('./locations');
const { buildCalendarClient, getNextEventStart } = require('./googleCalendar');

const REQUIRED_ENV_VARS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'LOCATIONS_JSON', 'APPROVAL_CHANNEL_ID'];

function assertRequiredEnvVars() {
  const missing = REQUIRED_ENV_VARS.filter(name => !(process.env[name] || '').trim());
  if (missing.length > 0) {
    throw new Error(`Missing required env var(s) in .env: ${missing.join(', ')}`);
  }
}

async function assertApprovalChannel(client) {
  const channel = (process.env.APPROVAL_CHANNEL_ID || '').trim();
  try {
    await client.conversations.info({ channel });
  } catch (err) {
    const reason = (err.data && err.data.error) || err.message;
    throw new Error(`APPROVAL_CHANNEL_ID "${channel}" is not reachable: ${reason}`);
  }
}

async function assertLocationCalendars(locations) {
  const withCalendars = locations.filter(l => l.calendarId);
  if (withCalendars.length === 0) return;

  const calendar = buildCalendarClient();
  for (const location of withCalendars) {
    try {
      await getNextEventStart({ calendar, calendarId: location.calendarId });
    } catch (err) {
      const reason = (err.errors && err.errors[0] && err.errors[0].reason) || err.message;
      throw new Error(`Location "${location.name}" calendarId "${location.calendarId}" is not reachable: ${reason}`);
    }
  }
}

async function validateStartupConfig({ client, logger }) {
  assertRequiredEnvVars();
  await assertApprovalChannel(client);

  const locations = parseLocations();
  for (const location of locations) {
    try {
      await validateInventoryListConfig({ client, logger, listId: location.listId });
    } catch (err) {
      throw new Error(`Location "${location.name}" (listId ${location.listId}): ${err.message}`);
    }
  }

  await assertLocationCalendars(locations);
}

module.exports = { validateStartupConfig, assertRequiredEnvVars };
