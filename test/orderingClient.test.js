const test = require('node:test');
const assert = require('node:assert/strict');
const { placeOrder, buildIdempotencyKey } = require('../orderingClient');

test('buildIdempotencyKey', async t => {
  await t.test('combines draftId and asin', () => {
    assert.equal(buildIdempotencyKey('d1', 'B076CHDX7P'), 'd1:B076CHDX7P');
  });

  await t.test('is stable across repeated calls with the same inputs', () => {
    const a = buildIdempotencyKey('d1', 'B076CHDX7P');
    const b = buildIdempotencyKey('d1', 'B076CHDX7P');
    assert.equal(a, b);
  });

  await t.test('differs for different items in the same draft', () => {
    const a = buildIdempotencyKey('d1', 'B076CHDX7P');
    const b = buildIdempotencyKey('d1', 'B01N38BDWR');
    assert.notEqual(a, b);
  });
});

test('placeOrder (mock mode)', async t => {
  const saved = process.env.AMAZON_MODE;
  t.after(() => {
    if (saved === undefined) delete process.env.AMAZON_MODE;
    else process.env.AMAZON_MODE = saved;
  });
  process.env.AMAZON_MODE = 'mock';

  await t.test('returns a mock order id and echoes expectedCharge', async () => {
    const result = await placeOrder({
      item: { asin: 'B076CHDX7P', name: 'Kombucha' },
      qty: 1,
      expectedCharge: 5.99,
      idempotencyKey: 'd1:B076CHDX7P'
    });
    assert.equal(result.status, 'mock_placed');
    assert.equal(result.expectedCharge, 5.99);
    assert.match(result.orderId, /^MOCK-/);
  });
});
