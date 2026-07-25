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

/**
 * Read the inventory list and return every row, parsed.
 */
async function getInventoryItems({ client, logger }) {
  const log = logger || console;
  const listId = (process.env.INVENTORY_LIST_ID || '').trim();
  if (!listId) throw new Error('INVENTORY_LIST_ID is not set in .env');

  const fileInfo = await client.files.info({ file: listId });
  const schema = fileInfo.file && fileInfo.file.list_metadata && fileInfo.file.list_metadata.schema;
  if (!schema) throw new Error(`File ${listId} does not look like a Slack List (no list_metadata.schema)`);

  const { columnIdFor, columnMeta } = mapSchemaColumns(schema);
  if (!columnIdFor.name || !columnIdFor.asin || !columnIdFor.on_hand || !columnIdFor.threshold) {
    throw new Error(
      `Inventory list is missing required columns. Found: ${JSON.stringify(columnIdFor)}. ` +
      `Expected columns named "name", "asin", "on_hand", and "threshold".`
    );
  }
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

module.exports = { getInventoryItems, itemsNeedingReorder, normalizeKey, extractAsin };
