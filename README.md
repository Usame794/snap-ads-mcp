# snap-ads-mcp

Local MCP server for the Snapchat Marketing API. It reads, edits and creates campaigns, ad squads and ads, and turns influencer **ad codes** into paused ads.

> **Unofficial.** Not affiliated with or endorsed by Snap Inc. This tool changes real ad campaigns that spend real money. You use it at your own risk (see LICENSE). Review every preview before confirming.

## Safety rules (built in)
- Every write tool **previews by default**. Nothing is sent unless `confirm=true`.
- Everything that creates something (copies, clones, new ads, new creatives) is created **PAUSED**. Enabling is a separate, confirmed step.
- The only delete tool is `snap_delete`, behind many guards. Status can only be `ACTIVE` or `PAUSED`.
- Limits: budget increases max +100% per step (`SNAP_MAX_BUDGET_INCREASE_PCT`), minimum daily budget (`SNAP_MIN_DAILY_BUDGET`), bid increases max +50% (`SNAP_MAX_BID_INCREASE_PCT`), max 20 items per bulk action.
- Changes are read back to verify and appended to `changes.log.jsonl`.
- Multi-step creates (copy, influencer flow) stop at the first failure and report exactly what was already created.
- Secrets live only in `.env` (git-ignored). The server re-reads `.env` when it needs a token.

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

## Verified live (against the real Snapchat API)
Everything above has run live except the items under "Not run live". That includes: pause/enable (single and bulk), budget, bid, targeting (countries, age, gender, interests, devices, include segments, remove exclusions), schedule, rename, bulk edits, undo, campaign / ad squad copy, ad clone, creative clone, create campaign, create ad squad (max bid and auto-bid, with exclusions), lookalike, pixel audience, customer-list audience (with fake data), influencer flow and batch, media upload (simple and chunked), all reports (including async CSV), health check, review issues, pixel health, and the guarded delete (on a throwaway campaign).
Not run live on their own: `snap_create_creative` and `snap_create_ad` (they ran inside the influencer flow), a campaign-level `snap_set_daily_budget`, a successful `snap_delete` of an ad squad, ad or audience, and a customer-list upload of real data.

## Not built
- A hosted multi-user version (this server runs on your own machine with your own credentials).
- Creative types other than WEB_VIEW (Collection, Story, Snap Ad video), product set creation, ad squad types other than purchase-optimized web squads, custom location/radius targeting, lifetime or reach-and-frequency budgets, and position-level reports.
- Anything that spends money without a separate, explicit enable step.

## Development
`npm install`, then `npm test` (all tests use a mocked API; none touch your account).
