const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPendingStore, resolveDbPath, DEFAULT_DB_PATH } = require('../pendingStore');

test('pendingStore CRUD (in-memory)', async t => {
  const store = createPendingStore(':memory:');
  const draft = { draftId: 'd1', locationName: 'WeHo', items: [{ item: { asin: 'B1' }, qty: 1 }] };

  await t.test('get on an unknown draftId returns undefined', () => {
    assert.equal(store.get('missing'), undefined);
  });

  await t.test('put then get round-trips the draft', () => {
    store.put('d1', draft);
    assert.deepEqual(store.get('d1'), draft);
  });

  await t.test('list includes put drafts', () => {
    store.put('d2', { draftId: 'd2', locationName: 'DTLA', items: [] });
    const all = store.list();
    assert.equal(all.length, 2);
    assert.ok(all.some(d => d.draftId === 'd1'));
    assert.ok(all.some(d => d.draftId === 'd2'));
  });

  await t.test('remove deletes the draft', () => {
    store.remove('d1');
    assert.equal(store.get('d1'), undefined);
    assert.equal(store.list().length, 1);
  });

  await t.test('put overwrites an existing draftId', () => {
    store.put('d2', { draftId: 'd2', locationName: 'DTLA', items: [{ item: { asin: 'B2' }, qty: 5 }] });
    assert.equal(store.get('d2').items.length, 1);
    assert.equal(store.list().length, 1);
  });
});

test('pendingStore.claim (FR-07 atomicity)', async t => {
  const store = createPendingStore(':memory:');
  const draft = { draftId: 'd1', locationName: 'WeHo', items: [{ item: { asin: 'B1' }, qty: 1 }] };
  store.put('d1', draft);

  await t.test('a first claim succeeds and returns the draft', () => {
    assert.deepEqual(store.claim('d1'), draft);
  });

  await t.test('a second claim on the same draftId fails (already claimed)', () => {
    assert.equal(store.claim('d1'), undefined);
  });

  await t.test('claiming an unknown draftId returns undefined', () => {
    assert.equal(store.claim('missing'), undefined);
  });

  await t.test('get still returns a claimed (not yet removed) draft', () => {
    assert.deepEqual(store.get('d1'), draft);
  });

  await t.test('list still includes a claimed draft (still blocks FR-02 dedup)', () => {
    assert.ok(store.list().some(d => d.draftId === 'd1'));
  });

  await t.test('re-putting a claimed draftId resets it to pending, claimable again', () => {
    store.put('d1', draft);
    assert.deepEqual(store.claim('d1'), draft);
  });

  await t.test('after remove, the draft can no longer be claimed', () => {
    store.remove('d1');
    assert.equal(store.claim('d1'), undefined);
  });
});

test('pendingStore migrates a pre-FR-07 DB file with no status column', async t => {
  const { DatabaseSync } = require('node:sqlite');
  const filePath = path.join(os.tmpdir(), `cav-chef-test-migrate-${Date.now()}.sqlite`);
  let store;
  t.after(() => {
    if (store) store.close();
    fs.rmSync(filePath, { force: true });
  });

  // Simulate a DB file created before the status column existed.
  const legacy = new DatabaseSync(filePath);
  legacy.exec('CREATE TABLE drafts (draft_id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  legacy.prepare('INSERT INTO drafts (draft_id, data) VALUES (?, ?)').run(
    'old',
    JSON.stringify({ draftId: 'old', locationName: 'WeHo', items: [] })
  );
  legacy.close();

  store = createPendingStore(filePath);
  assert.deepEqual(store.get('old'), { draftId: 'old', locationName: 'WeHo', items: [] });
  // A row inserted before the migration has no explicit status, but the
  // column's DEFAULT 'pending' (added via ALTER TABLE) still applies to it.
  assert.deepEqual(store.claim('old'), { draftId: 'old', locationName: 'WeHo', items: [] });
});

test('pendingStore persistence across a restart', async t => {
  const filePath = path.join(os.tmpdir(), `cav-chef-test-${Date.now()}.sqlite`);
  let after;
  t.after(() => {
    if (after) after.close();
    fs.rmSync(filePath, { force: true });
  });

  const draft = { draftId: 'persisted', locationName: 'WeHo', items: [{ item: { asin: 'B076CHDX7P' }, qty: 1 }] };

  const before = createPendingStore(filePath);
  before.put('persisted', draft);
  before.close();

  // Simulate a process restart: open a brand new store against the same file.
  after = createPendingStore(filePath);
  assert.deepEqual(after.get('persisted'), draft);
  assert.equal(after.list().length, 1);
});

test('resolveDbPath', async t => {
  const saved = process.env.PENDING_STORE_DB_PATH;
  t.after(() => {
    if (saved === undefined) delete process.env.PENDING_STORE_DB_PATH;
    else process.env.PENDING_STORE_DB_PATH = saved;
  });

  await t.test('defaults when unset', () => {
    delete process.env.PENDING_STORE_DB_PATH;
    assert.equal(resolveDbPath(), DEFAULT_DB_PATH);
  });

  await t.test('honors an override', () => {
    process.env.PENDING_STORE_DB_PATH = '/tmp/custom.sqlite';
    assert.equal(resolveDbPath(), '/tmp/custom.sqlite');
  });
});
