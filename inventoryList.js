/**
 * Inventory Slack List reader.
 * Reads an inventory Slack List (columns: name, asin, on_hand, threshold,
 * reorder_qty, unit_price) and exposes a pure threshold check used to decide
 * which rows need a reorder prompt.
 */

const EXPECTED_COLUMNS = {
  name: ['name'],
  asin: ['asin', 'amazonlink', 'productlink', 'link'],
  on_hand: ['onhand', 'qtyonhand', 'quantityonhand', 'instock'],
  threshold: ['threshold', 'reorderthreshold', 'reorderpoint'],
  reorder_qty: ['reorderqty', 'reorderquantity', 'orderqty'],
  unit_price: ['unitprice', 'price', 'expectedprice']
};

/** Pull the ASIN out of an Amazon product URL, e.g. .../dp/B076CHDX7P/... */
function asinFromUrl(url) {
  const match = String(url || '').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  return match ? match[1].toUpperCase() : '';
}

function normalizeKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Flatten a Slack rich_text block array (as used by List text columns) to plain text. */
function richTextToPlain(blocks) {
  if (!Array.isArray(blocks)) return '';
  const flattenElement = el => {
    if (!el) return '';
    if (el.type === 'text') return el.text || '';
    if (Array.isArray(el.elements)) return el.elements.map(flattenElement).join('');
    return '';
  };
  return blocks
    .map(block => (Array.isArray(block.elements) ? block.elements.map(flattenElement).join('') : ''))
    .join('')
    .trim();
}

/** Match the List's schema columns (by id/name/key) to the fields we need,
 * plus per-column type info needed to read their values (see fieldToPlain). */
function mapSchemaColumns(schema) {
  const columnIdFor = {};
  const columnMeta = {};
  for (const column of schema || []) {
    const candidates = [normalizeKey(column.key), normalizeKey(column.name)];
    for (const [field, aliases] of Object.entries(EXPECTED_COLUMNS)) {
      if (columnIdFor[field]) continue;
      if (candidates.some(c => aliases.includes(c))) {
        columnIdFor[field] = column.id;
        columnMeta[column.id] = { type: column.type };
      }
    }
  }
  return { columnIdFor, columnMeta };
}

function fieldValue(fields, columnId) {
  if (!columnId) return undefined;
  return (fields || []).find(f => f.column_id === columnId);
}

/** Convert a List item field to a plain string based on its column type. */
function fieldToPlain(field, meta) {
  if (!field) return '';
  switch (meta && meta.type) {
    case 'number':
      return field.number !== undefined && field.number !== null ? String(field.number) : '';
    case 'link':
      return (Array.isArray(field.link) && field.link[0] && field.link[0].originalUrl) || '';
    default:
      return field.text || richTextToPlain(field.rich_text) || '';
  }
}

/** Extract an ASIN from a value that may be an Amazon product URL or a bare ASIN. */
function extractAsin(raw) {
  const fromUrl = asinFromUrl(raw);
  if (fromUrl) return fromUrl;
  const trimmed = String(raw || '').trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(trimmed) ? trimmed : '';
}

async function fetchAllItems(client, listId) {
  const items = [];
  let cursor;
  do {
    const res = await client.slackLists.items.list({ list_id: listId, cursor, limit: 100 });
    items.push(...(res.items || []));
    cursor = res.response_metadata && res.response_metadata.next_cursor;
  } while (cursor);
  return items;
}

/** Parse a plain string into a finite number, or undefined if it isn't one. */
function toNumber(s) {
  if (s === undefined || s === null || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Fetch a List's column schema by its file id. */
async function fetchListSchema(client, listId) {
  const fileInfo = await client.files.info({ file: listId });
  const schema = fileInfo.file && fileInfo.file.list_metadata && fileInfo.file.list_metadata.schema;
  if (!schema) throw new Error(`File ${listId} does not look like a Slack List (no list_metadata.schema)`);
  return schema;
}

/** Throws with a clear message if a required column (name/asin/on_hand/threshold) wasn't matched. */
function assertRequiredColumns(columnIdFor) {
  if (!columnIdFor.name || !columnIdFor.asin || !columnIdFor.on_hand || !columnIdFor.threshold) {
    throw new Error(
      `Inventory list is missing required columns. Found: ${JSON.stringify(columnIdFor)}. ` +
      `Expected columns named "name", "asin", "on_hand", and "threshold".`
    );
  }
}

/**
 * Validate that a List has the required columns, without fetching every
 * row — used for a fast startup check (FR-01), once per location (FR-27).
 */
async function validateInventoryListConfig({ client, logger, listId }) {
  const log = logger || console;
  if (!(listId || '').trim()) throw new Error('listId is required');

  const schema = await fetchListSchema(client, listId);
  const { columnIdFor } = mapSchemaColumns(schema);
  assertRequiredColumns(columnIdFor);
  if (!columnIdFor.reorder_qty) {
    log.warn('Inventory list has no "reorder_qty" column — defaulting every reorder to qty 1.');
  }
  if (!columnIdFor.unit_price) {
    log.warn('Inventory list has no "unit_price" column — reorder prompts will have no ExpectedCharge.');
  }
}

/**
 * Read one location's inventory list and return every row, parsed.
 */
async function getInventoryItems({ client, logger, listId }) {
  const log = logger || console;
  if (!(listId || '').trim()) throw new Error('listId is required');

  const schema = await fetchListSchema(client, listId);
  const { columnIdFor, columnMeta } = mapSchemaColumns(schema);
  assertRequiredColumns(columnIdFor);
  if (!columnIdFor.reorder_qty) {
    log.warn('Inventory list has no "reorder_qty" column — defaulting every reorder to qty 1.');
  }
  if (!columnIdFor.unit_price) {
    log.warn('Inventory list has no "unit_price" column — reorder prompts will have no ExpectedCharge.');
  }

  const rawItems = await fetchAllItems(client, listId);

  return rawItems.map(item => {
    const field = key => fieldValue(item.fields, columnIdFor[key]);
    const plain = key => fieldToPlain(field(key), columnMeta[columnIdFor[key]]);

    return {
      rowId: item.id,
      name: plain('name'),
      asin: extractAsin(plain('asin')),
      onHand: toNumber(plain('on_hand')),
      threshold: toNumber(plain('threshold')),
      reorderQty: toNumber(plain('reorder_qty')),
      unitPrice: toNumber(plain('unit_price'))
    };
  });
}

/**
 * Pure threshold check: which rows currently need a reorder prompt.
 * Skips (does not throw on) rows missing asin/onHand/threshold or with
 * non-numeric onHand/threshold — those are simply not actionable yet.
 * reorderQty defaults to 1 when missing/non-numeric.
 */
function itemsNeedingReorder(items) {
  return (items || [])
    .filter(item => item.asin && item.onHand !== undefined && item.threshold !== undefined)
    .filter(item => item.onHand <= item.threshold)
    .map(item => ({
      ...item,
      reorderQty: item.reorderQty !== undefined ? item.reorderQty : 1
    }));
}

/**
 * Increments a List row's on_hand cell by qty after a confirmed order
 * (FR-05) — a lightweight stand-in for "this much is now in transit," so the
 * very next cycle doesn't immediately re-flag the same still-physically-low
 * item the moment the approved batch is removed from pendingStore. This bot
 * has no separate "in transit" concept, so on_hand only reflects true
 * physical stock again once someone corrects it by hand once the shipment
 * actually arrives — a deliberate, documented approximation, not a full
 * receiving workflow.
 * Re-reads the List's *current* on_hand right before writing, rather than
 * trusting the value captured whenever the reorder cycle first posted the
 * draft — that value can be stale by the time of approval (e.g. someone
 * manually corrected a count in between), and blindly overwriting a cell
 * with stale math is exactly the "corrupt the cell" risk this FR's own
 * accept criteria calls out.
 * Needs the `lists:write` scope (see manifest.json) — not required until
 * this FR, so a workspace admin needs to reinstall/approve the updated app
 * permissions before this can write anything for real.
 */
async function incrementOnHand({ client, logger, listId, updates }) {
  const log = logger || console;
  if (!updates || updates.length === 0) return;

  const schema = await fetchListSchema(client, listId);
  const { columnIdFor } = mapSchemaColumns(schema);
  if (!columnIdFor.on_hand) return; // shouldn't happen — getInventoryItems already requires this column

  const freshItems = await getInventoryItems({ client, logger: log, listId });
  const freshByRowId = new Map(freshItems.map(item => [item.rowId, item]));

  const cells = [];
  for (const { rowId, qty } of updates) {
    const fresh = freshByRowId.get(rowId);
    if (!fresh || fresh.onHand === undefined) continue; // row gone or on_hand unreadable — skip rather than guess
    cells.push({ row_id: rowId, column_id: columnIdFor.on_hand, number: [fresh.onHand + qty] });
  }
  if (cells.length === 0) return;

  await client.slackLists.items.update({ list_id: listId, cells });
  const msg = 'Incremented on_hand after confirmed order';
  const context = { listId, rowCount: cells.length };
  log.info ? log.info(msg, context) : log.log(msg, context);
}

module.exports = {
  getInventoryItems,
  itemsNeedingReorder,
  normalizeKey,
  extractAsin,
  validateInventoryListConfig,
  incrementOnHand
};
