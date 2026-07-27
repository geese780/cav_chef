const test = require('node:test');
const assert = require('node:assert/strict');
const { stuckDrafts } = require('../reconcile');

test('stuckDrafts', async t => {
  await t.test('empty when there are no drafts', () => {
    assert.deepEqual(stuckDrafts([]), []);
  });

  await t.test('excludes pending and awaiting_second_approval drafts', () => {
    const drafts = [
      { draftId: 'd1', status: 'pending' },
      { draftId: 'd2', status: 'awaiting_second_approval' }
    ];
    assert.deepEqual(stuckDrafts(drafts), []);
  });

  await t.test('includes only drafts stuck in placing', () => {
    const drafts = [
      { draftId: 'd1', status: 'pending' },
      { draftId: 'd2', status: 'placing' },
      { draftId: 'd3', status: 'awaiting_second_approval' },
      { draftId: 'd4', status: 'placing' }
    ];
    assert.deepEqual(
      stuckDrafts(drafts).map(d => d.draftId),
      ['d2', 'd4']
    );
  });
});
