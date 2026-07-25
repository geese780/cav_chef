# CAV_Chef

Reads an inventory Slack List, flags rows at or below their reorder threshold, and
posts an Approve/Deny prompt to Slack for each. Approving places a mock order for
now. See [FEATURE_REQUESTS.md](./FEATURE_REQUESTS.md) for the full roadmap.

This is a **separate Slack app** from `cav_butler` and the CAV Intake Bot
(`cav-workflow-steps`) — it reads a different Slack List and will eventually carry
real spend authority (placing Amazon orders), which is a different trust profile
than either of those bots. Own manifest, own tokens, own process.

## Status — Phase 1 baseline only

This is the starting scaffold described at the top of `FEATURE_REQUESTS.md`: Slack
read → threshold check → Block Kit Approve/Deny → message update, running end to
end in mock mode (`AMAZON_MODE=mock`). Everything else in `FEATURE_REQUESTS.md`
(FR-01 onward) is still to do — notably:

- **No persistence** — pending drafts live in memory and are lost on restart (FR-06).
- **No de-dup** — an item still below threshold next cycle gets a new prompt (FR-02).
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
4. Create (or locate) the inventory Slack List with columns: `name` (text), `asin`
   (text), `on_hand` (number), `threshold` (number), and optionally `reorder_qty`
   (number, defaults to 1 if missing) and `unit_price` (number, used to compute the
   expected charge shown on each prompt — omit it and prompts just won't show one).
   Copy the List's file ID into `INVENTORY_LIST_ID`.
5. Pick (or create) a channel for reorder prompts, invite the bot to it
   (`/invite @CAV_Chef`), and put its channel ID in `APPROVAL_CHANNEL_ID`.
6. Make sure the bot has access to the inventory List (share it with the bot user
   or the workspace).

```sh
npm install
npm run check-inventory-list
```

This prints every row the bot can read and flags which ones would currently get a
reorder prompt — no messages are posted, nothing is written anywhere.

## Running the approve/deny flow end to end

In one terminal:

```sh
npm start
```

In another:

```sh
npm run run-reorder-cycle
```

This posts a prompt to `APPROVAL_CHANNEL_ID` for every row at/below threshold.
Click **Approve** or **Deny** in Slack — the running `npm start` process handles
the click, places a mock order on Approve, and updates the message in place.
