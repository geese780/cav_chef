/**
 * Approver authorization allowlist (FR-10). Gates the reorder Approve/Deny
 * buttons — not the check-in Done button (FR-29), which isn't a spend
 * action. Deny is gated alongside Approve: an unauthorized user shouldn't be
 * able to reject a legitimate reorder either, not just place one.
 */

function parseApproverAllowlist() {
  const raw = (process.env.APPROVER_ALLOWLIST || '').trim();
  if (!raw) throw new Error('APPROVER_ALLOWLIST is not set in .env');

  const ids = raw
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error('APPROVER_ALLOWLIST is set but contains no user ids');
  }

  return ids;
}

function isApprover(userId) {
  return parseApproverAllowlist().includes(userId);
}

module.exports = { parseApproverAllowlist, isApprover };
