const test = require('node:test');
const assert = require('node:assert/strict');
const { itemsNeedingReorder, extractAsin, normalizeKey } = require('../inventoryList');

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

test('normalizeKey', async t => {
  await t.test('lowercases and strips non-alphanumerics', () => {
    assert.equal(normalizeKey('In Stock'), 'instock');
    assert.equal(normalizeKey('Amazon Link'), 'amazonlink');
  });

  await t.test('handles missing input', () => {
    assert.equal(normalizeKey(undefined), '');
  });
});
