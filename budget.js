/**
 * Price-drift budget guardrail (FR-11). Not a static per-order/daily dollar
 * cap — compares a draft's originally expected total against its current
 * total at approval time. A drift under PRICE_DRIFT_THRESHOLD is noted but
 * doesn't block; a drift at or above it requires a second, distinct
 * approver before orders place. A total that can't be computed (any item
 * missing a price) is treated as unverifiable and requires second approval
 * too — safer than silently assuming zero drift.
 */

const DEFAULT_THRESHOLD = 50;

function priceDriftThreshold() {
  const raw = Number(process.env.PRICE_DRIFT_THRESHOLD);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_THRESHOLD;
}

/**
 * Pure: given each item's expected and current charge, decide whether a
 * single approval suffices or a second approver is required.
 * items: [{ expectedCharge, currentCharge }]
 */
function evaluateDraftTotal(items, threshold) {
  const hasUnknown = items.some(i => i.expectedCharge === undefined || i.currentCharge === undefined);
  const expectedTotal = items.reduce((sum, i) => sum + (i.expectedCharge || 0), 0);
  const currentTotal = items.reduce((sum, i) => sum + (i.currentCharge || 0), 0);
  const deltaTotal = currentTotal - expectedTotal;

  return {
    expectedTotal,
    currentTotal,
    deltaTotal,
    hasUnknown,
    requiresSecondApproval: hasUnknown || deltaTotal >= threshold
  };
}

module.exports = { priceDriftThreshold, evaluateDraftTotal, DEFAULT_THRESHOLD };
