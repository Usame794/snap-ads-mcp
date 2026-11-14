# Ads MCP for Snapchat

A local [MCP](https://modelcontextprotocol.io) server that lets an AI assistant (Claude Code, Claude Desktop and other MCP clients) work with **your own** Snapchat ad account: read performance, audit campaigns, and make careful, reviewable changes. It also turns creators' **ad codes** into paused ads.

> **Unofficial.** Not affiliated with or endorsed by Snap Inc. This tool can change real ad campaigns that spend real money. You use it at your own risk (see LICENSE). Check Snap's developer terms for your own use. Review every preview before approving.

## What it is, and what it is not
- **It runs on your machine, with your own Snapchat OAuth app and your own ad account.** Nothing is hosted or shared, and no credentials leave your computer except to Snap's API.
- **It is a safety-first tool, not an autopilot.** Writes are previewed first, created things start paused, and there are hard limits on money. See "Safety rules" below, and read "What the approval token is not".
- **It is not a hosted service.** Services that only accept remote MCP servers (for example ChatGPT connectors) cannot use it as it is. Do not expose it on the internet.
- **Money limits are in your account's currency.** Defaults (`SNAP_MAX_DAILY_BUDGET=1000`, `SNAP_MAX_BID=50`) are deliberately conservative; set your own in `.env`.

## Snap's terms and data
- This project is **not** Snap's official Ads MCP server and is not endorsed by Snap Inc. "Snapchat" is a trademark of Snap Inc.; it is used here only to say which API this tool works with.
- Using the Snapchat Marketing API means accepting Snap's Developer Terms and [Business Tools Terms](https://snap.com/terms/snap-business-tools). Read them yourself; they include duties on how long Snap data may be kept and how it must be protected.
- This server keeps data only on your machine: the change log (`changes.log.jsonl` or `<settings file>.log.jsonl`) and anything you export to `exports/`. You are responsible for keeping and deleting those files in line with Snap's terms.
- Data that comes back from the API (names, review reasons) is shown to your AI assistant. Treat it as untrusted input, and keep your client's approval prompt on for write tools.

## Ad formats
- **Single Snap with a link** (WEB_VIEW): `snap_create_creative`, then `snap_create_ad`.
- **Single Snap, no link** (image or video): `snap_create_creative` with `creative_type: "SNAP_AD"`.
- **Story Ad**: create the Snaps first (any of the two above), then `snap_create_story_creative` with their ids in order. Add `preview` (a 3:5 PNG tile, at least 360x600 px, and a headline of up to 55 characters) to also show it in the Stories tab.
- **Collection Ad**: upload a main image or video and one image per product (at least 120x120 px), then `snap_create_collection_creative` with 4-20 products, each with its own https page.

In every case `snap_create_ad` picks the matching ad type (REMOTE_WEBPAGE, SNAP_AD, STORY or COLLECTION) and the ad starts PAUSED. Creatives never deliver on their own. Upload images and videos with `snap_upload_media` and wait until `snap_get_media` says READY.

## Quick start
1. `git clone` this repository, then `npm ci`, then `npm test` (all tests are mocked and need no account).
2. Create a Snapchat OAuth app and connect it to your account: follow **Setup (one time)** below (about 10 minutes).
3. Copy the safety and market settings from `.env.example` into `.env` and set **your** limits, `SNAP_DEFAULT_COUNTRY`, `SNAP_ACCOUNT_CURRENCY` and `SNAP_REPORT_UTC_OFFSET`.
4. Start with `SNAP_READ_ONLY=1`: connect your MCP client, try `snap_ping`, a report, and a few previews, and compare the numbers with Ads Manager. Remove the setting when you are comfortable.
5. Keep your client's permission prompt **on** for write tools.

## Safety rules (built in)
- Every write tool works in **two steps**. `confirm=false` (the default) returns a preview and a single-use `approval_token`. To apply, the same arguments are sent again with `confirm=true` and that token. The token is bound to the tool, the ad account, the arguments and the state of the items at preview time: if anything changed, or the token is reused, expired or from another request, nothing is sent.
- Everything that creates something (copies, clones, new ads, new creatives) is created **PAUSED**. Enabling is a separate step, and its preview shows the daily budget that would really start delivering (for a campaign: the budgets of its ACTIVE ad squads).
- **Absolute limits**, in account currency, apply to every path that can raise money (set, bulk, create, copy, undo, enable): see the table below. On top of them, a budget may rise at most +100% and a bid +50% per step **and per 24 hours** (counted from this server's change log), so repeating a step does not compound.
- Writes only touch items of the configured `SNAP_AD_ACCOUNT_ID`. Ids are validated before they are used.
- The only delete tool is `snap_delete`, behind many guards. Status can only be `ACTIVE` or `PAUSED`.
- Every write is recorded in `changes.log.jsonl`: an intent record before anything is sent (if it cannot be written, the operation does not run) and a result record after, with tool, account, target ids, redacted arguments, and before/after values for edits. Credentials are never logged; ad codes are masked.
- Multi-step creates (copy, influencer flow) stop at the first failure and report exactly what was already created. A write that fails in transit is never re-sent; it is reported as "outcome unknown".
- Safety settings are validated when the server starts. An invalid value (for example `100%`) **stops the server** instead of switching the limit off. Limits and the target account are fixed until restart; only the OAuth credentials are re-read from `.env`.

### What the approval token is not
The token proves that this exact change was previewed and that nothing moved since. It does **not** prove that a person looked at it: the AI client receives the token and can send it back by itself. Human authorization is the permission prompt of your MCP client, so **do not auto-approve the write tools**. Tools are annotated (`readOnlyHint`, `destructiveHint`) so a client can auto-allow reads only. `SNAP_READ_ONLY=1` turns every write off.

### Asking you directly (`SNAP_HUMAN_APPROVAL=elicit`)
With this setting the server asks **you**, through the MCP client's own dialog (MCP elicitation), before every write, and refuses when it cannot ask. The question and your answer do not pass through the model. For anything that adds spend, for deletes and for undo, you must also type a 4-digit code that only the dialog shows. Limits you should know:
- It needs a client that shows elicitation dialogs. Claude Code documents this for interactive terminal sessions; in non-interactive sessions the request is cancelled, so writes are refused. This server's tests use the SDK's client, not Claude Code itself: try one harmless write (a rename) before relying on it.
- A client can be configured to answer elicitations automatically (in Claude Code, an `Elicitation` hook). Such a hook removes the human from the loop. Do not install one for this server, and keep your client's settings files out of reach of the AI's file tools.

### Safety settings (`.env`, all optional, restart to apply)
| Setting | Default | Meaning |
|---|---|---|
| `SNAP_MAX_DAILY_BUDGET` | 1000 | Highest daily budget any single campaign or ad squad may be given or enabled with |
| `SNAP_MIN_DAILY_BUDGET` | 5 | Lowest daily budget |
| `SNAP_MAX_BID` | 50 | Highest max bid |
| `SNAP_MAX_BUDGET_INCREASE_PCT` | 100 | Largest budget increase per step and per 24 hours |
| `SNAP_MAX_BID_INCREASE_PCT` | 50 | Largest bid increase per step and per 24 hours |
| `SNAP_MAX_LIFETIME_BUDGET` | 30 x max daily | Highest lifetime budget a copy may carry or an enable may start |
| `SNAP_MAX_ACTIVATION_DAILY_BUDGET` | 5 x max daily | Most daily budget one call may start (enable, undo of a pause, or a schedule change that starts delivery) |
| `SNAP_MAX_ADDED_DAILY_BUDGET_24H` | 2 x the line above | Most daily budget this server may add to the account in any 24 hours, all tools together: budgets it starts plus budget increases |
| `SNAP_ACCOUNT_CURRENCY` | not set | If set (e.g. `USD`), writes are refused unless the ad account uses that currency |
| `SNAP_READ_ONLY` | 0 | `1` = previews and reads only |
| `SNAP_HUMAN_APPROVAL` | off | `elicit` = ask the user through the MCP client before every write |
| `SNAP_APPROVAL_TTL_SECONDS` | 600 | Lifetime of an approval token |
| `SNAP_REPEAT_WINDOW_SECONDS` | 600 | An identical create, copy, claim or upload is refused within this time |
| `SNAP_HTTP_TIMEOUT_MS` | 60000 | Deadline for each API request |
| `SNAP_DEFAULT_COUNTRY` | not set | 2-letter country used when a tool is called without countries (new ad squads, lookalikes, targeting lookups). **Not set = countries must always be given**; there is no hidden default market |
| `SNAP_DEFAULT_PHONE_CODE` | not set | Country code (digits, no `+`) for local phone numbers in customer lists. Not set = local numbers are counted as invalid instead of being guessed |
| `SNAP_REPORT_UTC_OFFSET` | `+00:00` | Offset for `scripts/weekly-report.js` and `scripts/smoke.js` day boundaries, e.g. `+03:00` |

Reports state what their numbers mean (`basis`): amounts are Snap micro-currency divided by 1,000,000 in the account currency, purchases are Snap-attributed, and attribution uses the account's default windows unless you pin them with `swipe_up_attribution_window` / `view_attribution_window` on `snap_report` and `snap_report_daily`. Totals are computed from raw values (account ROAS = purchase value / spend). A report that was cut off says `incomplete` or `truncated`.

Existing items above a limit can still be read, lowered and paused, but not raised or enabled until the owner raises the limit. The 24-hour rules and the audit trail rely on `changes.log.jsonl` (plus an in-memory copy while the server runs, so deleting the file does not reset them until a restart); changes made in Ads Manager are not counted, and the file is not tamper-proof against someone with access to your disk. Keep `.env` and the log out of reach of the AI client's file tools (for Claude Code: a `Read`/`Edit` deny rule for the project folder).

## Tools
| Tool | Type |
|---|---|
| `snap_ping` | check credentials |
| `snap_list_campaigns`, `snap_list_adsquads`, `snap_list_ads`, `snap_list_creatives`, `snap_get_entity`, `snap_get_media`, `snap_get_stats` | read |
| `snap_report` | read: ROAS, CPA, swipe rate, frequency by ad squad or ad |
| `snap_report_daily` | read: day-by-day performance (up to 31 days) |
| `snap_report_audience` | read: performance by country, gender, age, region, dma or make |
| `snap_health_check` | read: audits every active squad for missing buyer exclusion, high frequency, low swipe rate, low ROAS, spend with no purchases, paused parents |
| `snap_review_issues` | read: rejected / pending ads with Snap's reasons |
| `snap_pixel_health` | read: pixel signal readiness and event-quality issues, top priority first |
| `snap_creative_fatigue` | read: which ads are tired (ROAS down 30%+ with higher frequency or lower swipe rate), which to replace first |
| `snap_report_compare` | read: two time windows side by side with the changes |
| `snap_report_async_start`, `snap_report_async_status`, `snap_report_async_download` | read: very large CSV reports saved to `exports/` |
| `snap_api_get` | read-only GET for anything else (allow-listed paths, never writes) |
| `snap_list_segments`, `snap_list_pixels`, `snap_list_catalogs`, `snap_list_product_sets`, `snap_targeting_options` | read: audiences, pixels, catalogs, product sets, interest/region/language ids |
| `snap_change_log` | read the local log |
| `snap_set_status`, `snap_set_status_bulk` | pause / enable (bulk up to 20, warns when a parent is paused) |
| `snap_set_daily_budget`, `snap_set_bid`, `snap_rename` | edit |
| `snap_set_targeting` | change countries, age, gender, interests, device OS, include segments, stop excluding segments; everything else is kept |
| `snap_set_schedule` | set start/end time on a campaign or ad squad |
| `snap_exclude_segments` | add buyer-exclusion audiences to an ad squad |
| `snap_copy_campaign` | copy a campaign (all or selected ad squads, with or without ads), paused |
| `snap_create_campaign` | create a new empty campaign, paused |
| `snap_create_adsquad` | create a new purchase-optimized web ad squad (max bid or auto-bid, interests, device OS, buyer exclusions), paused |
| `snap_create_lookalike` | create a lookalike audience from a customer-list seed |
| `snap_copy_adsquad` | copy one ad squad into a campaign, paused |
| `snap_clone_ad` | clone an ad into other ad squads, paused (skips duplicates and different product sets) |
| `snap_bulk_exclude_segments`, `snap_bulk_set_budget`, `snap_bulk_set_schedule`, `snap_bulk_rename` | edit up to 20 items at once with a per-item preview; stop at the first failure |
| `snap_undo` | revert a change from the log (refuses if the field changed again since) |
| `snap_clone_creative` | duplicate a creative with a new name/headline/link |
| `snap_create_pixel_audience` | audience of people who fired pixel events (e.g. ADD_CART) |
| `snap_upload_customer_list` | customer-list audience from a local CSV; hashed locally, only hashes uploaded |
| `snap_influencer_batch` | influencer flow for up to 10 ad codes into one squad; expired codes are skipped |
| `snap_delete` | guarded delete: paused, no spend in 30 days, no active children, exact name typed |
| `snap_claim_ad_code` | claim a creator ad code (one-way, single-use) |
| `snap_upload_media` | upload a local video/image (up to 1 GB, chunked above 32 MB) to the ad account, not attached to any ad |
| `snap_create_creative`, `snap_create_ad` | creative from an image or video: WEB_VIEW (swipe-up link) or SNAP_AD (the Snap only); ad from a creative, its type taken from the creative (paused) |
| `snap_create_story_creative` | Story Ad: 1-20 existing Snaps in a fixed order, with an optional tile for the Stories tab |
| `snap_create_collection_creative` | Collection Ad: a main image or video with 4-20 product tiles, each opening its own page |
| `snap_influencer_ad` | the whole influencer flow in one step: claim, wait for media, creative, paused ad |

## Influencer ad-code flow
Creators share a code like `adcode_<uuid>`. `snap_influencer_ad` claims it into the ad account (`POST /adaccounts/{id}/claim_media_by_ad_code?ad_code=&profile_id=`, parameters go in the query string), waits for the media to be READY, creates a WEB_VIEW creative on the brand profile (`SNAP_BRAND_PROFILE_ID`) and creates a **paused** ad in the ad squad you choose.
Notes from live use:
- Claiming is one-way and codes are single-use. Expired codes return "Ad code has expired" and are not consumed.
- Codes beyond their lifetime cannot be refreshed; ask the creator for a new one.
- Codes starting with `#` are for other platforms and are rejected.

## Scripts
- `npm run smoke`: live read-only check of credentials, token refresh and the main read paths (exit code 1 on any failure). Run it after changing a secret or updating the server.
- `npm run weekly-report`: read-only weekly report saved to `exports/weekly-<date>.md` (spend and ROAS vs last week, top campaigns, account health, tired ads, review problems, pixel issues). Optional argument: end date, e.g. `npm run weekly-report -- 2026-10-27`.
- Reliability: reads retry automatically on rate limits (429), server errors and network errors; writes retry only on 429, so a create or claim is never repeated by accident.

## Requirements
Node 18+ and a Snapchat Ads account with permission to create an OAuth app. Install dependencies with `npm install`. Run the tests with `npm test` (all mocked, no credentials needed).

Each user runs this server locally with their own OAuth app and their own ad account. Nothing is shared or hosted.

## Setup (one time)
1. In Snap Ads Manager open **Business Details > OAuth Apps** and create an app. Redirect URL must be https and not `localhost`, for example `https://127.0.0.1/callback`. **The client secret is shown once**: select it and copy it before leaving the page.
2. Copy `.env.example` to `.env`, fill in `SNAP_CLIENT_ID` and `SNAP_REDIRECT_URI`.
3. Save the secret from your clipboard: `node scripts/save-secret.js` (reads the clipboard on macOS, Windows, and Linux with `wl-paste`, `xclip` or `xsel`; it refuses text that does not look like a secret and clears the clipboard). Without a clipboard tool use `node scripts/save-secret.js --stdin`, or add `SNAP_CLIENT_SECRET=...` to `.env` yourself and make the file private (`chmod 600 .env`).
4. Open this URL in a browser signed in to Snapchat and approve (replace the two values):
   `https://accounts.snapchat.com/login/oauth2/authorize?response_type=code&client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&scope=snapchat-marketing-api&state=ads-mcp-for-snapchat`
5. The browser redirects to `...?code=...`. Within a minute or two run: `CODE=THE_CODE node scripts/get-refresh-token.js`. It saves `SNAP_REFRESH_TOKEN` into `.env` and prints nothing secret.
6. `node scripts/check.js` refreshes the token and tests `/me` and the ad account (read-only).
7. Register: `claude mcp add --scope user snapchat-ads -- node "/ABSOLUTE/PATH/TO/ads-mcp-for-snapchat/src/index.js"`, then restart Claude Code.

## Use it from Claude or ChatGPT
This is a local MCP server (stdio). Credentials stay in your `.env`; the AI app only starts the process.

**Claude Code** (step 7 above): `claude mcp add --scope user snapchat-ads -- node "/ABSOLUTE/PATH/TO/ads-mcp-for-snapchat/src/index.js"`, then restart. Check with `claude mcp list`.

**Claude Desktop**: open Settings > Developer > Edit Config and add this to `claude_desktop_config.json`, then fully quit and reopen the app:
```json
{
  "mcpServers": {
    "snapchat-ads": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/ads-mcp-for-snapchat/src/index.js"]
    }
  }
}
```
Use the absolute path to `node` as `command` if the app cannot find it. The server reads `.env` from its own folder, so no secrets go in this file.

**ChatGPT**: ChatGPT connects to *remote* MCP servers (an https URL) through its connectors / developer mode, not to local stdio programs. This server is local only, so it cannot be added to ChatGPT as it is. Doing that would need a hosted version with per-user OAuth and encrypted token storage (see "Not built"). Do not expose this server publicly as it is: it can change real ad campaigns. Other desktop MCP clients that launch local stdio servers (Cursor, VS Code, Cline) work with the same `command` and `args` as above.

## Several ad accounts
Run one server per ad account, each with its own settings file. Each server only touches its own account, and keeps its own change log (`<settings file>.log.jsonl`), so limits, undo and the audit trail never mix.

1. Copy your settings: `cp .env .env.account2`. In `.env.account2`, set that account's `SNAP_AD_ACCOUNT_ID`, `SNAP_PIXEL_ID`, `SNAP_BRAND_PROFILE_ID` and its own limits. Every `.env*` file except `.env.example` is git-ignored.
2. If that account belongs to another Snapchat login, authorize it into its own file (same steps as "Setup", with the variable in front): `SNAP_ENV_FILE=.env.account2 node scripts/get-refresh-token.js`, then `SNAP_ENV_FILE=.env.account2 node scripts/check.js`. If the same login can see both accounts, the copied credentials already work.
3. Register a second server with an absolute path to the file:
   `claude mcp add --scope user -e SNAP_ENV_FILE="/ABSOLUTE/PATH/TO/ads-mcp-for-snapchat/.env.account2" snapchat-ads-2 -- node "/ABSOLUTE/PATH/TO/ads-mcp-for-snapchat/src/index.js"`
4. Start with `SNAP_READ_ONLY=1` in the new file and check `snap_ping` shows the right account.

Scripts work the same way: put `SNAP_ENV_FILE=.env.account2` in front of any `node scripts/...` command.

## Weekly report on a schedule
`npm run weekly-report` writes `exports/weekly-<account>-<date>.md` (read-only; nothing is changed in the account). To run it every Sunday at 09:30 on macOS or Linux, add a line with `crontab -e`, using the full path of `node` (`which node`):

```
30 9 * * 0 cd "/ABSOLUTE/PATH/TO/ads-mcp-for-snapchat" && /full/path/to/node scripts/weekly-report.js >> "$HOME/snap-weekly.log" 2>&1
```

The computer must be awake at that time. Set `SNAP_REPORT_UTC_OFFSET` so the week starts at your local midnight. For a second account add `SNAP_ENV_FILE=.env.account2` before `/full/path/to/node`.

## Verified live (against the real Snapchat API)
Verified on the maintainer's own ad account. Anything not listed here is covered by mocked tests only: try it with `SNAP_READ_ONLY=1` on your account first.

**After the safety layer (November 2026):**
- Connection and settings: token refresh, `snap_ping` (shows the limits in force), start-up validation of `.env`.
- Reads: campaign and ad squad lists across more than one page, finding one campaign among about 2,000 with `name_contains`, ad squad details.
- Reports: the weekly report's account spend for a full week matched the figure in Ads Manager for the same dates and time zone. Purchases and ROAS use Snap's attribution and can differ from other tools.
- Previews: enabling a campaign and an ad squad shows what would really start delivering, including an ad squad under a paused campaign, and its daily budget matched Ads Manager.
- One real write on a throwaway campaign: preview, approval token, rename, read-back verification, audit entries (intent and result), `snap_undo` preview and undo.
- Story Ads (0.3.0): a Story creative from two existing creatives (account and type checks, fixed order), then `snap_create_ad` choosing ad type STORY, created PAUSED in a paused test ad squad.

**Before the safety layer (earlier tests, on throwaway paused objects):** pause/enable (single and bulk), budget, bid, targeting, schedule, bulk edits, campaign / ad squad copy, ad and creative clone, create campaign and ad squad, lookalike and pixel audiences, customer-list audience (with fake data), influencer flow and batch, media upload (simple and chunked), async reports, health check, review issues, pixel health, and the guarded delete (on a throwaway campaign).

**Not verified live:** Collection creatives and SNAP_AD creatives (built from Snap's API reference, mocked tests only), the 24-hour spend limit and absolute limits on real writes (mocked tests only), `SNAP_HUMAN_APPROVAL=elicit` in Claude Code, `snap_create_creative` and `snap_create_ad` on their own, a campaign-level `snap_set_daily_budget`, a successful `snap_delete` of an ad squad, ad or audience, a customer-list upload of real data, and Node 18 / 20 outside CI.

## Not built
- A hosted multi-user version (this server runs on your own machine with your own credentials).
- Lens, App Install, Deep Link, lead-form and dynamic product creatives, product set creation, ad squad types other than purchase-optimized web squads, custom location/radius targeting, lifetime or reach-and-frequency budgets, and position-level reports.
- Anything that spends money without a separate, explicit enable step.

## Development
`npm ci`, then `npm test` (all tests use a mocked API; none touch your account). See `ARCHITECTURE.md` for the design and `CONTRIBUTING.md` before sending changes.
