const test = require('node:test');
const assert = require('node:assert/strict');
const { isExpired, pendingApprovalExpiryHours, DEFAULT_EXPIRY_HOURS } = require('../expiry');

test('isExpired', async t => {
  const now = new Date('2026-07-25T00:00:00Z');

  await t.test('false when there is no postedAt (predates this feature)', () => {
    assert.equal(isExpired({ postedAt: undefined, now, expiryHours: 24 }), false);
  });

  await t.test('false when posted well within the window', () => {
    const postedAt = now.getTime() - 1 * 60 * 60 * 1000; // 1h ago
    assert.equal(isExpired({ postedAt, now, expiryHours: 24 }), false);
  });

  await t.test('true exactly at the expiry boundary', () => {
    const postedAt = now.getTime() - 24 * 60 * 60 * 1000;
    assert.equal(isExpired({ postedAt, now, expiryHours: 24 }), true);
  });

  await t.test('true when posted well beyond the window', () => {
    const postedAt = now.getTime() - 48 * 60 * 60 * 1000;
    assert.equal(isExpired({ postedAt, now, expiryHours: 24 }), true);
  });
});

test('pendingApprovalExpiryHours', async t => {
  const saved = process.env.PENDING_APPROVAL_EXPIRY_HOURS;
  t.after(() => {
    if (saved === undefined) delete process.env.PENDING_APPROVAL_EXPIRY_HOURS;
    else process.env.PENDING_APPROVAL_EXPIRY_HOURS = saved;
  });

  await t.test('defaults when unset', () => {
    delete process.env.PENDING_APPROVAL_EXPIRY_HOURS;
    assert.equal(pendingApprovalExpiryHours(), DEFAULT_EXPIRY_HOURS);
  });

  await t.test('defaults when non-numeric', () => {
    process.env.PENDING_APPROVAL_EXPIRY_HOURS = 'abc';
    assert.equal(pendingApprovalExpiryHours(), DEFAULT_EXPIRY_HOURS);
  });

  await t.test('defaults when zero or negative', () => {
    process.env.PENDING_APPROVAL_EXPIRY_HOURS = '0';
    assert.equal(pendingApprovalExpiryHours(), DEFAULT_EXPIRY_HOURS);
    process.env.PENDING_APPROVAL_EXPIRY_HOURS = '-5';
    assert.equal(pendingApprovalExpiryHours(), DEFAULT_EXPIRY_HOURS);
  });

  await t.test('honors a valid override', () => {
    process.env.PENDING_APPROVAL_EXPIRY_HOURS = '6';
    assert.equal(pendingApprovalExpiryHours(), 6);
  });
});
