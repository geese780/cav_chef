# Feature Requests — slack-amazon-reorder

Roadmap from the current mock-mode scaffold to a production automated-reorder
system. Phases are ordered by dependency; within a phase, do P0 before P1 before P2.

**Priority:** P0 = blocks safe live use · P1 = needed for production · P2 = improves quality/ops
**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done

**Baseline (already built):** per-location Slack read → threshold check → one
batched, location-tagged Block Kit Approve All/Deny All prompt per location's
cycle → message update, all locations sharing one approval channel, runs end to
end in mock mode. Config and List schema validated on boot (FR-01). A location's
cycle skips entirely while its batch is still pending (FR-02). `ExpectedCharge`
guard is wired into the draft. `placeOrder` is stubbed. Pending drafts are
in-memory.

---

## Phase 1 — Correctness & Slack completeness
*No Amazon dependency. Fully buildable and testable now.*

### FR-01 — Startup config & column validation · P1
`[x]`
`startupCheck.js` runs before `app.start()`: asserts `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
`INVENTORY_LIST_ID`, `APPROVAL_CHANNEL_ID` are all set (naming every missing one, not
just the first), confirms `APPROVAL_CHANNEL_ID` resolves via `conversations.info`, and
validates the List's schema has the required `name`/`asin`/`on_hand`/`threshold`
columns (via the same schema-matching `getInventoryItems` uses, factored out so both
share one source of truth). Any failure throws before Socket Mode connects and the
process exits non-zero.
**Accept:** app refuses to start with a clear error naming any missing/unmatched
column; a valid config starts silently. Verified against the real workspace: valid
config starts clean; a deliberately wrong `APPROVAL_CHANNEL_ID` fails with
`channel_not_found` before startup.

### FR-02 — De-duplicate pending reorders · P1
`[x]`
Reorder prompts are now batched one-per-cycle (all flagged items in one Approve
All/Deny All message), so `runReorderCycle` skips starting a new cycle entirely
while any draft is still pending in `pendingStore` — no per-rowId tracking needed
at this scope. Revisit per-location scoping once FR-27 lands (today a pending
batch anywhere blocks every cycle, since there's only one location).
**Accept:** running two cycles back-to-back with a still-low item posts exactly one
prompt (the second cycle logs "skipping" and posts nothing); resolving the batch
(approve or deny) allows the next cycle to post again if items are still low.

### FR-03 — Unit tests for threshold logic · P1
`[x]`
Covered `itemsNeedingReorder` (below/at/above threshold, missing asin/onHand/threshold,
reorderQty defaulting to 1, empty list) plus `extractAsin` (URL and bare-ASIN parsing,
the unresolvable-shortlink case) and `normalizeKey` in `test/inventoryList.test.js`,
using Node's built-in `node:test` runner — no new dependency. Non-numeric cells are
the same code path as missing ones, since `toNumber()` converts them to `undefined`
before `itemsNeedingReorder` ever sees them; noted in the test file rather than
duplicated as a separate case.
**Accept:** test suite runs via `npm test` and passes; logic changes require test updates.

### FR-04 — Report skipped rows to Slack · P2
`[ ]`
Rows skipped for missing data are only logged. Post a low-noise summary (e.g. daily,
or when count changes) to a maintenance channel so bad rows get fixed.
**Accept:** a row missing an ASIN surfaces a message identifying it; clean lists post nothing.

### FR-05 — Write back on-hand quantity after a confirmed order · P2
`[ ]`
After a successful order, optionally increment the List's on-hand cell by the ordered
quantity via `slackLists.items.update` (needs `lists:write`).
**Accept:** confirming an order of N updates the row's on-hand by N; failures don't
corrupt the cell (update only after order success).

---

## Phase 1.5 — Scheduling & multi-location
*Needed before real deployment: replaces manual/weekly triggering and generalizes
from one location to N. Do FR-27 before FR-28 — the trigger should already be
looping over locations before it gets smarter about timing.*

### FR-27 — Multi-location config & fan-out · P1
`[x]`
Replaced `INVENTORY_LIST_ID` with `LOCATIONS_JSON` (`locations.js`), a JSON array
of `{name, listId, calendarId}` — `calendarId` is carried through now but unused
until FR-28. `runAllLocationCycles` (`reorderCycle.js`) loops `parseLocations()`
and runs an independent cycle per location. All locations post to the same shared
`APPROVAL_CHANNEL_ID`; every prompt and resolved message is tagged `[LocationName]`
(`blockKit.js`) to stay distinguishable in the one feed. FR-02's de-dup is now
scoped per `locationName` in `pendingStore`, so one location's pending batch
doesn't block another's cycle. FR-01's startup check now validates every
location's List schema, not just one. Verified end to end against the real
workspace: `[WeHo]`-tagged prompt posted, Approve/Deny both resolve correctly.
No guardrails exist yet at all pre-Phase-3, so per-location scoping of FR-10/FR-11
is deferred to whenever those land, not a gap introduced here.
**Accept:** adding a 4th location config requires no code change, only config
(verified: `parseLocations` handles an arbitrary-length array — see
`test/locations.test.js`); every prompt in the shared channel clearly states which
location it's for; a budget cap breach in one location doesn't block another (N/A
until FR-11 exists).

### FR-28 — Calendar-driven trigger · P1
`[ ]`
Replace fixed-interval (e.g. weekly) triggering with a per-location check against
that location's Google Calendar: read the next upcoming booking/event and run a
reorder cycle at a configurable lead time before it, instead of on a flat cadence
(a location with nothing booked doesn't need restocking on schedule). Requires
Google Calendar API access (service account or OAuth) scoped read-only, one
calendar id per location per FR-27's config.
**Accept:** a location with no upcoming booking runs no cycle; a location with a
booking in N days runs a cycle at the configured lead time before it; a manual
trigger (`npm run run-reorder-cycle`) still works as a per-location override.

---

## Phase 2 — Reliability & state

### FR-06 — Persistent pending-draft store · P1
`[ ]`
Replace the in-memory `Map` in `pendingStore.js` with SQLite or Redis behind the same
`put/get/remove` interface, so a restart mid-approval doesn't strand a draft.
**Accept:** a pending prompt survives a process restart and its buttons still resolve.

### FR-07 — Idempotent order placement · P0
`[ ]`
Guard against double-submission (double-clicked button, retried handler, redelivered
event). Mark a draft as "placing/placed" atomically before calling `placeOrder`, and
pass a client-side idempotency/reference key on the live request.
**Accept:** two rapid Approve clicks on one prompt place exactly one order.

### FR-08 — Retry, backoff & rate-limit handling · P2
`[ ]`
Handle Slack Tier-2 rate limits (Lists) and transient Amazon/Slack errors with bounded
exponential backoff; respect `Retry-After`.
**Accept:** a simulated 429 is retried and the cycle completes; permanent errors fail loudly.

### FR-09 — Graceful shutdown & recovery · P2
`[ ]`
On SIGTERM, finish in-flight work and stop the scheduler cleanly. On boot, reconcile
any drafts left in a "placing" state.
**Accept:** restart during a cycle leaves no duplicate prompts and no half-placed orders.

---

## Phase 3 — Spend safety & governance
*Do all of these before flipping `AMAZON_MODE=live`. This system spends real money.*

### FR-10 — Approver authorization allowlist · P0
`[ ]`
Right now anyone who can see the channel can approve. Restrict approval to an allowlist
of Slack user ids (or a group); reject clicks from others with an ephemeral notice.
**Accept:** a non-authorized user clicking Approve does not place an order and sees a
"not authorized" message; the prompt stays open.

### FR-11 — Budget guardrails · P0
`[ ]`
Enforce a max per-order total and a rolling daily spend cap. If a draft exceeds either,
either block it or require a second distinct approver.
**Accept:** a draft over the per-order cap can't be single-approved; exceeding the daily
cap blocks further orders until reset.

### FR-12 — Pending-approval expiry · P1
`[ ]`
Auto-expire prompts after a configurable window (e.g. 24h) so stale drafts can't be
approved days later at a drifted price. Update the message to "expired."
**Accept:** approving after the window is refused; the message shows expired state.

### FR-13 — Audit log of decisions & orders · P1
`[ ]`
Persist every trigger, prompt, decision (who/when), and order result to durable storage.
**Accept:** for any placed or denied order you can retrieve who decided, when, the items,
the expected vs actual total, and the resulting order id.

---

## Phase 4 — Amazon live integration
*Gated on the Amazon Business Order Placement role being provisioned.*

### FR-14 — Implement & verify `placeOrderLive` · P0 (for live)
`[ ]`
Complete the live request in `orderingClient.js`. Verify `lineItems`, `attributes`, and
`expectations` field names, the endpoint path, and API version against the current
"Placing an order" reference — the sketched shape is unverified. Keep the `ExpectedCharge`
expectation.
**Accept:** a live order for one cheap, returnable item succeeds; a deliberately low
`ExpectedCharge` causes Amazon to reject as expected.

### FR-15 — LWA access-token caching & refresh · P1
`[ ]`
Cache the Login-with-Amazon access token and refresh before expiry (~1h) instead of
exchanging on every call.
**Accept:** consecutive orders reuse a cached token; an expired token refreshes transparently.

### FR-16 — Ship-to address selection · P2
`[ ]`
The group has multiple addresses. Support choosing per item/order (default from config,
optionally overridable in the approval UI).
**Accept:** an order ships to the configured address; the choice is recorded in the audit log.

### FR-17 — Order status & tracking follow-up · P2
`[ ]`
After placement, poll order status and post confirmation/shipping/tracking updates back
to the Slack thread.
**Accept:** a placed order posts at least one status update (confirmed → shipped) to its thread.

---

## Phase 5 — Observability & operations

### FR-18 — Structured logging · P2
`[ ]`
Replace ad-hoc `console.*` with structured, leveled logs (cycle id, draft id, decision).
**Accept:** logs are queryable by draft id end to end.

### FR-19 — Error alerting · P2
`[ ]`
Route unhandled errors and failed orders to an on-call channel, not just stdout.
**Accept:** a forced `placeOrder` failure posts an alert with enough detail to act on.

### FR-20 — Health check & uptime monitoring · P2
`[ ]`
Expose a health endpoint / heartbeat so a down worker is noticed (a silent worker means
no reorders happen).
**Accept:** killing the process triggers an external alert within the monitor's interval.

### FR-21 — Secrets manager integration · P1
`[ ]`
Move tokens out of `.env` into a managed secret store for production.
**Accept:** prod runs with no plaintext secrets on disk; local dev still works via `.env`.

---

## Phase 6 — Deployment & rollout

### FR-22 — CI: lint + test on PR · P2
`[ ]`
Run lint and the test suite on every pull request.
**Accept:** a PR with failing tests is blocked.

### FR-23 — Containerize & deploy · P1
`[ ]`
Dockerfile + deployment to your hosting target, running as a long-lived worker.
**Accept:** the bot runs in the target environment with Socket Mode and the scheduler active.

### FR-24 — Staging vs production separation · P2
`[ ]`
Separate Slack app/List/Business group (or clearly isolated config) for staging vs prod so
tests never place real orders.
**Accept:** staging runs in mock (or against a test group) with no path to prod payment.

### FR-25 — Production rollout runbook & dry run · P1
`[ ]`
Document the go-live steps: flip to live, cap budgets low, run one dry order, verify audit
trail, then raise caps. Include a rollback (flip to mock) step.
**Accept:** a written runbook exists and a dry-run order has been completed and reverted/returned.

### FR-26 — Widen approver & buyer group gradually · P2
`[ ]`
Expand from the single-user test group to real approvers/buyers once the above holds.
**Accept:** additional users added with correct roles; approver allowlist (FR-10) updated.

---

## Suggested near-term order

1. ~~FR-02~~ ~~FR-03~~ ~~FR-01~~ done — correctness locked in while still in mock mode.
2. ~~FR-27~~ done. FR-28 — calendar-driven triggering, now that fan-out exists.
3. FR-06, FR-07 — state + idempotency, the reliability floor.
4. FR-10, FR-11, FR-13 — spend safety (per-location), before any live consideration.
5. FR-14 (+ FR-15) — go live on one item once the role clears.
6. Everything else as you harden toward wider rollout.
