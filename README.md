# CAV_Chef

Reads each location's inventory Slack List, flags rows at or below their reorder
threshold, and posts one batched Approve All/Deny All prompt per location to a
shared approval channel. Approving places a mock order for each flagged item.
See [FEATURE_REQUESTS.md](./FEATURE_REQUESTS.md) for the full roadmap, and
[DATA_HANDLING.md](./DATA_HANDLING.md) / [INCIDENT_RESPONSE_PLAN.md](./INCIDENT_RESPONSE_PLAN.md)
for how Amazon Information (including PII) is classified, minimized, retained,
and responded to if something goes wrong — required by Amazon's Data
Protection Policy for any app with Amazon Business ordering access.

This is a **separate Slack app** from `cav_butler` and the CAV Intake Bot
(`cav-workflow-steps`) — it reads different Slack Lists and will eventually carry
real spend authority (placing Amazon orders), which is a different trust profile
than either of those bots. Own manifest, own tokens, own process.

## Status

Phase 1 (correctness), Phase 1.5 (scheduling & multi-location), and Phase 3
(spend safety & governance) are all done; Phase 2 (reliability)'s state and
idempotency floor (FR-06/FR-07) is done, with graceful shutdown/recovery
(FR-09) partially live (see below) and retry/backoff (FR-08) still open.
Config/column validation on boot (FR-01), unit tests for the threshold logic
(FR-03), and cross-cycle de-dup so a still-low item doesn't get re-prompted every
cycle (FR-02). Multi-location support (FR-27): each location has its own
inventory List, all locations share one approval channel, and every prompt is
tagged with its location name. Calendar-driven triggering (FR-28): each location
with a `calendarId` configured auto-runs its cycle once its next booking is
within the lead time, instead of a flat schedule; a location without one just
runs on manual trigger. Pending drafts persist across restarts in SQLite
(`data/cav_chef.sqlite`, FR-06) — an in-flight approval survives a crash or
redeploy. Approving/denying atomically claims the draft first (FR-07), so a
double-click or redelivered event can't place duplicate orders. A separate
pre-booking inventory check-in notification (FR-29) posts 216h before a
location's next booking with current stock levels and a Done button, re-pinging
every 24h until acknowledged — independent of the 48h auto-reorder trigger.
Approve/Deny are restricted to an allowlist of Slack user ids (FR-10) — anyone
else clicking gets a private "not authorized" message and the prompt stays
open. A price-drift guardrail (FR-11) checks the current price against what
was expected when a draft was posted: no meaningful change proceeds normally,
a small increase proceeds with a note, and a $50+ increase — or a price that
can't be verified at all, which is the current reality since no List has
`unit_price` filled in yet — blocks placing and requires a second, distinct
approver via a "Confirm at new price" button (or the same approver, with
`ALLOW_SELF_SECOND_APPROVAL=true`, a small-team override — see FR-11 below);
Deny still works without one. A draft left unresolved for too long
auto-expires (FR-12, default 24h, `PENDING_APPROVAL_EXPIRY_HOURS` to
override) — the message updates to show it expired and the buttons stop
doing anything, so nobody can approve days later at a since-drifted price.
Every prompt, decision, and order result is durably logged (FR-13) — `npm run
audit-log [draftId]` retrieves who decided, when, the items, expected vs.
actual charge, and the resulting order id.

Phase 3 (spend safety & governance) is fully done. Live Amazon ordering
(FR-14/FR-15) is *coded* — the Ordering API request, LWA auth, and token
caching all exist in `orderingClient.js`/`amazonAuth.js` — but genuinely
**unverified**: there are no Amazon Business credentials yet to test against,
so it's built from public docs and explicitly not to be trusted at face value.
`AMAZON_MODE` still defaults to (and should stay) `mock` until this is checked
against a real order — see FR-14 in `FEATURE_REQUESTS.md` for exactly what's
confirmed vs. inferred.

The app's own logs are structured JSON (FR-18) — `LOG_LEVEL` (default `info`)
controls Bolt's internal verbosity separately from that; a `GET /health`
endpoint (FR-20, default port 8080, `PORT` to override) reports the last
successful poll time, and `placeOrder`/poll failures post an alert to
`APPROVAL_CHANNEL_ID` (FR-19) instead of only going to stdout.

### Shutdown & crash recovery (FR-09)

`npm start` responds to `SIGTERM`/`SIGINT` by stopping the poll loop and the
Socket Mode connection before exiting, instead of being killed mid-cycle —
important on Cloud Run, which sends `SIGTERM` on every redeploy/scale event.
Verified on this (Windows) dev machine that *forcing* the process closed
(`Stop-Process`, `taskkill`) does **not** exercise this path — Windows
doesn't deliver real `SIGTERM`; confirming the graceful path itself needs a
real restart on Linux/Cloud Run.
Separately, on every boot, any draft still sitting in `'placing'` — meaning
a previous process crashed mid-approval — gets flagged with a log warning
and a Slack alert to `APPROVAL_CHANNEL_ID` naming the draft. It's **not**
auto-resolved: there's no safe way to guess from here whether the
underlying order actually went through, so it's left exactly as found for a
human to check against Amazon Business/Slack history and resolve by hand.

## Setup

1. Create a new Slack app at https://api.slack.com/apps/new → "From an app manifest"
   → paste in [manifest.json](./manifest.json).
2. Install it to the CAV workspace.
3. Copy `.env` values:
   - **Bot User OAuth Token** (OAuth & Permissions) → `SLACK_BOT_TOKEN`
   - **App-Level Token** (Basic Information → App-Level Tokens, needs
     `connections:write`) → `SLACK_APP_TOKEN`
4. For each location, create (or locate) its inventory Slack List with columns:
   `name` (text) and a column recognized as the ASIN field — either a plain `asin`
   text column or a `link`-type column pointing at the Amazon product page (the
   ASIN is parsed out of `/dp/ASIN` or `/gp/product/ASIN` in the URL; shortened
   links like `a.co/...` can't be resolved this way). Also needs `on_hand` (number
   — `in_stock`/`qty_on_hand` etc. also match) and `threshold` (number), plus
   optionally `reorder_qty` (number, defaults to 1 if missing) and `unit_price`
   (number, used to compute the expected charge shown on each prompt — also
   what the FR-11 price-drift check compares against; without it, every
   approval is treated as unverifiable and needs a second approver).
5. Share each List with the bot user (or the workspace), and note each List's
   file ID.
6. Set `LOCATIONS_JSON` in `.env` to a JSON array, one entry per location:
   ```
   LOCATIONS_JSON=[{"name":"WeHo","listId":"F0BLN7YRUDN","calendarId":""},{"name":"DTLA","listId":"...","calendarId":""}]
   ```
   `calendarId` powers the calendar-driven trigger (FR-28, see below) — leave it
   `""` for a location until you've set that up. Adding a location is a
   config-only change, no code edit needed.
7. Pick (or create) one shared channel for reorder prompts across all locations,
   invite the bot to it (`/invite @CAV_Chef`), and put its channel ID in
   `APPROVAL_CHANNEL_ID`.
8. Set `APPROVER_ALLOWLIST` in `.env` to a comma-separated list of Slack user
   ids allowed to click Approve/Deny (find a user's id via their profile →
   "Copy member ID"), e.g. `APPROVER_ALLOWLIST=U5EM8P96D,U0123456789`. Required
   — the app won't start without it, and boot fails if any id isn't a real
   Slack user.
9. Tune `PRICE_DRIFT_THRESHOLD` (default 50 — the $ increase in a draft's
   total that requires a second approver, see FR-11 below) in `.env` if it
   doesn't fit.

```sh
npm install
npm run lint
npm test
npm run check-inventory-list
```

`npm run lint` and `npm test` both run in CI (`.github/workflows/ci.yml`) on
every PR into `main` and every push to `main` — a failing lint or test blocks
the run (FR-22).

`check-inventory-list` prints every row the bot can read for every configured
location and flags which ones would currently get a reorder prompt — no messages
are posted, nothing is written anywhere.

### Calendar-driven triggering (FR-28)

Each location's reorder cycle can run based on that location's next booking
instead of a flat schedule — restock a location once its next booking is within
a configurable lead time, skip it otherwise. All locations' bookings live in
**one shared** Google Calendar; each event's `location` field identifies the
site (e.g. `"WeHo Nashville VizLab 1"`), and each location's `locationMatch`
picks its bookings out of the shared calendar by matching that field.

1. In Google Cloud Console, create (or use) a project, enable the **Google
   Calendar API**, and create a **service account**. Generate a JSON key for it
   and note the service account's email address (looks like
   `name@project.iam.gserviceaccount.com`).
2. Save the key file somewhere on this machine and set
   `GOOGLE_APPLICATION_CREDENTIALS` in `.env` to its path.
3. Share the shared bookings calendar with the service account's email
   (Settings and sharing → Share with specific people → paste the email, "See
   all event details" is enough since this only reads). Put that calendar's ID
   (Settings → Integrate calendar → Calendar ID) into every location's
   `calendarId` in `LOCATIONS_JSON` — it's the same value for all of them.
4. For each location, set `locationMatch` to the text that uniquely identifies
   its bookings in the shared calendar's `location` field — the site name minus
   the room/lab number, e.g. `"WeHo Nashville"` matches `"WeHo Nashville VizLab
   1"`, `"WeHo Nashville VizLab 2"`, etc. Matching is a case-insensitive
   substring check, so make sure each location's text doesn't also appear in
   another's (e.g. `"Rock Nashville"` vs. `"Rock Lititz"`, not just `"Rock"`).
   Bookings that don't match any location's text (e.g. `"Remote"` mobile-gear
   rentals) never trigger anything. If omitted, `locationMatch` defaults to the
   location's `name`.
5. Tune `CALENDAR_LEAD_TIME_HOURS` (default 48 — how close a booking needs to be
   to trigger a cycle) and `CALENDAR_POLL_INTERVAL_MINUTES` (default 60 — how
   often `npm start` checks) in `.env` if the defaults don't fit.

```sh
npm run check-calendar
```

Read-only smoke test: prints each location's next matching booking and whether
it would trigger a cycle right now, without posting anything or running any
cycle. A location with no `calendarId` set just reports "manual trigger only" —
no Google call is made for it, so this is safe to run before any calendar is
configured.

### Pre-booking inventory check-in (FR-29)

Separate from the 48h auto-reorder trigger above: 216h (9 days) before a
location's next booking, `npm start` posts a notification showing that
location's current inventory (on-hand/threshold, no ordering action) with a
single **Done** button, tagged `[LocationName]`. If nobody clicks Done, a new
lightweight reminder message posts every 24h until someone does. Uses the same
shared-calendar `locationMatch` lookup as FR-28, so no extra calendar setup is
needed once that's configured — a location with no `calendarId` is skipped here
too.

Tune `CHECKIN_LEAD_TIME_HOURS` (default 216) and `CHECKIN_REPING_HOURS`
(default 24) in `.env` if the defaults don't fit.

```sh
npm run run-checkin-poll
```

Manually triggers a check-in poll against a running `npm start` process, for
testing without waiting on the real cadence.

Note: every re-ping is a new Slack message, and all of them (the original post
and every re-ping) share the same underlying record — clicking Done on *any* of
them resolves it, and clicking Done on one *after* it's already been resolved
elsewhere still updates that message to show who actually confirmed, rather
than doing nothing.

## Running the approve/deny flow end to end

In one terminal:

```sh
npm start
```

This validates config on boot (refuses to start on a bad `.env` or List schema —
see FR-01), then polls every `CALENDAR_POLL_INTERVAL_MINUTES` (default 60):
locations with a `calendarId` configured get a cycle whenever their next booking
enters `CALENDAR_LEAD_TIME_HOURS`; locations without one are skipped entirely and
only run via manual trigger.

To trigger a cycle for every location right now, regardless of calendar state
(bypasses FR-28 entirely — useful for testing, or locations with no calendar set
up yet):

```sh
npm run run-reorder-cycle
```

Each location gets its own batched prompt (all its flagged items, one Approve
All/Deny All) posted to `APPROVAL_CHANNEL_ID`, tagged with the location name.
Click **Approve All** or **Deny All** in Slack — the running `npm start` process
handles the click, places a mock order per item on Approve, and updates the
message in place. Only users in `APPROVER_ALLOWLIST` can do this (FR-10); anyone
else gets a private "not authorized" message and the prompt stays open. A
location with a batch still pending skips its next cycle rather than posting a
duplicate (FR-02).

### Price-drift guardrail (FR-11)

Approve doesn't always place orders immediately. It first checks the draft's
current total against what was expected when it was posted:

- No increase, or a small one under `PRICE_DRIFT_THRESHOLD` — proceeds
  normally (a small increase is noted in the resolved message, but doesn't
  block).
- An increase at/over the threshold, **or a price that can't be verified at
  all** (any item missing `unit_price` on its List — the current state of all
  3 Lists) — doesn't place anything. The message updates to show the
  increase and a **Confirm at new price** button, tagged with who flagged it.

A second, distinct approver (also in `APPROVER_ALLOWLIST`) has to click
**Confirm at new price** before orders place — the same person who flagged it
clicking again normally gets rejected with a private message. **Deny All**
still cancels it either way, no second approver needed to cancel.

With a small team, a second distinct approver isn't always around. Set
`ALLOW_SELF_SECOND_APPROVAL=true` in `.env` to let the same user confirm their
own flag instead — the dual-control check itself is still there in the code,
this just skips it; unset it (or set to anything else) once there are enough
approvers to go back to requiring a different person.

There's no live Amazon price feed yet (see FR-14), so mock mode can't
naturally produce drift — set `MOCK_PRICE_DRIFT_PER_UNIT` (a flat $ amount
added to every unit's price) to simulate it for testing.

### Pending-approval expiry (FR-12)

A draft (including one already flagged for second approval) that sits
unresolved for too long auto-expires on `npm start`'s regular poll tick —
its message updates to show it expired and neither button does anything
after that, forcing a fresh cycle (and a fresh price check) instead of
letting someone approve days later at a stale price.

Tune `PENDING_APPROVAL_EXPIRY_HOURS` (default 24) in `.env` if the default
doesn't fit.

```sh
npm run run-expiry-poll
```

Manually triggers an expiry poll against a running `npm start` process, for
testing without waiting on the real cadence.

### Audit log (FR-13)

Every reorder prompt posted, decision made (flagged for second approval,
approved, denied), and order placed is written to a durable, append-only log —
separate from the pending-draft store, so the history survives even after a
draft is resolved and removed from it. Retained long-term for governance, so
it's held to a stricter bar than most logs: `auditLog.js` enforces a field
allowlist at its single write choke point, so only vetted, non-PII fields
(internal Slack user ids, item asin/name/qty/price, order ids) can ever be
persisted — anything else, like a stray buyer email or ship-to address, is
silently dropped before it reaches SQLite, not after.

```sh
npm run audit-log
```

Prints the 50 most recent entries across all locations.

```sh
npm run audit-log <draftId>
```

Prints the full timeline for one draft — e.g. `posted` → `flagged_second_approval`
→ `approved` — showing who decided, when, the items, expected vs. actual charge
per item, and the resulting order id.

### Live Amazon ordering (FR-14/FR-15) — coded, unverified

**Do not set `AMAZON_MODE=live` for a real order yet.** This is implemented
against Amazon's public Ordering API docs with no real credentials to test
against — treat it as a sketch to verify, not a working integration. See
FR-14 in `FEATURE_REQUESTS.md` for exactly which parts are confirmed vs.
inferred from the docs.

Once you have the Amazon Business **Order Placement** role and LWA app
credentials, fill in:

```
AMAZON_CLIENT_ID=
AMAZON_CLIENT_SECRET=
AMAZON_REFRESH_TOKEN=
AMAZON_REGION=na          # na | eu | fe
AMAZON_REGION_CODE=US     # the Region attribute's value, e.g. US/CA/MX for na
AMAZON_PAYMENT_METHOD_ID=
AMAZON_BUYING_GROUP_ID=
AMAZON_BUYER_EMAIL=
AMAZON_SHIP_TO_ADDRESS_ID=
```

Then, before ever pointing this at a real spend-capable account: set
`AMAZON_MODE=live`, place one cheap/returnable item as a dry run, confirm the
order actually appears in Amazon Business, and cross-check `orderingClient.js`'s
request/response handling against what Amazon actually returned — the EU/FE
base URLs and the exact attribute wire format are the least-confirmed parts
and most likely to need fixing first.

## Deploying to Google Cloud Run (FR-23)

No GCP project exists yet to actually run `gcloud run deploy` against, so
**this has not been deployed for real** — the `Dockerfile` build itself is
verified (a dedicated CI job builds it and confirms the container starts
cleanly, see `.github/workflows/ci.yml`), but the deploy steps below are
documented, not executed.

**This is a persistent worker, not a request-driven service** — Socket Mode
holds an open WebSocket, and the poll loop runs on a timer independent of any
inbound HTTP request. Cloud Run defaults (scale-to-zero, CPU throttled
between requests) would starve both. Deploy with:

```sh
gcloud run deploy cav-chef \
  --image <your-image> \
  --region <your-region> \
  --min-instances=1 \
  --max-instances=1 \
  --no-cpu-throttling \
  --port=8080
```

`--min-instances=1` keeps exactly one instance always running (no scale-to-zero
killing the Socket Mode connection); `--max-instances=1` avoids two instances
both polling and potentially double-posting; `--no-cpu-throttling` keeps CPU
allocated between requests so `setInterval`'s poll loop and the WebSocket
connection both keep running, not just during an inbound HTTP request to
`/health`.

### Secrets (FR-21)

Cloud Run can inject Secret Manager secrets directly as environment variables
at deploy time — no application code change needed, since config is already
read via `process.env` everywhere:

```sh
gcloud secrets create slack-bot-token --data-file=- <<< "$SLACK_BOT_TOKEN"
# ...repeat for SLACK_APP_TOKEN, APPROVER_ALLOWLIST, and anything else sensitive

gcloud run deploy cav-chef \
  ... \
  --set-secrets=SLACK_BOT_TOKEN=slack-bot-token:latest,SLACK_APP_TOKEN=slack-app-token:latest
```

For `GOOGLE_APPLICATION_CREDENTIALS`: rather than shipping a downloaded service
account key file at all, the cleaner Cloud Run–native approach is to grant the
Cloud Run service's own runtime service account Calendar API access directly
(share each location's calendar with `<service-account>@<project>.iam.gserviceaccount.com`,
Cloud Run's default or a custom one) and leave `GOOGLE_APPLICATION_CREDENTIALS`
unset — `googleCalendar.js`'s `google.auth.GoogleAuth()` already falls back to
Application Default Credentials with no code change needed.

### Known gap: local SQLite storage doesn't survive a Cloud Run redeploy

`pendingStore.js`/`checkinStore.js`/`auditLog.js` all write to local disk
under `data/`. On Cloud Run, local disk is ephemeral per instance — a redeploy,
crash-and-restart, or instance replacement loses pending drafts, check-ins,
and audit history. This wasn't addressed as part of FR-23; before relying on
this in production, either mount a persistent volume (Cloud Run supports GCS
FUSE or direct persistent disk mounts) at `/app/data`, or migrate these three
stores to a managed database (e.g. Cloud SQL). Worth deciding before the first
real deploy, not after losing state in one.
