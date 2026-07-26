const test = require('node:test');
const assert = require('node:assert/strict');
const { placeOrder, buildIdempotencyKey, getCurrentPrice, buildOrderRequestBody, regionBaseUrl } = require('../orderingClient');

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

test('getCurrentPrice (mock mode)', async t => {
  const savedMode = process.env.AMAZON_MODE;
  const savedDrift = process.env.MOCK_PRICE_DRIFT_PER_UNIT;
  t.after(() => {
    if (savedMode === undefined) delete process.env.AMAZON_MODE;
    else process.env.AMAZON_MODE = savedMode;
    if (savedDrift === undefined) delete process.env.MOCK_PRICE_DRIFT_PER_UNIT;
    else process.env.MOCK_PRICE_DRIFT_PER_UNIT = savedDrift;
  });
  process.env.AMAZON_MODE = 'mock';

  await t.test('matches unitPrice * qty when no drift is configured', () => {
    delete process.env.MOCK_PRICE_DRIFT_PER_UNIT;
    assert.equal(getCurrentPrice({ item: { unitPrice: 5.99 }, qty: 3 }), 17.97);
  });

  await t.test('applies MOCK_PRICE_DRIFT_PER_UNIT across every unit', () => {
    process.env.MOCK_PRICE_DRIFT_PER_UNIT = '10';
    assert.equal(getCurrentPrice({ item: { unitPrice: 5 }, qty: 2 }), 30); // (5+10)*2
  });

  await t.test('returns undefined when the item has no unitPrice', () => {
    delete process.env.MOCK_PRICE_DRIFT_PER_UNIT;
    assert.equal(getCurrentPrice({ item: { unitPrice: undefined }, qty: 1 }), undefined);
  });
});

test('regionBaseUrl (FR-14, unverified live path)', async t => {
  const saved = process.env.AMAZON_REGION;
  t.after(() => {
    if (saved === undefined) delete process.env.AMAZON_REGION;
    else process.env.AMAZON_REGION = saved;
  });

  await t.test('defaults to na when unset', () => {
    delete process.env.AMAZON_REGION;
    assert.equal(regionBaseUrl(), 'https://na.business-api.amazon.com');
  });

  await t.test('honors eu/fe, case-insensitively', () => {
    process.env.AMAZON_REGION = 'EU';
    assert.equal(regionBaseUrl(), 'https://eu.business-api.amazon.com');
    process.env.AMAZON_REGION = 'fe';
    assert.equal(regionBaseUrl(), 'https://fe.business-api.amazon.com');
  });

  await t.test('throws on an unknown region', () => {
    process.env.AMAZON_REGION = 'ap';
    assert.throws(() => regionBaseUrl(), /Unknown AMAZON_REGION "ap"/);
  });
});

test('buildOrderRequestBody (FR-14, unverified live path)', async t => {
  const REQUIRED = {
    AMAZON_PAYMENT_METHOD_ID: 'pm-1',
    AMAZON_BUYING_GROUP_ID: 'grp-1',
    AMAZON_BUYER_EMAIL: 'buyer@example.com',
    AMAZON_SHIP_TO_ADDRESS_ID: 'addr-1'
  };
  const saved = {};
  t.before(() => {
    for (const [key, value] of Object.entries(REQUIRED)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  t.after(() => {
    for (const key of Object.keys(REQUIRED)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const item = { asin: 'B076CHDX7P', name: 'Kombucha' };

  await t.test('sets externalId and lineItem externalId/quantity from idempotencyKey/qty', () => {
    const body = buildOrderRequestBody({ idempotencyKey: 'd1:B076CHDX7P', item, qty: 3, expectedCharge: undefined });
    assert.equal(body.externalId, 'd1:B076CHDX7P');
    assert.equal(body.lineItems[0].externalId, 'd1:B076CHDX7P');
    assert.equal(body.lineItems[0].quantity, 3);
  });

  await t.test('includes an ExpectedCharge line-item expectation when provided', () => {
    const body = buildOrderRequestBody({ idempotencyKey: 'd1:B076CHDX7P', item, qty: 1, expectedCharge: 12.5 });
    assert.deepEqual(body.lineItems[0].expectations, [
      { expectationType: 'ExpectedCharge', amount: { currencyCode: 'USD', amount: 12.5 }, source: 'SUBTOTAL' }
    ]);
  });

  await t.test('omits expectations entirely when expectedCharge is undefined', () => {
    const body = buildOrderRequestBody({ idempotencyKey: 'd1:B076CHDX7P', item, qty: 1, expectedCharge: undefined });
    assert.deepEqual(body.lineItems[0].expectations, []);
  });

  await t.test('carries the ASIN into SelectedProductReference', () => {
    const body = buildOrderRequestBody({ idempotencyKey: 'd1:B076CHDX7P', item, qty: 1, expectedCharge: undefined });
    const productAttr = body.attributes.find(a => a.name === 'SelectedProductReference');
    assert.deepEqual(productAttr.value, { productReferenceType: 'ProductIdentifier', id: 'B076CHDX7P' });
  });

  await t.test('truncates PurchaseOrderNumber to 30 characters', () => {
    const longKey = 'd'.repeat(40) + ':B076CHDX7P';
    const body = buildOrderRequestBody({ idempotencyKey: longKey, item, qty: 1, expectedCharge: undefined });
    const poAttr = body.attributes.find(a => a.name === 'PurchaseOrderNumber');
    assert.ok(poAttr.value.length <= 30);
  });

  await t.test('throws naming the missing env var when a required attribute is unset', () => {
    delete process.env.AMAZON_PAYMENT_METHOD_ID;
    assert.throws(
      () => buildOrderRequestBody({ idempotencyKey: 'd1:B076CHDX7P', item, qty: 1, expectedCharge: undefined }),
      /AMAZON_PAYMENT_METHOD_ID must be set/
    );
    process.env.AMAZON_PAYMENT_METHOD_ID = REQUIRED.AMAZON_PAYMENT_METHOD_ID;
  });
});

test('placeOrder rejects an unknown AMAZON_MODE', async t => {
  const saved = process.env.AMAZON_MODE;
  t.after(() => {
    if (saved === undefined) delete process.env.AMAZON_MODE;
    else process.env.AMAZON_MODE = saved;
  });
  process.env.AMAZON_MODE = 'sandbox';

  await assert.rejects(
    () => placeOrder({ item: { asin: 'B1' }, qty: 1, expectedCharge: undefined, idempotencyKey: 'x' }),
    /Unknown AMAZON_MODE "sandbox"/
  );
});
