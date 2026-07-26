/**
 * Pre-booking inventory check-in notification (FR-29). Separate from
 * scheduler.js's 48h auto-reorder trigger: 216h before a location's next
 * matching booking, post a Done/Confirmed-only heads-up showing current
 * inventory, re-pinging every 24h until acknowledged.
 */

const { parseLocations } = require('./locations');
const { getNextEventStart } = require('./googleCalendar');
const { getInventoryItems } = require('./inventoryList');
const { buildCheckinBlocks, buildCheckinReminderBlocks } = require('./blockKit');
const checkinStore = require('./checkinStore');

const DEFAULT_LEAD_TIME_HOURS = 216;
const DEFAULT_REPING_HOURS = 24;

function checkinLeadTimeHours() {
  const raw = Number(process.env.CHECKIN_LEAD_TIME_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEAD_TIME_HOURS;
}

function checkinRepingHours() {
  const raw = Number(process.env.CHECKIN_REPING_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REPING_HOURS;
}

/**
 * Pure: given the next booking (or none) and any existing record for it,
 * decide what to do this poll tick.
 * Returns 'none' | 'create' | 'reping' | 'wait'.
 */
function decideCheckinAction({ nextEventStart, now, leadTimeHours, existing, repingHours }) {
  if (!nextEventStart) return 'none';

  const dueAt = nextEventStart.getTime() - leadTimeHours * 60 * 60 * 1000;
  if (now.getTime() < dueAt) return 'none';

  if (!existing) return 'create';
  if (existing.status === 'acknowledged') return 'none';

  const repingDueAt = existing.lastNotifiedAt + repingHours * 60 * 60 * 1000;
  return now.getTime() >= repingDueAt ? 'reping' : 'wait';
}

/** Check every configured location's calendar and post/re-ping a check-in where due. */
async function pollCheckins({ client, calendar, logger }) {
  const log = logger || console;
  const leadTimeHours = checkinLeadTimeHours();
  const repingHours = checkinRepingHours();
  const channel = (process.env.APPROVAL_CHANNEL_ID || '').trim();
  const locations = parseLocations();
  const now = new Date();

  for (const location of locations) {
    if (!location.calendarId) continue;

    const nextEventStart = await getNextEventStart({
      calendar,
      calendarId: location.calendarId,
      locationMatch: location.locationMatch
    });

    const checkinId = nextEventStart
      ? checkinStore.buildCheckinId(location.name, nextEventStart.toISOString())
      : undefined;
    const existing = checkinId ? checkinStore.get(checkinId) : undefined;

    const action = decideCheckinAction({ nextEventStart, now, leadTimeHours, existing, repingHours });

    if (action === 'none' || action === 'wait') continue;

    if (action === 'create') {
      const items = await getInventoryItems({ client, logger: log, listId: location.listId });
      const result = await client.chat.postMessage({
        channel,
        text: `[${location.name}] Inventory check-in — booking on ${nextEventStart.toISOString()}`,
        blocks: buildCheckinBlocks({ checkinId, locationName: location.name, bookingStart: nextEventStart, items })
      });
      checkinStore.create(checkinId, {
        locationName: location.name,
        bookingStart: nextEventStart.toISOString(),
        channel,
        ts: result.ts,
        now: now.getTime()
      });
      const msg = 'Posted inventory check-in';
      const context = { checkinId, locationName: location.name, bookingStart: nextEventStart.toISOString() };
      log.info ? log.info(msg, context) : log.log(msg, context);
      continue;
    }

    if (action === 'reping') {
      const result = await client.chat.postMessage({
        channel,
        text: `[${location.name}] Inventory check-in still awaiting confirmation`,
        blocks: buildCheckinReminderBlocks({ checkinId, locationName: location.name, bookingStart: nextEventStart })
      });
      checkinStore.recordReping(checkinId, { channel, ts: result.ts, now: now.getTime() });
      const msg = 'Re-pinged inventory check-in';
      const context = { checkinId, locationName: location.name, bookingStart: nextEventStart.toISOString() };
      log.info ? log.info(msg, context) : log.log(msg, context);
    }
  }
}

module.exports = {
  decideCheckinAction,
  pollCheckins,
  checkinLeadTimeHours,
  checkinRepingHours,
  DEFAULT_LEAD_TIME_HOURS,
  DEFAULT_REPING_HOURS
};
