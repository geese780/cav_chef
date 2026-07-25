const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRequiredEnvVars } = require('../startupCheck');

const REQUIRED = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'LOCATIONS_JSON', 'APPROVAL_CHANNEL_ID'];

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of REQUIRED) saved[key] = process.env[key];
  try {
    for (const key of REQUIRED) process.env[key] = overrides[key] !== undefined ? overrides[key] : 'x';
    fn();
  } finally {
    for (const key of REQUIRED) process.env[key] = saved[key];
  }
}

test('assertRequiredEnvVars', async t => {
  await t.test('passes when every var is set', () => {
    withEnv({}, () => assert.doesNotThrow(() => assertRequiredEnvVars()));
  });

  await t.test('throws naming a single missing var', () => {
    withEnv({ APPROVAL_CHANNEL_ID: '' }, () => {
      assert.throws(() => assertRequiredEnvVars(), /APPROVAL_CHANNEL_ID/);
    });
  });

  await t.test('throws naming multiple missing vars', () => {
    withEnv({ SLACK_BOT_TOKEN: '', LOCATIONS_JSON: '' }, () => {
      assert.throws(() => assertRequiredEnvVars(), /SLACK_BOT_TOKEN.*LOCATIONS_JSON/);
    });
  });

  await t.test('treats a whitespace-only value as missing', () => {
    withEnv({ SLACK_APP_TOKEN: '   ' }, () => {
      assert.throws(() => assertRequiredEnvVars(), /SLACK_APP_TOKEN/);
    });
  });
});
