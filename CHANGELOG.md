# Changelog

## Unreleased

- `snap_check_landing_pages`: a website that answers 401, 403 or 429 to the check (bot protection; found on a live shop) is listed apart as "could not check" and never counted as a broken link.
- `snap_audience_health`: audiences with nobody in them are flagged EMPTY (not TINY), counted by flag, and problems on audiences that an ACTIVE ad squad uses right now (for example a stale buyer list used for exclusion) are listed first.
- `verify`: a rate-limited public Ads Gallery is a skip, long upper-case error codes stay readable, percent-encoded link paths are decoded for display.
- `verify --details` lists the specifics behind each problem (broken links without their query strings, pixel issues, feed errors, audience problems, rejected ads' reasons, ad squad issue counts).

## 0.9.1 (2026-11-15)

Fixes from the first run of `verify` on a real ad account (19 of 24 checks passed; these are the other five and some rough edges). Mocked tests could not have found them.

- **Account-level numbers** (`snap_anomaly_check`, `snap_funnel`, `snap_report_hourly`, `snap_blended_roas`, `snap_portfolio_summary`): Snap's account-level stats only accept the `spend` field ("Only field 'spend' should be used when querying AdAccount stats"). Totals are now built from the per-campaign breakdown, the query the weekly report already used. Time series are merged from the same breakdown, then checked against Snap's own spend total; if the answer is not the whole account they are rebuilt from the active campaigns, and the answer states its coverage instead of showing silent zeros.
- **`snap_check_landing_pages`** timed out on a big account because it read every ad. It now reads only ACTIVE campaigns, their ACTIVE ad squads and those squads' ACTIVE ads, fetches only the creatives those ads use, and stops after about 40 seconds with a clear "partial" note rather than claiming everything is fine.
- `verify` reports the Conversions API test tools as skipped (needs `SNAP_CAPI_TOKEN`) when Snap does not accept the normal login there, instead of as a failure.
- **Conversions API test tools** (`snap_capi_*`): the token is now sent as Snap documents it (an `access_token` parameter). New optional setting `SNAP_CAPI_TOKEN` for a Conversions API token made in Ads Manager, used only for `tr.snapchat.com`. A refusal now says exactly what to do.
- `snap_audience_insights` explains an empty answer (targeting equal to the comparison). `snap_budget_advice` says how many ad squads were compared and why nothing is suggested. `snap_catalog_feed_status` judges staleness against each feed's own schedule and counts only real upload errors, not warnings. `verify` shows more detail, no longer times out on slow tools, and uses a narrowed targeting for the insights check.
- The GitHub repository is now `Usame794/snapchat-ads-mcp`; links in the package, the registry entry, the README and the login service pages use the new name.
- `verify` command: runs every read-only tool on your real account and prints what worked, what failed (with a short, tidy reason) and what was skipped. It only calls tools that declare themselves read-only and forces read-only mode; a test checks it sends nothing but GETs and the two read-only POSTs (audience size and insights).
- `broker/ASK-SNAP.md`: the message to send to Snap before announcing the shared login.

## 0.9.0 (2026-11-15)

- **Shared login (log in with Snapchat, no OAuth app).** `setup` offers it first; in Claude Desktop leave the Client ID and secret empty and ask Claude to connect: the browser finishes the login by itself, nothing is pasted. A small stateless login service (`broker/`, a Cloudflare Worker) holds one shared app's secret and nothing else. It stores no tokens, accounts or logs: at login it seals the refresh token to a key made on the person's own computer and redirects only to `http://127.0.0.1:<port>` (checked), and later it only swaps a refresh token for a 30-minute access token. Using your own Snapchat app still works exactly as before and always wins when its secret is present.
- The login is protected by a signed state (no storage), a cookie that ties it to the browser that started it, an expiry, a loopback-only redirect, a nonce-bound sealed token, and a listener on the computer that checks the Host header and accepts one callback only.
- New: `PRIVACY.md`, `broker/README.md` (how to deploy and what to check before announcing it), `SNAP_BROKER_URL`, `adsMcpBroker` in `package.json` (the default service address, empty until one is deployed).
- Not yet run against the real Snapchat login: the service is tested against a fake one. Follow `broker/README.md` step 5 before announcing it. ChatGPT support is not part of this: ChatGPT needs a hosted MCP server.

## Unreleased

- Docs: `SECURITY.md` now lists every outside address the server contacts and what is sent. New tests fail when a tool or a `SNAP_` setting is missing from the README, or when the code starts contacting an address that `SECURITY.md` does not list. `SNAP_HOME` was missing from the README and is now documented.

## 0.8.0 (2026-11-15)

Not yet verified on a live account (built from Snap's documentation and mocked tests).

- `snap_set_bid_strategy`: switch an ad squad between max bid and target cost with the bid for the new strategy, under the same bid limits as `snap_set_bid`. An ad squad on auto-bid can be given a cap this way. Switching TO auto-bid is deliberately not offered, and an undo can never restore auto-bid, because that would remove the bid cap.
- `snap_set_placement`: automatic, or custom positions (PUBLIC_STORIES_INSTREAM, INTERSTITIAL_CONTENT, INTERSTITIAL_SPOTLIGHT, INTERSTITIAL_USER, FEED, CAMERA, CHAT_FEED with Snap's CHAT_FEED rule). Refused on ad squads that use content inclusion or exclusion lists. Undo works when a placement was set before.
- `snap_portfolio_summary`: all your ad accounts side by side. The accounts are the settings files you list in `SNAP_PORTFOLIO_FILES`; the tool takes no arguments, so the AI app cannot choose files. Each account is read with its own credentials, only account-level numbers are returned, and currencies are never added together.
- Undo now validates the new editable fields (placement, caps, schedules, bid strategy) the same way it validates the old ones.
- This release also contains everything in 0.7.0, which is already on npm.

## 0.7.0 (2026-11-15)

Everything below is built from Snap's documentation and mocked tests and is not yet verified on a live account. New write tools are previewed, need approval, are audited and create things PAUSED; all other new tools only read.

**Catalog ads (Dynamic Product Ads)**
- `snap_create_product_set` (Snap's filter rules are checked before anything is sent), `snap_create_dynamic_template`, `snap_list_dynamic_templates`.
- `snap_create_campaign` takes `catalog_id`; `snap_create_adsquad` takes `product_set_id`, `dpa_mode` (retargeting / prospecting) and `audience_days`; `snap_create_creative` takes `creative_type: DYNAMIC_PRODUCT`; `snap_create_ad` creates the DYNAMIC ad and refuses a creative whose product set differs from the ad squad's. Catalogs and templates must belong to the ad account's organization / account.

**Checks**
- `snap_check_landing_pages`: opens each active ad's link once (https only, never private or link-local addresses, every redirect checked) and reports broken, slow, server-error, unreachable and non-https links, links that end on another site, and links missing parameters you name. It cannot see "out of stock" text inside a page that opens.
- `snap_anomaly_check`: the last full local day against the usual day: spend spike or drop, zero or falling purchases (possible broken pixel), ROAS drop, cost-per-purchase spike.
- `snap_blended_roas`: Snap's reported revenue against the revenue your store confirms.
- `snap_billing_check` (card expiry, daily limit vs budgets, credit left), `snap_unused_media`, `snap_audience_health`, `snap_funnel`, `snap_catalog_feed_status`.

**Intelligence**
- `snap_audience_insights`: who is in an audience compared with everyone in the same countries.
- `snap_competitor_ads`: a company's ads from Snap's public Ads Gallery (no login; nothing about your account is sent; ad text is cut and marked as untrusted).
- `snap_capi_status` and `snap_capi_test_event`: Conversions API TEST events only (email hashed locally, validate endpoint only). There is deliberately no tool that sends real conversion events.

**Controls and advice**
- `snap_set_frequency_cap` and `snap_set_ad_schedule` (undoable when a value existed before). Snap allows an ad schedule only on lifetime-budget ad squads, so it is refused on daily-budget ones with the reason.
- `snap_create_adsquad` takes `goal`: pixel goals (purchase, add to cart, page view, sign-up), traffic (SWIPES), awareness (IMPRESSIONS), video views. The default is unchanged.
- `snap_report_hourly`, `snap_creative_compare`, `snap_budget_advice` (suggested moves that net to zero and stay inside your limits, each naming the tool that applies it).
- Playbooks: Budget review, Tracking check, Competitor scan, Fix rejected ads; Weekly review and Launch checklist use the new checks.

**Other**
- `SNAP_TOOLSETS`: offer only some tool groups (setup, read, reports, checks, changes, create) to the AI app. A typo stops the server; a test fails when a new tool is missing from a group.
- Privacy fix: the audit log now removes emails and phone numbers from logged tool arguments (by key and inside text), as it already did for credentials.
- Not built, because Snap's documentation does not show a safe form: custom placement control, bid-strategy switching.

## 0.6.0 (2026-11-14)

- `snap_audience_size`: Snap's reach estimate before spending, for an existing ad squad or for targeting you are planning (same targeting rules as creating an ad squad), with a verdict: very small, small, OK or very broad. Nothing is created.
- `snap_spend_pacing`: each active ad squad's spend today vs its daily budget for the time of day (ahead, behind, not spending, budget nearly used, on track), month-to-date spend, the projected month and the most it could spend; with `monthly_budget`, over / under and the daily spend needed to land on it. Local days follow `SNAP_REPORT_UTC_OFFSET`.
- `snap_ad_preview`: a no-login preview link (90 days) and a Snapcode (7 days) for an ad or creative.
- Playbooks (MCP prompts): Weekly review, Launch checklist, Replace tired ads. They read and preview only.
- The three new tools are built from Snap's documentation and mocked tests; not yet verified on a live account.

## 0.5.0 (2026-11-14)

- Easy setup: `npx -y ads-mcp-for-snapchat setup` goes from nothing to a working server in one command. It asks for the Client ID and secret (the secret is hidden), opens the approval page, reads the code from the pasted address (checking it belongs to this attempt), lists the login's ad accounts to choose from, asks for the highest daily budget, main country and read-only mode, and adds the server to Claude Code (or prints the exact settings for other apps). Switching a file to another account clears the old account's pixel and brand profile.
- Claude Desktop extension (`.mcpb`, attached to each GitHub release): install with a double-click, enter the Client ID and secret in Claude Desktop's own settings screen, then connect from the chat.
- New tool `snap_connect`: connect an ad account from inside the chat (link, pasted address, account choice). The Client ID and secret come from the app's settings, never from the chat; the refresh token is saved to the settings file and never returned. It changes no ads, so it also works in read-only mode. A new account takes effect after restarting the app, as before.
- An optional Claude Desktop setting left empty is ignored instead of stopping the server.

## 0.4.1 (2026-11-14)

- Settings files: when a key appears twice, the last line now wins (as in dotenv), so a line added at the end, such as `SNAP_READ_ONLY=1`, takes effect. Saving a secret or token replaces every copy of that key, so an older duplicate can never win.
- Package and registry links point to the repository's real name, `Usame794/snapchat-ads-mcp` (0.4.0 linked to a name that does not exist).
- README: the second-account `claude mcp add` command had the server name after `-e`, which Claude Code rejects. Fixed, and it now starts the second account read-only with `-e SNAP_READ_ONLY=1`.

## 0.4.0 (2026-11-14)

- Install from npm: `npx -y ads-mcp-for-snapchat` starts the server. `init`, `where`, `save-secret`, `auth`, `check` and `weekly-report` replace `node scripts/...` for installed copies; `help` lists them.
- An installed copy keeps its settings, change log and exports in `~/.ads-mcp-for-snapchat` (or `SNAP_HOME`), never inside `node_modules`, so an update cannot erase them. A git checkout works exactly as before.
- `server.json` for the official MCP Registry (`io.github.Usame794/ads-mcp-for-snapchat`).
- Repository links point to `Usame794/snapchat-ads-mcp`.
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
