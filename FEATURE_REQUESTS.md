# Feature Requests — slack-amazon-reorder

Roadmap from the current mock-mode scaffold to a production automated-reorder
system. Phases are ordered by dependency; within a phase, do P0 before P1 before P2.

**Priority:** P0 = blocks safe live use · P1 = needed for production · P2 = improves quality/ops
**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done

**Baseline (already built):** Slack read → threshold check → one batched Block Kit
Approve All/Deny All prompt per cycle → message update runs end to end in mock mode.
`ExpectedCharge` guard is wired into the draft. `placeOrder` is stubbed. Pending
drafts are in-memory. A cycle skips entirely while a batch is still pending (FR-02).

---

## Phase 1 — Correctness & Slack completeness
*No Amazon dependency. Fully buildable and testable now.*

### FR-01 — Startup config & column validation · P1
`[ ]`
On boot, verify every `COL_*` id actually exists in the target List (via a probe
row or `slackLists` column metadata) and that required env vars are set.
**Accept:** app refuses to start with a clear error naming any missing/unmatched
column; a valid config starts silently.

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
`[ ]`
Cover `itemsNeedingReorder`: below / at / above threshold, missing `onHand`/`threshold`,
missing `asin`, `reorderQty` defaulting to 1, non-numeric cells.
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
`[ ]`
Generalize the single `INVENTORY_LIST_ID` env var into a list of per-location
configs (List id, calendar id, display name), and run the read → threshold check
→ approval cycle independently per location. All locations' approval prompts post
to the same shared `APPROVAL_CHANNEL_ID` — no per-location channel — so prompts
must carry the location name (Block Kit text) to stay distinguishable in one feed.
Keep Phase 3 guardrails (FR-10 approver allowlist, FR-11 budget caps) scoped per
location, not global — a 3-location group needs 3 budget caps, not one shared pool.
**Accept:** adding a 4th location config requires no code change, only config;
every prompt in the shared channel clearly states which location it's for; a
budget cap breach in one location doesn't block another.

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

1. ~~FR-02~~ done. FR-03, FR-01 — lock in correctness while you're still in mock mode.
2. FR-27, FR-28 — multi-location config, then calendar-driven triggering.
3. FR-06, FR-07 — state + idempotency, the reliability floor.
4. FR-10, FR-11, FR-13 — spend safety (per-location), before any live consideration.
5. FR-14 (+ FR-15) — go live on one item once the role clears.
6. Everything else as you harden toward wider rollout.
