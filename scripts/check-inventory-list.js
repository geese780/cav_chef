const { config } = require('dotenv');
config();

const { WebClient } = require('@slack/web-api');
const { getInventoryItems, itemsNeedingReorder } = require('../inventoryList');
const { parseLocations } = require('../locations');

/** Read-only smoke test: prints the parsed inventory list for every
 * configured location and which rows currently qualify for a reorder
 * prompt, without posting anything to Slack. */
async function main() {
  const token = process.env.SLACK_BOT_TOKEN || '';
  if (!token) {
    console.error('SLACK_BOT_TOKEN is not set in .env');
    process.exit(1);
  }

  const client = new WebClient(token);

  try {
    const locations = parseLocations();
    for (const location of locations) {
      console.log(`=== ${location.name} ===`);
      const items = await getInventoryItems({ client, logger: console, listId: location.listId });
      const flagged = new Set(itemsNeedingReorder(items).map(i => i.rowId));

      console.log(`Read ${items.length} row(s) from the inventory list:\n`);
      for (const item of items) {
        const flag = flagged.has(item.rowId) ? '🔻' : '  ';
        console.log(
          `  ${flag} ${item.name || '(no name)'} — ${item.asin || '(no asin)'} — ` +
          `onHand=${item.onHand ?? '?'} threshold=${item.threshold ?? '?'} ` +
          `reorderQty=${item.reorderQty ?? '(default 1)'} unitPrice=${item.unitPrice ?? '(none)'}`
        );
      }

      console.log(`\n${flagged.size} row(s) would get a reorder prompt right now.\n`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

main();
