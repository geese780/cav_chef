const { config } = require('dotenv');
config();

const { WebClient } = require('@slack/web-api');
const { pollExpiry } = require('../expiry');

/** Manually triggers one pending-approval expiry poll (FR-12) — expires any
 * open draft older than PENDING_APPROVAL_EXPIRY_HOURS. Run this against a
 * running `npm start` process to test the expired-message update end to end;
 * normally this happens automatically on app.js's poll cadence. */
async function main() {
  const token = process.env.SLACK_BOT_TOKEN || '';
  if (!token) {
    console.error('SLACK_BOT_TOKEN is not set in .env');
    process.exit(1);
  }

  const client = new WebClient(token);

  try {
    await pollExpiry({ client, logger: console });
    process.exit(0);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

main();
