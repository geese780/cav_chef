const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuditLog } = require('../auditLog');

test('auditLog.log / forDraft', async t => {
  const log = createAuditLog(':memory:');

  await t.test('forDraft on an unknown draftId returns an empty array', () => {
    assert.deepEqual(log.forDraft('missing'), []);
  });

  await t.test('log then forDraft returns the entry with the right shape', () => {
    log.log('posted', { draftId: 'd1', locationName: 'WeHo', at: 1000, data: { expectedTotal: 42 } });
    const entries = log.forDraft('d1');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].eventType, 'posted');
    assert.equal(entries[0].draftId, 'd1');
    assert.equal(entries[0].locationName, 'WeHo');
    assert.equal(entries[0].at, 1000);
    assert.deepEqual(entries[0].data, { expectedTotal: 42 });
  });

  await t.test('multiple entries for the same draft come back in chronological order', () => {
    log.log('flagged_second_approval', { draftId: 'd1', locationName: 'WeHo', at: 2000, data: { byUserId: 'A' } });
    log.log('approved', { draftId: 'd1', locationName: 'WeHo', at: 3000, data: { byUserId: 'B' } });
    const entries = log.forDraft('d1');
    assert.deepEqual(
      entries.map(e => e.eventType),
      ['posted', 'flagged_second_approval', 'approved']
    );
  });

  await t.test('forDraft only returns entries for that draft, not others', () => {
    log.log('posted', { draftId: 'd2', locationName: 'DTLA', at: 4000, data: {} });
    assert.equal(log.forDraft('d1').length, 3);
    assert.equal(log.forDraft('d2').length, 1);
  });

  await t.test('log defaults draftId/locationName/data when omitted', () => {
    log.log('posted');
    const recent = log.recent(1);
    assert.equal(recent[0].draftId, null);
    assert.equal(recent[0].locationName, null);
    assert.deepEqual(recent[0].data, {});
  });
});

test('auditLog PII scrub', async t => {
  const log = createAuditLog(':memory:');

  await t.test('strips non-allowlisted top-level and item fields, keeps legitimate ones', () => {
    log.log('approved', {
      draftId: 'd1',
      locationName: 'WeHo',
      at: 1000,
      data: {
        byUserId: 'U123',
        firstApproverId: 'U456',
        deltaTotal: 12.5,
        buyerEmail: 'buyer@example.com',
        shipToAddress: { line1: '123 Main St', city: 'Nashville' },
        items: [
          {
            asin: 'B000123',
            name: 'Gaff Tape',
            qty: 2,
            expectedCharge: 20,
            actualCharge: 22,
            orderId: 'MOCK-1',
            shipToAddress: { line1: '123 Main St' }
          }
        ]
      }
    });

    const [entry] = log.forDraft('d1');
    assert.deepEqual(entry.data, {
      byUserId: 'U123',
      firstApproverId: 'U456',
      deltaTotal: 12.5,
      items: [{ asin: 'B000123', name: 'Gaff Tape', qty: 2, expectedCharge: 20, actualCharge: 22, orderId: 'MOCK-1' }]
    });
    assert.equal(entry.data.buyerEmail, undefined);
    assert.equal(entry.data.shipToAddress, undefined);
    assert.equal(entry.data.items[0].shipToAddress, undefined);
  });
});

test('auditLog.recent', async t => {
  const log = createAuditLog(':memory:');
  for (let i = 0; i < 5; i++) {
    log.log('posted', { draftId: `d${i}`, at: 1000 + i, data: {} });
  }

  await t.test('returns entries in chronological order (oldest of the recent window first)', () => {
    const recent = log.recent(3);
    assert.deepEqual(
      recent.map(e => e.draftId),
      ['d2', 'd3', 'd4']
    );
  });

  await t.test('respects the limit', () => {
    assert.equal(log.recent(2).length, 2);
  });

  await t.test('caps at the total number of entries when limit exceeds it', () => {
    assert.equal(log.recent(100).length, 5);
  });
});
