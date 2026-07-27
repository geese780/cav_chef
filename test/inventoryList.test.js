const test = require('node:test');
const assert = require('node:assert/strict');
const { itemsNeedingReorder, extractAsin, normalizeKey, incrementOnHand } = require('../inventoryList');

function item(overrides) {
  return { rowId: 'r1', name: 'Widget', asin: 'B076CHDX7P', onHand: 5, threshold: 10, reorderQty: undefined, unitPrice: undefined, ...overrides };
}

test('itemsNeedingReorder', async t => {
  await t.test('flags a row below threshold', () => {
    const [flagged] = itemsNeedingReorder([item({ onHand: 5, threshold: 10 })]);
    assert.ok(flagged);
  });

  await t.test('flags a row exactly at threshold', () => {
    const [flagged] = itemsNeedingReorder([item({ onHand: 10, threshold: 10 })]);
    assert.ok(flagged);
  });

  await t.test('does not flag a row above threshold', () => {
    const result = itemsNeedingReorder([item({ onHand: 11, threshold: 10 })]);
    assert.equal(result.length, 0);
  });

  await t.test('skips a row missing asin', () => {
    const result = itemsNeedingReorder([item({ asin: '', onHand: 1, threshold: 10 })]);
    assert.equal(result.length, 0);
  });

  await t.test('skips a row missing onHand', () => {
    const result = itemsNeedingReorder([item({ onHand: undefined, threshold: 10 })]);
    assert.equal(result.length, 0);
  });

  await t.test('skips a row missing threshold', () => {
    const result = itemsNeedingReorder([item({ onHand: 1, threshold: undefined })]);
    assert.equal(result.length, 0);
  });

  // toNumber() in inventoryList.js converts non-numeric cells to undefined
  // before itemsNeedingReorder ever sees them, so "non-numeric onHand/threshold"
  // is the same case as "missing onHand/threshold" above.

  await t.test('defaults reorderQty to 1 when missing', () => {
    const [flagged] = itemsNeedingReorder([item({ onHand: 1, threshold: 10, reorderQty: undefined })]);
    assert.equal(flagged.reorderQty, 1);
  });

  await t.test('preserves an explicit reorderQty', () => {
    const [flagged] = itemsNeedingReorder([item({ onHand: 1, threshold: 10, reorderQty: 6 })]);
    assert.equal(flagged.reorderQty, 6);
  });

  await t.test('handles an empty list', () => {
    assert.deepEqual(itemsNeedingReorder([]), []);
  });
});

test('extractAsin', async t => {
  await t.test('extracts from a /dp/ URL', () => {
    assert.equal(
      extractAsin('https://www.amazon.com/Health-Ade/dp/B076CHDX7P/ref=sr_1_6?crid=X'),
      'B076CHDX7P'
    );
  });

  await t.test('extracts from a /gp/product/ URL', () => {
    assert.equal(
      extractAsin('http://amazon.com/gp/product/B01N38BDWR/ref=x'),
      'B01N38BDWR'
    );
  });

  await t.test('passes through a bare 10-character ASIN', () => {
    assert.equal(extractAsin('b06x6j5266'), 'B06X6J5266');
  });

  await t.test('returns empty for a shortened link with no embedded ASIN', () => {
    assert.equal(extractAsin('https://a.co/d/067LXbJw'), '');
  });

  await t.test('returns empty for unrelated text', () => {
    assert.equal(extractAsin('not a product link'), '');
  });

  await t.test('returns empty for missing input', () => {
    assert.equal(extractAsin(undefined), '');
    assert.equal(extractAsin(''), '');
  });
});

function fakeSchema() {
  return [
    { id: 'col_name', key: 'name', name: 'Name', type: 'text' },
    { id: 'col_asin', key: 'asin', name: 'ASIN', type: 'text' },
    { id: 'col_onhand', key: 'on_hand', name: 'On Hand', type: 'number' },
    { id: 'col_threshold', key: 'threshold', name: 'Threshold', type: 'number' }
  ];
}

function fakeRow({ id, name, asin, onHand, threshold }) {
  return {
    id,
    fields: [
      { column_id: 'col_name', text: name },
      { column_id: 'col_asin', text: asin },
      { column_id: 'col_onhand', number: onHand },
      { column_id: 'col_threshold', number: threshold }
    ]
  };
}

function fakeClient({ rows }) {
  const updateCalls = [];
  return {
    updateCalls,
    files: { info: async () => ({ file: { list_metadata: { schema: fakeSchema() } } }) },
    slackLists: {
      items: {
        list: async () => ({ items: rows, response_metadata: {} }),
        update: async args => {
          updateCalls.push(args);
          return { ok: true };
        }
      }
    }
  };
}

test('incrementOnHand (FR-05)', async t => {
  await t.test('no-ops with no updates', async () => {
    const client = fakeClient({ rows: [] });
    await incrementOnHand({ client, listId: 'L1', updates: [] });
    assert.equal(client.updateCalls.length, 0);
  });

  await t.test('writes new_on_hand = fresh_on_hand + qty for each row', async () => {
    const client = fakeClient({
      rows: [
        fakeRow({ id: 'r1', name: 'Kombucha', asin: 'B1', onHand: 2, threshold: 6 }),
        fakeRow({ id: 'r2', name: 'La Croix', asin: 'B2', onHand: 1, threshold: 4 })
      ]
    });
    await incrementOnHand({
      client,
      listId: 'L1',
      updates: [
        { rowId: 'r1', qty: 3 },
        { rowId: 'r2', qty: 1 }
      ]
    });
    assert.equal(client.updateCalls.length, 1);
    assert.equal(client.updateCalls[0].list_id, 'L1');
    assert.deepEqual(client.updateCalls[0].cells, [
      { row_id: 'r1', column_id: 'col_onhand', number: [5] },
      { row_id: 'r2', column_id: 'col_onhand', number: [2] }
    ]);
  });

  await t.test('uses the current (fresh) on_hand, not a stale value passed in', async () => {
    // Simulates someone manually correcting on_hand between when the draft
    // was posted and when it was approved — the write-back must reflect
    // that correction, not blindly add qty to whatever the draft cached.
    const client = fakeClient({
      rows: [fakeRow({ id: 'r1', name: 'Kombucha', asin: 'B1', onHand: 20, threshold: 6 })]
    });
    await incrementOnHand({ client, listId: 'L1', updates: [{ rowId: 'r1', qty: 3 }] });
    assert.deepEqual(client.updateCalls[0].cells, [{ row_id: 'r1', column_id: 'col_onhand', number: [23] }]);
  });

  await t.test('skips a row that no longer exists rather than guessing', async () => {
    const client = fakeClient({ rows: [] });
    await incrementOnHand({ client, listId: 'L1', updates: [{ rowId: 'r-deleted', qty: 3 }] });
    assert.equal(client.updateCalls.length, 0);
  });
});

test('normalizeKey', async t => {
  await t.test('lowercases and strips non-alphanumerics', () => {
    assert.equal(normalizeKey('In Stock'), 'instock');
    assert.equal(normalizeKey('Amazon Link'), 'amazonlink');
  });

  await t.test('handles missing input', () => {
    assert.equal(normalizeKey(undefined), '');
  });
});
