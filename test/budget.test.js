const test = require('node:test');
const assert = require('node:assert/strict');
const { priceDriftThreshold, evaluateDraftTotal, DEFAULT_THRESHOLD } = require('../budget');

test('evaluateDraftTotal', async t => {
  const threshold = 50;

  await t.test('no drift when current matches expected', () => {
    const result = evaluateDraftTotal([{ expectedCharge: 10, currentCharge: 10 }], threshold);
    assert.equal(result.deltaTotal, 0);
    assert.equal(result.requiresSecondApproval, false);
  });

  await t.test('a price decrease does not require second approval', () => {
    const result = evaluateDraftTotal([{ expectedCharge: 100, currentCharge: 80 }], threshold);
    assert.equal(result.deltaTotal, -20);
    assert.equal(result.requiresSecondApproval, false);
  });

  await t.test('an increase under the threshold does not require second approval', () => {
    const result = evaluateDraftTotal([{ expectedCharge: 100, currentCharge: 140 }], threshold);
    assert.equal(result.deltaTotal, 40);
    assert.equal(result.requiresSecondApproval, false);
  });

  await t.test('an increase exactly at the threshold requires second approval', () => {
    const result = evaluateDraftTotal([{ expectedCharge: 100, currentCharge: 150 }], threshold);
    assert.equal(result.deltaTotal, 50);
    assert.equal(result.requiresSecondApproval, true);
  });

  await t.test('an increase over the threshold requires second approval', () => {
    const result = evaluateDraftTotal([{ expectedCharge: 100, currentCharge: 200 }], threshold);
    assert.equal(result.requiresSecondApproval, true);
  });

  await t.test('sums drift across multiple items', () => {
    const result = evaluateDraftTotal(
      [
        { expectedCharge: 10, currentCharge: 15 },
        { expectedCharge: 20, currentCharge: 45 }
      ],
      threshold
    );
    assert.equal(result.expectedTotal, 30);
    assert.equal(result.currentTotal, 60);
    assert.equal(result.deltaTotal, 30);
    assert.equal(result.requiresSecondApproval, false); // 30 < 50
  });

  await t.test('a missing expectedCharge requires second approval even with zero apparent drift', () => {
    const result = evaluateDraftTotal([{ expectedCharge: undefined, currentCharge: 10 }], threshold);
    assert.equal(result.hasUnknown, true);
    assert.equal(result.requiresSecondApproval, true);
  });

  await t.test('a missing currentCharge requires second approval', () => {
    const result = evaluateDraftTotal([{ expectedCharge: 10, currentCharge: undefined }], threshold);
    assert.equal(result.hasUnknown, true);
    assert.equal(result.requiresSecondApproval, true);
  });

  await t.test('one unknown item among several still requires second approval', () => {
    const result = evaluateDraftTotal(
      [
        { expectedCharge: 10, currentCharge: 10 },
        { expectedCharge: undefined, currentCharge: undefined }
      ],
      threshold
    );
    assert.equal(result.requiresSecondApproval, true);
  });
});

test('priceDriftThreshold', async t => {
  const saved = process.env.PRICE_DRIFT_THRESHOLD;
  t.after(() => {
    if (saved === undefined) delete process.env.PRICE_DRIFT_THRESHOLD;
    else process.env.PRICE_DRIFT_THRESHOLD = saved;
  });

  await t.test('defaults when unset', () => {
    delete process.env.PRICE_DRIFT_THRESHOLD;
    assert.equal(priceDriftThreshold(), DEFAULT_THRESHOLD);
  });

  await t.test('honors a valid override, including zero', () => {
    process.env.PRICE_DRIFT_THRESHOLD = '0';
    assert.equal(priceDriftThreshold(), 0);
    process.env.PRICE_DRIFT_THRESHOLD = '25';
    assert.equal(priceDriftThreshold(), 25);
  });

  await t.test('defaults on a negative or non-numeric value', () => {
    process.env.PRICE_DRIFT_THRESHOLD = '-5';
    assert.equal(priceDriftThreshold(), DEFAULT_THRESHOLD);
    process.env.PRICE_DRIFT_THRESHOLD = 'abc';
    assert.equal(priceDriftThreshold(), DEFAULT_THRESHOLD);
  });
});
