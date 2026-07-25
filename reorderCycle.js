/**
 * One reorder cycle: read the inventory list, flag items below threshold,
 * and post an Approve/Deny prompt for each. No cross-cycle de-dup yet — a
 * row that's still low next cycle gets a new prompt (see FR-02).
 */

const { randomUUID } = require('crypto');
const { getInventoryItems, itemsNeedingReorder } = require('./inventoryList');
const { buildReorderBlocks } = require('./blockKit');
const pendingStore = require('./pendingStore');

async function runReorderCycle({ client, logger }) {
  const log = logger || console;
  const channel = (process.env.APPROVAL_CHANNEL_ID || '').trim();
  if (!channel) throw new Error('APPROVAL_CHANNEL_ID is not set in .env');

  const items = await getInventoryItems({ client, logger: log });
  const toReorder = itemsNeedingReorder(items);

  const posted = [];
  for (const item of toReorder) {
    const draftId = randomUUID();
    const qty = item.reorderQty;
    const expectedCharge = item.unitPrice !== undefined ? item.unitPrice * qty : undefined;

    const result = await client.chat.postMessage({
      channel,
      text: `Reorder needed: ${item.name || item.asin}`,
      blocks: buildReorderBlocks({ draftId, item, qty, expectedCharge })
    });

    pendingStore.put(draftId, {
      draftId,
      rowId: item.rowId,
      item,
      qty,
      expectedCharge,
      channel,
      ts: result.ts
    });

    posted.push({ draftId, item, qty });
  }

  log.info ? log.info(`Posted ${posted.length} reorder prompt(s).`) : log.log(`Posted ${posted.length} reorder prompt(s).`);
  return posted;
}

module.exports = { runReorderCycle };
