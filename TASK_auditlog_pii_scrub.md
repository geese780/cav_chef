# Task: Make the CAV_Chef audit log provably PII-free

## Context

CAV_Chef writes an append-only audit log (`auditLog.js`, SQLite) that is retained
long-term for governance. Amazon's Data Protection Policy (DPP) governs any stored
Amazon Information, and it expects PII (e.g. buyer email, ship-to address) to be
protected at rest and not retained beyond need. Our compliance stance (see
`INCIDENT_RESPONSE_PLAN.md` and `DATA_HANDLING.md`) is that the audit log stores
**no buyer PII at all** — which lets us retain it long-term without conflict.

Today the logged events (`posted`, `flagged_second_approval`, `approved`,
`denied`) appear to store only non-PII fields. The risk is future leakage: if a
raw Amazon order response (which can carry a ship-to address or buyer email) is
ever passed into a `log(...)` call's `data` payload, it would be silently
persisted. This task closes that off structurally.

## Objective

Enforce a **field allowlist at the single write choke point** in `auditLog.js`,
so only explicitly-vetted keys can ever be persisted in an audit entry's `data`.
Anything not on the allowlist is dropped before it reaches SQLite. Back it with a
test proving PII is stripped. This is a hardening of FR-13; it must not change any
legitimate logged output.

## Step 1 — Read before editing

Read these and note the exact shapes; do not assume from this doc:

- `auditLog.js` — the `log(eventType, {draftId, locationName, at, data})`
  signature, the table schema, and exactly how `data` is serialized into the row.
- Every call site that builds a `data` payload — search for `log(` /
  `auditLog.log(` (expected in `reorderCycle.js` and `app.js`'s `placeAndResolve`,
  plus the deny path). Record the full set of keys each event legitimately puts in
  `data`, including per-item object keys.
- `orderingClient.js` (and `placeOrder` / its return value) — determine whether an
  order response object containing an address or buyer email can flow into the
  `approved` payload. If it can, that is the exact leak this allowlist closes.
- `test/auditLog.test.js` — match its existing style and the `node:test` runner.

## Step 2 — Build the allowlist from ACTUAL usage

This is the important part: derive the allowlist from the real fields found in
Step 1 so nothing legitimate gets stripped. Use the list below as a **starting
point**, then add any real field you found and remove any that isn't actually
used. If you find a field you can't classify as clearly non-PII, stop and flag it
rather than allowlisting it.

Starting point (reconcile against real call sites):

```js
// Only these keys are ever persisted in an audit entry's `data`. Anything else
// (e.g. a raw Amazon order response carrying a ship-to address or buyer email)
// is stripped before it reaches the database. Allowlist, not blocklist — a
// blocklist misses fields we didn't anticipate.
const ALLOWED_DATA_KEYS = new Set([
  'items',          // array; each element sanitized to ALLOWED_ITEM_KEYS
  'expectedTotal',
  'currentTotal',
  'delta',
  'orderId',
  'orderIds',
  'decidedBy',      // internal Slack user id — NOT Amazon buyer PII
  'flaggedBy',      // internal Slack user id
  'reason',
]);

const ALLOWED_ITEM_KEYS = new Set([
  'asin', 'name', 'quantity', 'expectedCharge', 'actualCharge', 'orderId',
]);
```

## Step 3 — Add the sanitizer and apply it at the choke point

Add to `auditLog.js`:

```js
function sanitizeItem(item) {
  const clean = {};
  for (const k of Object.keys(item || {})) {
    if (ALLOWED_ITEM_KEYS.has(k)) clean[k] = item[k];
  }
  return clean;
}

function sanitizeData(data = {}) {
  const clean = {};
  for (const k of Object.keys(data)) {
    if (!ALLOWED_DATA_KEYS.has(k)) continue;              // drop non-allowlisted keys
    clean[k] = (k === 'items' && Array.isArray(data[k]))
      ? data[k].map(sanitizeItem)
      : data[k];
  }
  return clean;
}
```

In `log(...)`, run `sanitizeData(data)` and persist the result — the sanitized
object must be what gets serialized into the row, so no caller can bypass it.
Keep the top-level fields (`draftId`, `locationName`, `at`, `eventType`) exactly
as they are; only `data` is filtered.

## Step 4 — Test that PII is stripped

Add a test to `test/auditLog.test.js` (matching existing style):

- Call `log('approved', { draftId, locationName, at, data })` with a `data`
  payload that includes both legitimate fields AND PII decoys —
  `buyerEmail: 'x@y.com'`, `shipToAddress: {...}`, and an `items` entry that also
  carries a stray `shipToAddress`.
- Assert via `forDraft(draftId)` that the retrieved entry contains all the
  legitimate fields unchanged, and that `buyerEmail` / `shipToAddress` are absent
  at both the top level and inside each item.

## Constraints

- No new dependencies; stay on `node:sqlite` and `node:test`.
- Pure filtering only — do not alter event types, the table schema, or the
  `forDraft`/`recent` interfaces.
- Legitimate output must be byte-for-byte unchanged for payloads that contain no
  disallowed keys (verify an existing test still passes).
- Keep it lint-clean under the existing ESLint flat config.

## Acceptance criteria

- A `log(...)` call whose `data` contains `buyerEmail`/`shipToAddress` persists an
  entry with those fields removed (new test proves it).
- All existing audit-log tests still pass unchanged.
- `npm run lint` and `npm test` both pass.
- Every field currently used by the real `posted` / `flagged_second_approval` /
  `approved` / `denied` call sites survives the allowlist (nothing legitimate is
  dropped).

## Commands

```sh
npm run lint
npm test
```
