/**
 * Amazon ordering client. AMAZON_MODE gates mock vs live — defaults to mock
 * so this is safe to run end-to-end without any Amazon credentials.
 *
 * Live mode (FR-14) is implemented but UNVERIFIED — no Amazon Business
 * credentials/Order-Placement-role access exist yet to test against. Built
 * from public docs:
 *   https://docs.business.amazon.com/docs/placing-an-order
 *   https://amazon-business-group-2.readme.io/docs/ordering-api
 *   https://amazon-business-group-2.readme.io/docs/website-authorization-workflow
 * The NA base URL and the ExpectedCharge/attribute field names are as
 * documented; the EU/FE base URLs are inferred by the na./eu./fe. prefix
 * pattern (same convention Amazon's Selling Partner API uses) and are NOT
 * independently confirmed, and the exact wire shape of each attribute's
 * `value` (object vs. string) is the least-confirmed part of this sketch.
 * Do not flip AMAZON_MODE=live for a real order until this has been checked
 * against a real sandbox/live response — see FR-14's accept criteria.
 */

const { getAccessToken } = require('./amazonAuth');

function mockOrderId() {
  return `MOCK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Stable per-item reference key (FR-07): a retried placeOrder call for the
 * same draft/item reuses this key instead of minting a new one, so a retry
 * can't double-place on Amazon's side. Also used as the live request's
 * externalId/PurchaseOrderNumber (see buildOrderRequestBody). */
function buildIdempotencyKey(draftId, asin) {
  return `${draftId}:${asin}`;
}

const ORDERING_API_PATH = '/ordering/2022-10-30/orders';
const REGION_BASE_URLS = {
  na: 'https://na.business-api.amazon.com', // confirmed against docs
  eu: 'https://eu.business-api.amazon.com', // inferred by prefix pattern, unverified
  fe: 'https://fe.business-api.amazon.com' // inferred by prefix pattern, unverified
};

function regionBaseUrl() {
  const region = (process.env.AMAZON_REGION || 'na').trim().toLowerCase();
  const baseUrl = REGION_BASE_URLS[region];
  if (!baseUrl) {
    throw new Error(`Unknown AMAZON_REGION "${region}" — expected one of: ${Object.keys(REGION_BASE_URLS).join(', ')}`);
  }
  return baseUrl;
}

function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) throw new Error(`${name} must be set for AMAZON_MODE=live`);
  return value;
}

/**
 * Builds the Ordering API request body for one item — split out from
 * placeOrderLive so its shape is unit-testable without a live network call.
 * PurchaseOrderNumber is capped at 30 chars per the docs.
 */
function buildOrderRequestBody({ idempotencyKey, item, qty, expectedCharge }) {
  const attributes = [
    { name: 'Region', value: (process.env.AMAZON_REGION_CODE || 'US').trim() },
    {
      name: 'SelectedPaymentMethodReference',
      value: { paymentMethodReferenceType: 'StoredPaymentMethod', id: requireEnv('AMAZON_PAYMENT_METHOD_ID') }
    },
    {
      name: 'BuyingGroupReference',
      value: { groupReferenceType: 'GroupIdentity', id: requireEnv('AMAZON_BUYING_GROUP_ID') }
    },
    { name: 'BuyerReference', value: { userReferenceType: 'UserEmail', id: requireEnv('AMAZON_BUYER_EMAIL') } },
    {
      name: 'ShippingAddress',
      value: { addressType: 'PhysicalAddress', id: requireEnv('AMAZON_SHIP_TO_ADDRESS_ID') }
    },
    { name: 'SelectedProductReference', value: { productReferenceType: 'ProductIdentifier', id: item.asin } },
    { name: 'PurchaseOrderNumber', value: idempotencyKey.slice(0, 30) }
  ];

  const expectations =
    expectedCharge !== undefined
      ? [{ expectationType: 'ExpectedCharge', amount: { currencyCode: 'USD', amount: expectedCharge }, source: 'SUBTOTAL' }]
      : [];

  return {
    externalId: idempotencyKey,
    lineItems: [{ externalId: idempotencyKey, quantity: qty, attributes: [], expectations }],
    attributes,
    expectations: []
  };
}

/** UNVERIFIED — see file header. Places one live order via the Amazon
 * Business Ordering API. */
async function placeOrderLive({ item, qty, expectedCharge, idempotencyKey }) {
  const accessToken = await getAccessToken();
  const body = buildOrderRequestBody({ idempotencyKey, item, qty, expectedCharge });

  const res = await fetch(`${regionBaseUrl()}${ORDERING_API_PATH}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-amz-access-token': accessToken },
    body: JSON.stringify(body)
  });

  const result = await res.json();
  if (!res.ok) {
    throw new Error(`Amazon order placement request failed: ${res.status} ${JSON.stringify(result)}`);
  }

  // Response shape per docs: lineItems[].acceptedItems[].artifacts[] holds
  // UnitPrice/Charge/OrderIdentifier by acceptanceArtifactType. A 200 with
  // rejectedItems instead of acceptedItems means Amazon rejected the order
  // as business logic (e.g. ExpectedCharge mismatch), not a request error.
  const lineItem = result.lineItems && result.lineItems[0];
  const accepted = lineItem && lineItem.acceptedItems && lineItem.acceptedItems[0];
  if (!accepted) {
    throw new Error(`Amazon rejected the order: ${JSON.stringify(result)}`);
  }

  const artifacts = accepted.artifacts || [];
  const orderIdArtifact = artifacts.find(a => a.acceptanceArtifactType === 'OrderIdentifier');
  const chargeArtifact = artifacts.find(a => a.acceptanceArtifactType === 'Charge');

  return {
    orderId: orderIdArtifact && orderIdArtifact.identifier,
    status: 'placed',
    expectedCharge: chargeArtifact && chargeArtifact.amount && chargeArtifact.amount.amount
  };
}

/**
 * Current price for one item, checked at approval time for the price-drift
 * guardrail (FR-11) — distinct from `item.unitPrice`, which is only a
 * snapshot from whenever the List was last read. Mock mode simulates drift
 * via MOCK_PRICE_DRIFT_PER_UNIT (a flat $ amount added per unit, default 0)
 * so the drift-escalation path can be tested without live Amazon pricing.
 * Live mode isn't implemented — the Ordering API's own response (via
 * placeOrderLive) is what actually confirms price, not a separate check;
 * a true pre-approval quote would likely need the Cart API instead, which
 * hasn't been researched yet. Returns undefined if there's no unit price to
 * check against (matches expectedCharge's own undefined-when-no-unit_price
 * behavior).
 */
function getCurrentPrice({ item, qty }) {
  const mode = (process.env.AMAZON_MODE || 'mock').trim().toLowerCase();

  if (mode === 'mock') {
    if (item.unitPrice === undefined) return undefined;
    const driftPerUnit = Number(process.env.MOCK_PRICE_DRIFT_PER_UNIT || 0) || 0;
    return (item.unitPrice + driftPerUnit) * qty;
  }

  throw new Error('live price lookup not implemented — see FR-14 (needs Cart API research)');
}

/**
 * Place an order for one item. expectedCharge is threaded through onto the
 * mock result unvalidated; in live mode it's sent as Amazon's ExpectedCharge
 * expectation and the result reflects what Amazon actually accepted.
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

  if (mode === 'live') {
    return placeOrderLive({ item, qty, expectedCharge, idempotencyKey });
  }

  throw new Error(`Unknown AMAZON_MODE "${mode}" — expected "mock" or "live"`);
}

module.exports = { placeOrder, buildIdempotencyKey, getCurrentPrice, buildOrderRequestBody, regionBaseUrl };
