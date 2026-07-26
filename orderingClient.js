/**
 * Amazon ordering client. AMAZON_MODE gates mock vs live — defaults to mock
 * so this is safe to run end-to-end without any Amazon credentials.
 * Live mode is intentionally unimplemented — see FR-14.
 */

function mockOrderId() {
  return `MOCK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Stable per-item reference key (FR-07): a retried placeOrder call for the
 * same draft/item reuses this key instead of minting a new one, so once live
 * ordering exists (FR-14) a retry can't double-place on Amazon's side. */
function buildIdempotencyKey(draftId, asin) {
  return `${draftId}:${asin}`;
}

/**
 * Place an order for one item. expectedCharge is threaded through onto the
 * result unvalidated for now — the real ExpectedCharge guard (comparing
 * against what Amazon actually charges) is live-only behavior, see FR-14.
 * idempotencyKey is accepted now and threaded through so FR-14's live
 * request can pass it as Amazon's client reference token; unused in mock
 * mode beyond logging.
 */
async function placeOrder({ item, qty, expectedCharge, idempotencyKey }) {
  const mode = (process.env.AMAZON_MODE || 'mock').trim().toLowerCase();

  if (mode === 'mock') {
    const orderId = mockOrderId();
    console.log(
      `[mock] placing order: ${qty} x ${item.asin} (${item.name}) — expectedCharge=${expectedCharge} — idempotencyKey=${idempotencyKey}`
    );
    return { orderId, status: 'mock_placed', expectedCharge };
  }

  throw new Error('live ordering not implemented — see FR-14');
}

module.exports = { placeOrder, buildIdempotencyKey };
