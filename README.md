# CAV_Chef

Reads each location's inventory Slack List, flags rows at or below their reorder
threshold, and posts one batched Approve All/Deny All prompt per location to a
shared approval channel. Approving places a mock order for each flagged item.
See [FEATURE_REQUESTS.md](./FEATURE_REQUESTS.md) for the full roadmap.

This is a **separate Slack app** from `cav_butler` and the CAV Intake Bot
(`cav-workflow-steps`) — it reads different Slack Lists and will eventually carry
real spend authority (placing Amazon orders), which is a different trust profile
than either of those bots. Own manifest, own tokens, own process.

## Status

Phase 1 (correctness) and Phase 1.5 (scheduling & multi-location) are both done.
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
double-click or redelivered event can't place duplicate orders. Still to do,
notably:

- **No approver allowlist** — anyone who can click Approve/Deny can (FR-10).
- **No budget guardrails** — there is no spend cap yet (FR-11).
- **No live Amazon integration** — `placeOrder` always mocks (FR-14).

Do not point this at a real spend-capable Amazon account until at least Phase 3
(spend safety & governance) of the roadmap is done.

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
   (number, used to compute the expected charge shown on each prompt).
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

```sh
npm install
npm test
npm run check-inventory-list
```

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
message in place. A location with a batch still pending skips its next cycle
rather than posting a duplicate (FR-02).
