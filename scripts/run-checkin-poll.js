const { config } = require('dotenv');
config();

const { WebClient } = require('@slack/web-api');
const { buildCalendarClient } = require('../googleCalendar');
const { pollCheckins } = require('../checkin');

/** Manually triggers one pre-booking check-in poll (FR-29) — posts or
 * re-pings the inventory check-in notification for any location whose next
 * booking is within CHECKIN_LEAD_TIME_HOURS. Run this against a running
 * `npm start` process to test the Done button end to end; normally this
 * happens automatically on app.js's poll cadence. */
async function main() {
  const token = process.env.SLACK_BOT_TOKEN || '';
  if (!token) {
    console.error('SLACK_BOT_TOKEN is not set in .env');
    process.exit(1);
  }

  const client = new WebClient(token);
  const calendar = buildCalendarClient();

  try {
    await pollCheckins({ client, calendar, logger: console });
    process.exit(0);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

main();
