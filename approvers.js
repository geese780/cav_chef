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

/**
 * FR-11's second-approval flow normally requires a *different* approver than
 * whoever flagged the draft (real dual control). With ALLOW_SELF_SECOND_APPROVAL
 * set, the same user can confirm their own flag instead — meant for small
 * teams without enough distinct approvers yet. The dual-control check itself
 * stays intact in pendingStore.claimSecondApproval; this just toggles it off.
 * Defaults to false (dual control enforced) so leaving it unset is the safe
 * choice.
 */
function allowSelfSecondApproval() {
  return (process.env.ALLOW_SELF_SECOND_APPROVAL || '').trim().toLowerCase() === 'true';
}

module.exports = { parseApproverAllowlist, isApprover, allowSelfSecondApproval };
