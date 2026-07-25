/**
 * Startup config validation (FR-01). Runs before app.start() so a bad
 * config fails fast with one clear error instead of surfacing partway
 * through the first reorder cycle.
 */

const { validateInventoryListConfig } = require('./inventoryList');

const REQUIRED_ENV_VARS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'INVENTORY_LIST_ID', 'APPROVAL_CHANNEL_ID'];

function assertRequiredEnvVars() {
  const missing = REQUIRED_ENV_VARS.filter(name => !(process.env[name] || '').trim());
  if (missing.length > 0) {
    throw new Error(`Missing required env var(s) in .env: ${missing.join(', ')}`);
  }
}

async function assertApprovalChannel(client) {
  const channel = (process.env.APPROVAL_CHANNEL_ID || '').trim();
  try {
    await client.conversations.info({ channel });
  } catch (err) {
    const reason = (err.data && err.data.error) || err.message;
    throw new Error(`APPROVAL_CHANNEL_ID "${channel}" is not reachable: ${reason}`);
  }
}

async function validateStartupConfig({ client, logger }) {
  assertRequiredEnvVars();
  await assertApprovalChannel(client);
  await validateInventoryListConfig({ client, logger });
}

module.exports = { validateStartupConfig, assertRequiredEnvVars };
