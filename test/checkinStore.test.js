const test = require('node:test');
const assert = require('node:assert/strict');
const { createCheckinStore, buildCheckinId } = require('../checkinStore');

test('buildCheckinId', async t => {
  await t.test('combines location and booking start into a stable key', () => {
    assert.equal(buildCheckinId('WeHo', '2026-08-01T12:00:00.000Z'), 'WeHo::2026-08-01T12:00:00.000Z');
  });

  await t.test('differs for the same location with a different booking', () => {
    const a = buildCheckinId('WeHo', '2026-08-01T12:00:00.000Z');
    const b = buildCheckinId('WeHo', '2026-09-01T12:00:00.000Z');
    assert.notEqual(a, b);
  });
});

test('checkinStore CRUD (in-memory)', async t => {
  const store = createCheckinStore(':memory:');
  const id = buildCheckinId('WeHo', '2026-08-01T12:00:00.000Z');

  await t.test('get on an unknown checkinId returns undefined', () => {
    assert.equal(store.get('missing'), undefined);
  });

  await t.test('create then get round-trips as an open record', () => {
    store.create(id, {
      locationName: 'WeHo',
      bookingStart: '2026-08-01T12:00:00.000Z',
      channel: 'C1',
      ts: '111.222',
      now: 1000
    });
    const record = store.get(id);
    assert.equal(record.status, 'open');
    assert.equal(record.locationName, 'WeHo');
    assert.equal(record.channel, 'C1');
    assert.equal(record.ts, '111.222');
    assert.equal(record.lastNotifiedAt, 1000);
    assert.equal(record.acknowledgedBy, null);
  });

  await t.test('recordReping updates channel/ts/lastNotifiedAt without changing status', () => {
    store.recordReping(id, { channel: 'C1', ts: '333.444', now: 2000 });
    const record = store.get(id);
    assert.equal(record.status, 'open');
    assert.equal(record.ts, '333.444');
    assert.equal(record.lastNotifiedAt, 2000);
  });
});

test('checkinStore.claim (atomicity)', async t => {
  const store = createCheckinStore(':memory:');
  const id = buildCheckinId('WeHo', '2026-08-01T12:00:00.000Z');
  store.create(id, { locationName: 'WeHo', bookingStart: '2026-08-01T12:00:00.000Z', channel: 'C1', ts: '1', now: 0 });

  await t.test('a first claim succeeds and marks the record acknowledged', () => {
    const record = store.claim(id, { byUserId: 'U1', now: 5000 });
    assert.equal(record.status, 'acknowledged');
    assert.equal(record.acknowledgedBy, 'U1');
    assert.equal(record.acknowledgedAt, 5000);
  });

  await t.test('a second claim on the same checkinId fails (already acknowledged)', () => {
    assert.equal(store.claim(id, { byUserId: 'U2', now: 6000 }), undefined);
  });

  await t.test('get still returns the acknowledged record after a failed claim — this backs ' +
    'app.js falling back to get() so a click on a stale re-ping message can still show who ' +
    'actually confirmed, instead of silently doing nothing', () => {
    const record = store.get(id);
    assert.equal(record.status, 'acknowledged');
    assert.equal(record.acknowledgedBy, 'U1'); // the original claimer, not U2's failed attempt
  });

  await t.test('claiming an unknown checkinId returns undefined', () => {
    assert.equal(store.claim('missing', { byUserId: 'U1', now: 0 }), undefined);
  });
});
