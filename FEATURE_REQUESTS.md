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
looping over locations before it gets smarter about timing. All three FRs done.*

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
`[x]`
All locations' bookings live in **one shared** Google Calendar (not one calendar
per location, as first assumed) — each event's `location` field identifies the
site (e.g. `"WeHo Nashville VizLab 1"`, `"Rock Lititz VizLab 1"`, `"Remote"` for
non-site mobile rentals). `googleCalendar.js` wraps the Calendar API (Application
Default Credentials via `GOOGLE_APPLICATION_CREDENTIALS`, a service account
shared on that one calendar) and fetches a window of upcoming events, filtering
by each location's `locationMatch` (a substring match against `location`,
case-insensitive; defaults to the location's `name` if not set) to find that
location's next booking — `matchesLocation` is the pure filter, unit-tested for
the exact cross-contamination risk this design has (two sites both prefixed
"Rock ", `"Remote"` never matching any real site). `scheduler.js` holds the
lead-time decision (`shouldTriggerCycle` — true once a matched booking is within
`CALENDAR_LEAD_TIME_HOURS`, default 48h, including an already-in-progress
booking) and `pollDueLocations`, which `app.js` runs on startup and every
`CALENDAR_POLL_INTERVAL_MINUTES` (default 60) thereafter, per location. A
location with no `calendarId` set is skipped by the poll entirely — no Google
call is made for it — and falls back to manual-only triggering via
`npm run run-reorder-cycle`, which remains an unconditional override regardless
of calendar state. FR-01's startup check also verifies calendar reachability
(including the location filter) for any location with a `calendarId` set.
Unit-tested (`test/scheduler.test.js`, `test/googleCalendar.test.js`): the
lead-time boundary, an already-started booking, no upcoming booking, the
env-var overrides/defaults, and the location-matching filter itself.
Verified live against the real shared calendar: the first pass (before
`locationMatch` existed) surfaced a real bug — WeHo picked up the earliest
booking on the whole calendar regardless of site, which turned out to belong to
Rock Nashville. Adding `locationMatch` fixed it: `npm run check-calendar` now
correctly reports only WeHo's own next booking, and `npm start`'s poll ran WeHo's
cycle end to end off that correctly-attributed booking with no manual trigger
involved.
**Accept:** a location with no upcoming booking runs no cycle (verified with
`calendarId: ""`); a location with a booking in N days runs a cycle at the
configured lead time before it (verified live, above); a manual trigger
(`npm run run-reorder-cycle`) still works as a per-location override.

### FR-29 — Pre-booking inventory check-in notification · P1
`[x]`
Separate from FR-28's 48h auto-reorder trigger: 216h (9 days) before a
location's next booking (same shared-calendar `locationMatch` lookup as FR-28,
reusing `googleCalendar.js`/`locations.js` — `checkin.js`'s `pollCheckins`
mirrors `scheduler.js`'s `pollDueLocations`), post a notification to
`APPROVAL_CHANNEL_ID`, tagged `[LocationName]`, showing that location's current
inventory (on-hand/threshold per item, via `getInventoryItems` — informational
only, no Approve/Deny, no orders placed) with a single **Done** button
(`buildCheckinBlocks` in `blockKit.js`). Manual physical-stock-check prompt for
a human, not a reorder decision.
The notification **re-pings every 24h** if unacknowledged, as a lightweight new
message (no inventory re-fetch — `buildCheckinReminderBlocks`) rather than an
edit, so channel history shows the escalation. New persistent store
(`checkinStore.js`, own `checkins` table in the same SQLite file as
`pendingStore.js`, different lifecycle: no claim→place→remove, just
posted → re-pinged → acknowledged) keyed by `${locationName}::${bookingStartISO}`
(`buildCheckinId`) so a new booking for the same location gets a fresh record
instead of colliding with an already-acknowledged one. `decideCheckinAction` in
`checkin.js` is the pure decision function (`none`/`create`/`reping`/`wait`),
unit-tested for the lead-time boundary, the reping-interval boundary, and the
already-acknowledged case. `checkinStore.claim` reuses FR-07's atomic-UPDATE
pattern so a double-click can't process twice.
Two new config knobs, both env-var-overridable with the same pattern as
`leadTimeHours()`/`pollIntervalMinutes()`: `CHECKIN_LEAD_TIME_HOURS` (default
216) and `CHECKIN_REPING_HOURS` (default 24). `app.js`'s existing poll loop now
runs both `pollDueLocations` and `pollCheckins` each tick. `npm run
run-checkin-poll` triggers a poll manually for testing, mirroring
`run-reorder-cycle`.
**Bug caught during live verification, fixed same session:** since every
re-ping is a distinct Slack message all sharing one `checkinId`/button, a click
on a message that *isn't* the one that resolved the check-in used to do
nothing — `claim()` correctly returned `undefined` (already acknowledged) but
the handler then just returned early, leaving that specific message stuck
showing a live but inert Done button with zero feedback. Fixed in
`app.js`'s `confirm_checkin` handler: on a failed claim, fall back to
`checkinStore.get()` and still update the clicked message to show who actually
confirmed, instead of silently no-op-ing. Covered by a new test in
`test/checkinStore.test.js` asserting `get()` returns the acknowledged record
(with the *original* claimer, not the second caller) after a failed claim.
Live-verified end to end against the real workspace across all 3 locations:
initial creation for WeHo and Rock Nashville (both within 216h), Rock Lititz
correctly skipped (480h out, beyond lead time) until temporarily overriding
`CHECKIN_LEAD_TIME_HOURS`/`CHECKIN_REPING_HOURS` to prove the `create` → `reping`
path live without waiting 24 real hours; Done confirmed correctly from both an
original message and a re-ping message (post-fix); a restart correctly saw
already-open records and didn't duplicate them.
**Accept:** a booking 216h out gets exactly one initial notification (verified);
if unacknowledged, a new ping appears roughly every 24h as a new message
(verified, accelerated); clicking Done stops all further pings and logs
who/when (verified); a restart mid-escalation doesn't lose track of what's
still outstanding or repost a fresh notification for an already-acknowledged
booking (verified — de-dup held across a restart during live testing).

---

## Phase 2 — Reliability & state

### FR-06 — Persistent pending-draft store · P1
`[x]`
Replaced the in-memory `Map` in `pendingStore.js` with SQLite via `node:sqlite`
(built into Node 22+, no new dependency) — same `put/get/remove/list` interface,
so `reorderCycle.js` and `app.js` needed no changes. DB file defaults to
`data/cav_chef.sqlite` (gitignored), overridable via `PENDING_STORE_DB_PATH`. A
`createPendingStore(filePath)` factory (plus `:memory:` support) makes it
testable in isolation. Unit-tested (`test/pendingStore.test.js`) including a
literal "restart" case — a fresh store instance reopening the same file sees
prior drafts.
Verified live: posted a batch prompt, killed the `npm start` process entirely
(not just the shell, the actual `node.exe`), started a brand-new process (fresh
Socket Mode connection, no shared memory with the old one), then clicked Approve
on the pre-restart prompt — it resolved correctly, placing all 3 mock orders.
This is the exact failure mode hit earlier this session with orphaned processes
under the old in-memory store; now fixed.
**Accept:** a pending prompt survives a process restart and its buttons still
resolve — verified live, above.

### FR-07 — Idempotent order placement · P0
`[x]`
`pendingStore.claim(draftId)` atomically transitions a draft `'pending' →
'placing'` via one conditional `UPDATE ... WHERE status = 'pending'` — SQLite
guarantees the statement itself is atomic, and since it's synchronous
(`node:sqlite`) there's no `await` gap where a second concurrent handler could
interleave before the first claims it. Both `approve_reorder` and
`deny_reorder` in `app.js` now call `claim` instead of `get`; a failed claim
(already claimed/resolved/missing) is a silent no-op, same as the old
missing-draft case. `orderingClient.buildIdempotencyKey(draftId, asin)`
produces a stable per-item reference key threaded through `placeOrder` — ready
for FR-14 to pass as Amazon's client reference token so a network-level retry
can't double-place there either.
Also fixed in passing: `pendingStore.js`'s `CREATE TABLE IF NOT EXISTS` doesn't
alter an existing table, so a pre-FR-07 SQLite file (from FR-06 testing this
same session) was missing the new `status` column — added a migration
(`PRAGMA table_info` check + `ALTER TABLE ADD COLUMN` if missing) and a test
covering it.
Unit-tested (`test/pendingStore.test.js`): a second `claim` on an already-claimed
draft returns `undefined`; claiming resets on re-`put`; a claimed-but-not-removed
draft still counts for FR-02 dedup; the legacy-DB migration path.
Live-verified: a normal single Approve resolves correctly with proper
idempotency keys logged (`draftId:asin`). A literal rapid double-click couldn't
be produced through the Slack UI itself — Slack disables the button client-side
after the first click — so the "two rapid clicks" scenario is proven at the
level that actually matters: the atomic claim only ever succeeds once, verified
directly by the unit tests above rather than a manual UI race.
**Accept:** two rapid Approve clicks on one prompt place exactly one order —
proven via `claim`'s atomicity (unit-tested) since Slack's own UI prevents
manually reproducing literal concurrent clicks.

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
*Do all of these before flipping `AMAZON_MODE=live`. This system spends real money.
All three done — approver allowlist, price-drift guardrail, and audit log are
all live. Still worth revisiting `ALLOW_SELF_SECOND_APPROVAL` (FR-11) once the
team is bigger than 3 people, and filling in `unit_price` on the Lists so the
drift check has real data instead of always treating price as unverifiable.*

### FR-10 — Approver authorization allowlist · P0
`[x]`
`approvers.js`: `APPROVER_ALLOWLIST` (comma-separated Slack user ids, required —
added to `startupCheck.js`'s `REQUIRED_ENV_VARS`, and each id is verified to be a
real Slack user via `users.info` on boot, same fail-fast pattern as the channel
and calendar checks). `isApprover(userId)` gates **both** `approve_reorder` and
`deny_reorder` in `app.js` (not just Approve — an unauthorized user shouldn't be
able to reject a legitimate reorder either) via a shared `rejectUnlessApprover`
helper, checked *before* `pendingStore.claim` so a rejected click never
consumes the draft — it stays open for a real approver. A rejected click gets
`chat.postEphemeral` (visible only to that user), not a channel message.
Scoped to reorder Approve/Deny only — FR-29's check-in Done button is
deliberately not gated, since acknowledging a physical-stock check isn't a
spend action. User-id allowlist only (no Slack group/subteam support) — kept
out of scope per FR-10's own "(or a group)" being optional, and nothing so far
has needed it.
Unit-tested (`test/approvers.test.js`): empty/unset throws, single and
multi-id parsing with whitespace/trailing-comma handling, membership checks.
Live-verified against the real workspace both ways: temporarily set the
allowlist to a different real user and confirmed your own Approve click was
rejected (`chat.postEphemeral` succeeded, no `chat.update`/claim happened, the
prompt stayed open and was later approved normally); restored the real
allowlist and confirmed Approve then worked normally end to end (mock orders
placed, message updated). Startup validation also verified both ways: a bad
user id in the allowlist fails boot with `user_not_found`, a valid one passes.
**Accept:** a non-authorized user clicking Approve does not place an order and sees a
"not authorized" message; the prompt stays open — verified live, above.

### FR-11 — Budget guardrails · P0
`[x]`
Reworked from the original static per-order/daily-cap spec into a **price-drift**
guardrail, per direction from the user: rather than fixed dollar caps, compare
each draft's expected total (computed when posted) against its current total
(re-checked at approval time via `orderingClient.getCurrentPrice`, a seam for
FR-14 to eventually source from Amazon's real cart price — no live source
exists yet, so mock mode simulates drift via `MOCK_PRICE_DRIFT_PER_UNIT` for
testing). `budget.js`'s pure `evaluateDraftTotal` sums the delta across all
items and decides: no/negative drift → proceeds silently; drift under
`PRICE_DRIFT_THRESHOLD` (default $50) → proceeds, but the resolved message
notes the increase; drift at/over threshold, **or any item's price can't be
verified at all** (missing `unit_price` — the current reality for all 3 real
Lists) → blocks placing and requires a second, distinct approver.
`pendingStore.js` gained a third status, `awaiting_second_approval`, and three
new methods: `flagForSecondApproval` (first approve on a high-drift draft,
'pending'-only), `claimSecondApproval` (second approve — atomically rejects
the *same* user who flagged it, via `firstApprover === secondApprover` check
before the claiming UPDATE), and `claimForResolution` (lets Deny cancel from
either 'pending' or 'awaiting_second_approval', so canceling a flagged order
doesn't need a second approver to show up first). `app.js` routes the first
Approve click through the drift check; over-threshold posts
`buildPriceDriftBlocks` (a "Confirm at new price" button, `confirm_price_drift`
action) instead of placing orders; the second approver's click reuses the
price locked in at flag time rather than re-checking (avoids compounding
drift across two checks).
Unit-tested thoroughly (`test/budget.test.js`, `test/pendingStore.test.js`,
`test/orderingClient.test.js`): drift boundaries, missing-price handling,
same-user rejection, distinct-approver success, deny-from-either-status.
Live-verified against the real workspace for everything reproducible with one
real approver and no live price data (which is the actual current state of
all 3 Lists): a real Approve click correctly flagged for second approval
(missing price → unverifiable); the same user attempting "Confirm at new
price" was correctly rejected with an ephemeral message and the draft stayed
untouched (confirmed via direct DB read); Deny correctly canceled both a plain
pending draft and one already flagged for second approval. The distinct-second-
approver-succeeds path and the low-drift single-approve-with-note path aren't
independently live-reproducible right now (one real user, no `unit_price`
data anywhere) — both rely on the unit tests above, which directly exercise
the exact same atomic store methods and pure decision logic the live paths
use.
**Update:** with only 3 people at the company, real dual control (a second
*distinct* person) isn't always available yet. Added `ALLOW_SELF_SECOND_APPROVAL`
(default unset/false — dual control still enforced) as a config toggle, not a
removal of the logic: `pendingStore.claimSecondApproval` takes an `allowSameUser`
flag that skips just the `firstApprover === secondApprover` check while keeping
everything else (the atomic claim, the audit trail of who flagged vs. who
confirmed) intact — a one-line flip back to strict dual control once there are
enough approvers. `.env` currently has it set to `true`. Live-verified: flagged
a real draft (Approve → "needs a second approver"), then the *same* user
clicked "Confirm at new price" and — with the override on — it succeeded this
time (mock orders placed, log shows both the flag and the confirm from the
same user id against the same batch id), where before the override it was
correctly rejected.
**Accept (reworked from the original static-cap wording):** a draft with
unverifiable or high-drift pricing can't be single-approved (verified live);
canceling it via Deny doesn't require a second approver (verified live); a
second, distinct approver is required to place it, and the same approver who
flagged it cannot also confirm it, unless `ALLOW_SELF_SECOND_APPROVAL` is set
(both paths verified live).

### FR-12 — Pending-approval expiry · P1
`[ ]`
Auto-expire prompts after a configurable window (e.g. 24h) so stale drafts can't be
approved days later at a drifted price. Update the message to "expired."
**Accept:** approving after the window is refused; the message shows expired state.

### FR-13 — Audit log of decisions & orders · P1
`[x]`
`auditLog.js`: a new, append-only `audit_log` SQLite table (same file as
`pendingStore`/`checkinStore`) — deliberately separate from `pendingStore`'s
mutable `drafts` table, since those rows get deleted once resolved and would
lose history. `log(eventType, {draftId, locationName, at, data})` records four
event types: `posted` (reorderCycle.js, on every prompt — items + expected
total), `flagged_second_approval` (app.js, FR-11's first-approve-on-drift
click — who, expected/current/delta totals), `approved` (app.js's shared
`placeAndResolve`, covers both the direct and second-approval paths — who
decided, who flagged it if different, per-item expected charge / actual
charge / order id), and `denied` (who, items). `forDraft(draftId)` returns
the full chronological timeline for one draft; `recent(limit)` lists across
all locations. `scripts/audit-log.js` (`npm run audit-log [draftId]`) is the
retrieval interface — no draftId prints the 50 most recent entries, a draftId
prints that draft's full timeline, human-readable.
Scoped to reorder decisions/orders only, per the accept criteria — FR-29's
check-in acknowledgments aren't logged here (different subsystem, not a spend
decision).
Unit-tested (`test/auditLog.test.js`): CRUD, chronological ordering, per-draft
filtering, the `recent` window and its limit.
Live-verified against the real workspace end to end: posted a real Rock
Lititz batch, flagged it for second approval, approved it (self-second-approval
via FR-11's override) — `npm run audit-log <draftId>` then correctly showed
all three events in order with the real user id, the real mock order ids, and
correct expected/actual charges (both `(unknown)`, accurately reflecting that
this List has no `unit_price` yet); `npm run audit-log` with no argument
correctly listed recent activity across all three locations.
**Accept:** for any placed or denied order you can retrieve who decided, when, the items,
the expected vs actual total, and the resulting order id — verified live, above.

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
2. ~~FR-27~~ ~~FR-28~~ ~~FR-29~~ done — multi-location, calendar-driven reorder trigger, and
   pre-booking check-in notification all live.
3. ~~FR-06~~ ~~FR-07~~ done — Phase 2's reliability floor (state + idempotency) is complete.
4. ~~FR-10~~ ~~FR-11~~ ~~FR-13~~ done — Phase 3 (spend safety & governance) is complete.
5. FR-14 (+ FR-15) — go live on one item once the role clears.
6. Everything else as you harden toward wider rollout.
