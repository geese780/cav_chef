const { config } = require('dotenv');
config();

const { WebClient } = require('@slack/web-api');
const { runReorderCycle } = require('../reorderCycle');

/** Manually triggers one reorder cycle — posts Approve/Deny prompts to
 * APPROVAL_CHANNEL_ID for every row currently at/below threshold. Run this
 * against a running `npm start` process to test the full approve/deny flow;
 * there's no scheduler wired up yet. */
async function main() {
  const token = process.env.SLACK_BOT_TOKEN || '';
  if (!token) {
    console.error('SLACK_BOT_TOKEN is not set in .env');
    process.exit(1);
  }

  const client = new WebClient(token);

  try {
    const posted = await runReorderCycle({ client, logger: console });
    for (const { item, qty } of posted) {
      console.log(`  ✅ posted: ${item.name || item.asin} x${qty}`);
    }
    if (posted.length === 0) console.log('  (nothing below threshold — no prompts posted)');
    process.exit(0);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

main();
