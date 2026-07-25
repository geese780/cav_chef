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

Phase 1 correctness is done: config/column validation on boot (FR-01), unit tests
for the threshold logic (FR-03), and cross-cycle de-dup so a still-low item doesn't
get re-prompted every cycle (FR-02). Multi-location support (FR-27) is in — each
location has its own inventory List, all locations share one approval channel, and
every prompt is tagged with its location name. Still to do, notably:

- **No calendar-driven trigger yet** — cycles run manually or on `npm start`, not
  based on a location's next booking (FR-28).
- **No persistence** — pending drafts live in memory and are lost on restart (FR-06).
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
   `calendarId` is reserved for the calendar-driven trigger (FR-28) and unused for
   now — leave it `""` until that lands. Adding a location is a config-only change,
   no code edit needed.
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

## Running the approve/deny flow end to end

In one terminal:

```sh
npm start
```

This validates config on boot (refuses to start on a bad `.env` or List schema —
see FR-01) and immediately runs one reorder cycle per location.

To trigger additional cycles against the same running process:

```sh
npm run run-reorder-cycle
```

Each location gets its own batched prompt (all its flagged items, one Approve
All/Deny All) posted to `APPROVAL_CHANNEL_ID`, tagged with the location name.
Click **Approve All** or **Deny All** in Slack — the running `npm start` process
handles the click, places a mock order per item on Approve, and updates the
message in place. A location with a batch still pending skips its next cycle
rather than posting a duplicate (FR-02).
