# snap-ads-mcp

Local MCP server for the Snapchat Marketing API. It reads, edits and creates campaigns, ad squads and ads, and turns influencer **ad codes** into paused ads.

> **Unofficial.** Not affiliated with or endorsed by Snap Inc. This tool changes real ad campaigns that spend real money. You use it at your own risk (see LICENSE). Review every preview before confirming.

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
The token proves that this exact change was previewed and that nothing moved since. It does **not** prove that a person looked at it: the AI client receives the token and can send it back by itself. Human authorization is the permission prompt of your MCP client, so **do not auto-approve the write tools**. Tools are annotated (`readOnlyHint`, `destructiveHint`) so a client can auto-allow reads only. If your client supports MCP elicitation, `SNAP_HUMAN_APPROVAL=elicit` makes the server ask you directly before every write and refuse when it cannot ask. `SNAP_READ_ONLY=1` turns every write off.

### Safety settings (`.env`, all optional, restart to apply)
| Setting | Default | Meaning |
|---|---|---|
| `SNAP_MAX_DAILY_BUDGET` | 1000 | Highest daily budget any single campaign or ad squad may be given or enabled with |
| `SNAP_MIN_DAILY_BUDGET` | 5 | Lowest daily budget |
| `SNAP_MAX_BID` | 50 | Highest max bid |
| `SNAP_MAX_BUDGET_INCREASE_PCT` | 100 | Largest budget increase per step and per 24 hours |
| `SNAP_MAX_BID_INCREASE_PCT` | 50 | Largest bid increase per step and per 24 hours |
| `SNAP_MAX_LIFETIME_BUDGET` | 30 x max daily | Highest lifetime budget a copy may carry or an enable may start |
| `SNAP_MAX_ACTIVATION_DAILY_BUDGET` | 5 x max daily | Most daily budget one enable call (or undo of a pause) may start |
| `SNAP_ACCOUNT_CURRENCY` | not set | If set (e.g. `USD`), writes are refused unless the ad account uses that currency |
| `SNAP_READ_ONLY` | 0 | `1` = previews and reads only |
| `SNAP_HUMAN_APPROVAL` | off | `elicit` = ask the user through the MCP client before every write |
| `SNAP_APPROVAL_TTL_SECONDS` | 600 | Lifetime of an approval token |
| `SNAP_REPEAT_WINDOW_SECONDS` | 600 | An identical create, copy, claim or upload is refused within this time |
| `SNAP_HTTP_TIMEOUT_MS` | 60000 | Deadline for each API request |

Existing items above a limit can still be read, lowered and paused, but not raised or enabled until the owner raises the limit. The 24-hour rule and the audit trail rely on `changes.log.jsonl`; changes made in Ads Manager are not counted. Keep `.env` and the log out of reach of the AI client's file tools (for Claude Code: a `Read`/`Edit` deny rule for the project folder).

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
| `snap_create_creative`, `snap_create_ad` | creative from media; ad from creative (paused) |
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
3. Save the secret from your clipboard: `node scripts/save-secret.js` (it refuses text that does not look like a secret and clears the clipboard).
4. Open this URL in a browser signed in to Snapchat and approve (replace the two values):
   `https://accounts.snapchat.com/login/oauth2/authorize?response_type=code&client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&scope=snapchat-marketing-api&state=snap-ads-mcp`
5. The browser redirects to `...?code=...`. Within a minute or two run: `CODE=THE_CODE node scripts/get-refresh-token.js`. It saves `SNAP_REFRESH_TOKEN` into `.env` and prints nothing secret.
6. `node scripts/check.js` refreshes the token and tests `/me` and the ad account (read-only).
7. Register: `claude mcp add --scope user snap-ads -- node "/ABSOLUTE/PATH/TO/snap-ads-mcp/src/index.js"`, then restart Claude Code.

## Use it from Claude or ChatGPT
This is a local MCP server (stdio). Credentials stay in your `.env`; the AI app only starts the process.

**Claude Code** (step 7 above): `claude mcp add --scope user snap-ads -- node "/ABSOLUTE/PATH/TO/snap-ads-mcp/src/index.js"`, then restart. Check with `claude mcp list`.

**Claude Desktop**: open Settings > Developer > Edit Config and add this to `claude_desktop_config.json`, then fully quit and reopen the app:
```json
{
  "mcpServers": {
    "snap-ads": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/snap-ads-mcp/src/index.js"]
    }
  }
}
```
Use the absolute path to `node` as `command` if the app cannot find it. The server reads `.env` from its own folder, so no secrets go in this file.

**ChatGPT**: ChatGPT connects to *remote* MCP servers (an https URL) through its connectors / developer mode, not to local stdio programs. This server is local only, so it cannot be added to ChatGPT as it is. Doing that would need a hosted version with per-user OAuth and encrypted token storage (see "Not built"). Do not expose this server publicly as it is: it can change real ad campaigns. Other desktop MCP clients that launch local stdio servers (Cursor, VS Code, Cline) work with the same `command` and `args` as above.

## Verified live (against the real Snapchat API)
Everything above has run live except the items under "Not run live". That includes: pause/enable (single and bulk), budget, bid, targeting (countries, age, gender, interests, devices, include segments, remove exclusions), schedule, rename, bulk edits, undo, campaign / ad squad copy, ad clone, creative clone, create campaign, create ad squad (max bid and auto-bid, with exclusions), lookalike, pixel audience, customer-list audience (with fake data), influencer flow and batch, media upload (simple and chunked), all reports (including async CSV), health check, review issues, pixel health, and the guarded delete (on a throwaway campaign).
Not run live on their own: `snap_create_creative` and `snap_create_ad` (they ran inside the influencer flow), a campaign-level `snap_set_daily_budget`, a successful `snap_delete` of an ad squad, ad or audience, and a customer-list upload of real data.

## Not built
- A hosted multi-user version (this server runs on your own machine with your own credentials).
- Creative types other than WEB_VIEW (Collection, Story, Snap Ad video), product set creation, ad squad types other than purchase-optimized web squads, custom location/radius targeting, lifetime or reach-and-frequency budgets, and position-level reports.
- Anything that spends money without a separate, explicit enable step.

## Development
`npm install`, then `npm test` (all tests use a mocked API; none touch your account).
