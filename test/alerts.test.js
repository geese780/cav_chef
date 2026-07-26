const test = require('node:test');
const assert = require('node:assert/strict');
const { alertOnFailure } = require('../alerts');

function withChannel(value, fn) {
  const saved = process.env.APPROVAL_CHANNEL_ID;
  try {
    if (value === undefined) delete process.env.APPROVAL_CHANNEL_ID;
    else process.env.APPROVAL_CHANNEL_ID = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.APPROVAL_CHANNEL_ID;
    else process.env.APPROVAL_CHANNEL_ID = saved;
  }
}

test('alertOnFailure', async t => {
  await t.test('posts to APPROVAL_CHANNEL_ID with the message and context', () =>
    withChannel('C123', async () => {
      let posted;
      const client = { chat: { postMessage: async args => (posted = args) } };
      await alertOnFailure(client, 'placeOrder failed', { draftId: 'd1', asin: 'B1' });

      assert.equal(posted.channel, 'C123');
      assert.match(posted.text, /placeOrder failed/);
      const blockText = posted.blocks[0].text.text;
      assert.match(blockText, /placeOrder failed/);
      assert.match(blockText, /draftId: d1/);
      assert.match(blockText, /asin: B1/);
    })
  );

  await t.test('does nothing (no throw) when APPROVAL_CHANNEL_ID is unset', () =>
    withChannel(undefined, async () => {
      let called = false;
      const client = { chat: { postMessage: async () => (called = true) } };
      await alertOnFailure(client, 'oops');
      assert.equal(called, false);
    })
  );

  await t.test('swallows its own failure instead of throwing', () =>
    withChannel('C123', async () => {
      const client = {
        chat: {
          postMessage: async () => {
            throw new Error('Slack is down');
          }
        }
      };
      await assert.doesNotReject(() => alertOnFailure(client, 'oops'));
    })
  );

  await t.test('handles missing context (no crash, no detail block)', () =>
    withChannel('C123', async () => {
      let posted;
      const client = { chat: { postMessage: async args => (posted = args) } };
      await alertOnFailure(client, 'bare message');
      assert.equal(posted.blocks[0].text.text, '🚨 *bare message*');
    })
  );
});
