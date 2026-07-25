/**
 * One reorder cycle: read one location's inventory list, flag items below
 * threshold, and post a single batched Approve/Deny prompt covering all of
 * them to the shared approval channel, tagged with the location name (FR-27
 * — all locations post to one APPROVAL_CHANNEL_ID). Skips that location
 * entirely if a prior cycle's batch for it is still awaiting approval, so a
 * still-low item doesn't get re-prompted every cycle (see FR-02).
 */

const { randomUUID } = require('crypto');
const { getInventoryItems, itemsNeedingReorder } = require('./inventoryList');
const { buildReorderBlocks } = require('./blockKit');
const pendingStore = require('./pendingStore');
const { parseLocations } = require('./locations');

async function runReorderCycle({ client, logger, location }) {
  const log = logger || console;
  const channel = (process.env.APPROVAL_CHANNEL_ID || '').trim();
  if (!channel) throw new Error('APPROVAL_CHANNEL_ID is not set in .env');

  const alreadyPending = pendingStore.list().some(draft => draft.locationName === location.name);
  if (alreadyPending) {
    const msg = `[${location.name}] A reorder batch is still pending approval — skipping this cycle.`;
    log.info ? log.info(msg) : log.log(msg);
    return [];
  }

  const items = await getInventoryItems({ client, logger: log, listId: location.listId });
  const toReorder = itemsNeedingReorder(items);

  if (toReorder.length === 0) {
    const msg = `[${location.name}] No items below threshold — no prompt posted.`;
    log.info ? log.info(msg) : log.log(msg);
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
    text: `[${location.name}] Reorder needed: ${draftItems.length} item(s)`,
    blocks: buildReorderBlocks({ draftId, draftItems, locationName: location.name })
  });

  pendingStore.put(draftId, { draftId, locationName: location.name, items: draftItems, channel, ts: result.ts });

  const posted = draftItems.map(({ item, qty }) => ({ draftId, item, qty }));
  const msg = `[${location.name}] Posted 1 batch reorder prompt for ${posted.length} item(s).`;
  log.info ? log.info(msg) : log.log(msg);
  return posted;
}

/** Run a reorder cycle independently for every configured location (FR-27). */
async function runAllLocationCycles({ client, logger }) {
  const log = logger || console;
  const locations = parseLocations();

  const results = [];
  for (const location of locations) {
    const posted = await runReorderCycle({ client, logger: log, location });
    results.push({ location: location.name, posted });
  }
  return results;
}

module.exports = { runReorderCycle, runAllLocationCycles };
