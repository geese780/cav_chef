const { config } = require('dotenv');
config();

const { parseLocations } = require('../locations');
const { buildCalendarClient, getNextEventStart } = require('../googleCalendar');
const { shouldTriggerCycle, leadTimeHours } = require('../scheduler');

/** Read-only smoke test: prints each location's next calendar event and
 * whether it would currently trigger a reorder cycle, without posting
 * anything to Slack or running any cycle. */
async function main() {
  try {
    const locations = parseLocations();
    const calendar = buildCalendarClient();
    const hours = leadTimeHours();
    const now = new Date();

    for (const location of locations) {
      if (!location.calendarId) {
        console.log(`${location.name}: no calendarId configured (manual trigger only)`);
        continue;
      }
      const nextEventStart = await getNextEventStart({ calendar, calendarId: location.calendarId });
      const due = shouldTriggerCycle({ nextEventStart, now, leadTimeHours: hours });
      console.log(
        `${location.name}: next booking ${nextEventStart ? nextEventStart.toISOString() : '(none)'} — ` +
        `${due ? '✅ would trigger now' : 'not due yet'} (lead time ${hours}h)`
      );
    }
    process.exit(0);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

main();
