/**
 * Calendar-driven trigger (FR-28): rather than a flat weekly cadence, each
 * location's reorder cycle runs when that location's next booking is close
 * enough to matter. A location with no `calendarId` configured just isn't
 * polled — it still gets cycles via a manual trigger (see reorderCycle.js).
 */

const { parseLocations } = require('./locations');
const { runReorderCycle } = require('./reorderCycle');
const { getNextEventStart } = require('./googleCalendar');

const DEFAULT_LEAD_TIME_HOURS = 48;
const DEFAULT_POLL_INTERVAL_MINUTES = 60;

function leadTimeHours() {
  const raw = Number(process.env.CALENDAR_LEAD_TIME_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEAD_TIME_HOURS;
}

function pollIntervalMinutes() {
  const raw = Number(process.env.CALENDAR_POLL_INTERVAL_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_INTERVAL_MINUTES;
}

/**
 * Pure: should a cycle run now, given the next booking's start time (or
 * undefined if there isn't one)? True once that start time is within (or
 * already past — an in-progress booking is still relevant) the lead-time
 * window from now.
 */
function shouldTriggerCycle({ nextEventStart, now, leadTimeHours: hours }) {
  if (!nextEventStart) return false;
  const windowMs = hours * 60 * 60 * 1000;
  return nextEventStart.getTime() - now.getTime() <= windowMs;
}

/** Check every configured location's calendar and run a cycle for any that are due. */
async function pollDueLocations({ client, calendar, logger }) {
  const log = logger || console;
  const hours = leadTimeHours();
  const locations = parseLocations();
  const now = new Date();

  for (const location of locations) {
    if (!location.calendarId) {
      const msg = `[${location.name}] No calendarId configured — skipping calendar-driven trigger (manual only).`;
      log.info ? log.info(msg) : log.log(msg);
      continue;
    }

    const nextEventStart = await getNextEventStart({ calendar, calendarId: location.calendarId });
    if (!shouldTriggerCycle({ nextEventStart, now, leadTimeHours: hours })) {
      const msg = nextEventStart
        ? `[${location.name}] Next booking ${nextEventStart.toISOString()} is outside the ${hours}h lead time — skipping.`
        : `[${location.name}] No upcoming booking — skipping.`;
      log.info ? log.info(msg) : log.log(msg);
      continue;
    }

    await runReorderCycle({ client, logger: log, location });
  }
}

module.exports = {
  shouldTriggerCycle,
  pollDueLocations,
  leadTimeHours,
  pollIntervalMinutes,
  DEFAULT_LEAD_TIME_HOURS,
  DEFAULT_POLL_INTERVAL_MINUTES
};
