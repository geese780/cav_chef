const test = require('node:test');
const assert = require('node:assert/strict');
const { findSkippedRows, reportSkippedRows } = require('../skippedRowsReport');

test('findSkippedRows', async t => {
  await t.test('empty when every row has asin/onHand/threshold', () => {
    const items = [{ rowId: 'r1', name: 'Kombucha', asin: 'B1', onHand: 5, threshold: 2 }];
    assert.deepEqual(findSkippedRows(items), []);
  });

  await t.test('flags a row missing asin', () => {
    const items = [{ rowId: 'r1', name: 'Kombucha', asin: '', onHand: 5, threshold: 2 }];
    const skipped = findSkippedRows(items);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].rowId, 'r1');
    assert.deepEqual(skipped[0].reasons, ['missing/unresolvable ASIN']);
  });

  await t.test('flags a row with non-numeric on_hand or threshold', () => {
    const items = [{ rowId: 'r1', name: 'Kombucha', asin: 'B1', onHand: undefined, threshold: undefined }];
    const skipped = findSkippedRows(items);
    assert.deepEqual(skipped[0].reasons, ['missing or non-numeric on_hand', 'missing or non-numeric threshold']);
  });

  await t.test('does not flag a row that is simply above threshold', () => {
    const items = [{ rowId: 'r1', name: 'Kombucha', asin: 'B1', onHand: 50, threshold: 2 }];
    assert.deepEqual(findSkippedRows(items), []);
  });

  await t.test('only includes actually-bad rows among several good ones', () => {
    const items = [
      { rowId: 'r1', name: 'Good', asin: 'B1', onHand: 5, threshold: 2 },
      { rowId: 'r2', name: 'Bad', asin: '', onHand: 5, threshold: 2 },
      { rowId: 'r3', name: 'AlsoGood', asin: 'B3', onHand: 1, threshold: 2 }
    ];
    assert.deepEqual(
      findSkippedRows(items).map(r => r.rowId),
      ['r2']
    );
  });
});

test('reportSkippedRows', async t => {
  const savedChannel = process.env.APPROVAL_CHANNEL_ID;
  t.beforeEach(() => {
    process.env.APPROVAL_CHANNEL_ID = 'C123';
  });
  t.after(() => {
    if (savedChannel === undefined) delete process.env.APPROVAL_CHANNEL_ID;
    else process.env.APPROVAL_CHANNEL_ID = savedChannel;
  });

  function fakeClient() {
    const calls = [];
    return { calls, chat: { postMessage: async args => { calls.push(args); return { ts: '123.456' }; } } };
  }

  await t.test('posts nothing for a clean list', async () => {
    const client = fakeClient();
    await reportSkippedRows({ client, locationName: 'CleanLoc', items: [{ rowId: 'r1', asin: 'B1', onHand: 5, threshold: 2 }] });
    assert.equal(client.calls.length, 0);
  });

  await t.test('posts once for a location with a skipped row', async () => {
    const client = fakeClient();
    await reportSkippedRows({
      client,
      locationName: 'BadLoc1',
      items: [{ rowId: 'r1', name: 'Broken', asin: '', onHand: 5, threshold: 2 }]
    });
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].channel, 'C123');
  });

  await t.test('does not re-post the same unchanged skipped set on the next call', async () => {
    const client = fakeClient();
    const items = [{ rowId: 'r1', name: 'Broken', asin: '', onHand: 5, threshold: 2 }];
    await reportSkippedRows({ client, locationName: 'BadLoc2', items });
    await reportSkippedRows({ client, locationName: 'BadLoc2', items });
    assert.equal(client.calls.length, 1);
  });

  await t.test('re-posts when the skipped set changes (a new bad row appears)', async () => {
    const client = fakeClient();
    await reportSkippedRows({
      client,
      locationName: 'BadLoc3',
      items: [{ rowId: 'r1', name: 'Broken', asin: '', onHand: 5, threshold: 2 }]
    });
    await reportSkippedRows({
      client,
      locationName: 'BadLoc3',
      items: [
        { rowId: 'r1', name: 'Broken', asin: '', onHand: 5, threshold: 2 },
        { rowId: 'r2', name: 'AlsoBroken', asin: '', onHand: 5, threshold: 2 }
      ]
    });
    assert.equal(client.calls.length, 2);
  });

  await t.test('does not post when APPROVAL_CHANNEL_ID is unset', async () => {
    delete process.env.APPROVAL_CHANNEL_ID;
    const client = fakeClient();
    await reportSkippedRows({
      client,
      locationName: 'BadLoc4',
      items: [{ rowId: 'r1', name: 'Broken', asin: '', onHand: 5, threshold: 2 }]
    });
    assert.equal(client.calls.length, 0);
  });
});
