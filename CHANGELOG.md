# Changelog

## 0.4.0 (2026-11-14)

- Install from npm: `npx -y ads-mcp-for-snapchat` starts the server. `init`, `where`, `save-secret`, `auth`, `check` and `weekly-report` replace `node scripts/...` for installed copies; `help` lists them.
- An installed copy keeps its settings, change log and exports in `~/.ads-mcp-for-snapchat` (or `SNAP_HOME`), never inside `node_modules`, so an update cannot erase them. A git checkout works exactly as before.
- `server.json` for the official MCP Registry (`io.github.Usame794/ads-mcp-for-snapchat`).
- The repository is now `Usame794/ads-mcp-for-snapchat`. Old links redirect.
- Verified live on a real account: a COLLECTION ad (paused).

## 0.3.2 (2026-11-14)

- Collection: product images are checked in the preview: they must be images, square (1:1) and at least 120x120 px. Snap refused 600x1000 images only at confirm time; now the preview says so before anything is sent. When Snap gives no size, the preview warns that the shape could not be checked.
- Collection: the preview lists the main Snap and every product image with its id and size, so what is approved is visible.
- Verified live on a real account: Collection creative (product tiles, product row, COLLECTION creative).

## 0.3.1 (2026-11-14)

- New read-only tool `snap_list_media`: the account's images and videos (READY by default), newest first, filtered by type and name, across every page. Finding a media id for a Story, Collection or Snap no longer needs the raw API tool.
- Verified live on a real account: Story creative and STORY ad (paused), and a SNAP_AD creative.

## 0.3.0 (2026-11-14)

Renamed to **Ads MCP for Snapchat** (package `ads-mcp-for-snapchat`), so the name does not read as Snap's own product. Tool names (`snap_*`) are unchanged.

### New ad formats
- `snap_create_story_creative`: Story Ads from 1-20 existing Snaps in a fixed order, with an optional tile for the Stories tab (PREVIEW + COMPOSITE creatives).
- `snap_create_collection_creative`: Collection Ads with 4-20 product tiles (creative elements, interaction zone, COLLECTION creative).
- `snap_create_creative` takes `creative_type: "SNAP_AD"` for a Snap with no link (image or video).
- `snap_create_ad` takes the ad type from the creative (REMOTE_WEBPAGE, SNAP_AD, STORY, COLLECTION) and refuses a mismatch.

### Fixes
- The call to action list now matches Snap's documented WEB_VIEW values; `BUY_NOW` and `VIEW_MORE`, which Snap does not accept for these creatives, were removed.

The new formats follow Snap's API reference and are covered by mocked tests; they have not yet been run against a live account.

## 0.2.1 (2026-11-14)

Fixes from a full code review, and a note on Snap's terms.

- `snap_undo` ignores list order and computed fields, so a targeting undo is no longer refused when Snap returns lists in another order.
- A damaged change log is reported instead of looking empty; `snap_undo` refuses rather than saying there is nothing to undo.
- The change log is parsed once per change of the file instead of once per item of a bulk edit; the in-memory copy keeps only the last 25 hours.
- Media uploads get a fresh token once on 401, like other requests.
- The weekly report names a missing `SNAP_AD_ACCOUNT_ID`.
- A confirm after the approval expired says "expired" instead of "unknown token".
- The async report download only follows a public https link.
- README: this is not Snap's official Ads MCP server; Snap's terms; which local files hold Snap data.

## 0.2.0 (2026-11-13)

First public release.

### Safety
- Every write is two steps: a preview returns a single-use approval token bound to the tool, ad account, arguments and target state. Stale, reused, expired or different requests are refused, and the refusal names the fields that changed. Fields Snap computes itself and list order are ignored.
- Absolute limits for daily budget, bid, lifetime budget, the budget one call may start, and everything added to an account in 24 hours. Budgets may rise at most 100% and bids 50% per step and per 24 hours. The limits apply to every path that can start or raise spending: set, bulk, create, copy, undo, enabling, and schedule changes that start delivery.
- Invalid safety settings stop the server at start-up instead of switching a limit off.
- Writes only touch the configured ad account. Ids are validated. Unknown arguments are refused.
- Every write records an intent before and a result after in the audit log; if the log cannot be written, the write does not run. Credentials are never logged; ad codes are masked.
- `SNAP_READ_ONLY=1` turns every write off. `SNAP_HUMAN_APPROVAL=elicit` asks the user directly through the MCP client.
- Deleting an audience that ACTIVE ad squads use is refused.

### Reliability and reports
- Deadline on every request; a write that fails in transit is never re-sent. A refused access token is replaced once.
- List tools read every page, take `name_contains`, and say when a list is cut.
- Reports compute totals from raw values, state their basis and attribution (optionally pinned), use the local day of the requested offset, and flag truncation. The health check reports unreadable stats as unknown.
- Changing countries keeps regional targeting of the countries that stay.

### Open source
- No hidden market defaults: `SNAP_DEFAULT_COUNTRY`, `SNAP_DEFAULT_PHONE_CODE`, `SNAP_REPORT_UTC_OFFSET`.
- Several ad accounts: one settings file per account (`SNAP_ENV_FILE`), each with its own credentials and change log.
- `save-secret.js` works on macOS, Windows and Linux, or with `--stdin`.
- Tool annotations (`readOnlyHint`, `destructiveHint`) for MCP clients.
- `zod` 4 and patched `hono` (npm audit clean). CI runs `npm audit` and the tests on Node 18, 20 and 22.

### Compatibility
- Writes need two calls (preview, then `confirm=true` with the `approval_token`).
- Default limits are conservative; set yours in `.env`. Limit changes apply after a restart.
- `countries` is required unless `SNAP_DEFAULT_COUNTRY` is set.

## 0.1.0
Initial version (private).
