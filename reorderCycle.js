/**
 * One reorder cycle: read the inventory list, flag items below threshold,
 * and post a single batched Approve/Deny prompt covering all of them.
 * Skips entirely if a prior cycle's batch is still awaiting approval, so a
 * still-low item doesn't get re-prompted every cycle (see FR-02).
 */

const { randomUUID } = require('crypto');
const { getInventoryItems, itemsNeedingReorder } = require('./inventoryList');
const { buildReorderBlocks } = require('./blockKit');
const pendingStore = require('./pendingStore');

async function runReorderCycle({ client, logger }) {
  const log = logger || console;
  const channel = (process.env.APPROVAL_CHANNEL_ID || '').trim();
  if (!channel) throw new Error('APPROVAL_CHANNEL_ID is not set in .env');

  if (pendingStore.list().length > 0) {
    const msg = 'A reorder batch is still pending approval — skipping this cycle.';
    log.info ? log.info(msg) : log.log(msg);
    return [];
  }

  const items = await getInventoryItems({ client, logger: log });
  const toReorder = itemsNeedingReorder(items);

  if (toReorder.length === 0) {
    log.info ? log.info('No items below threshold — no prompt posted.') : log.log('No items below threshold — no prompt posted.');
    return [];
  }

  const draftId = randomUUID();
  const draftItems = toReorder.map(item => {
    const qty = item.reorderQty;
    const expectedCharge = item.unitPrice !== undefined ? item.unitPrice * qty : undefined;
    return { rowId: item.rowId, item, qty, expectedCharge };
  });

  const result = await client.chat.postMessage({
    channel,
    text: `Reorder needed: ${draftItems.length} item(s)`,
    blocks: buildReorderBlocks({ draftId, draftItems })
  });

  pendingStore.put(draftId, { draftId, items: draftItems, channel, ts: result.ts });

  const posted = draftItems.map(({ item, qty }) => ({ draftId, item, qty }));
  log.info ? log.info(`Posted 1 batch reorder prompt for ${posted.length} item(s).`) : log.log(`Posted 1 batch reorder prompt for ${posted.length} item(s).`);
  return posted;
}

module.exports = { runReorderCycle };
