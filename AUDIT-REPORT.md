# Audit of Ads MCP for Snapchat v0.9.5 (branch `mcp-quality-upgrade`)

Phases 1 to 3 only. **No code was changed**, no live ad account call was made, nothing was deleted. Everything below comes from reading the code and from listing the tools through the MCP SDK in memory.

## Phase 1: what is there
- **SDK:** `@modelcontextprotocol/sdk` 1.32.2 (declared `^1.0.0`), `zod` 4.6.7. **Transport:** stdio only (`src/index.js`: `StdioServerTransport`). Node >= 18.
- **Tools:** 85 (45 read-only, 40 write; 15 of the writes marked destructive). 7 prompts. 50 test files, 344 tests.
- **MCP Inspector: NOT RUN.** The command that downloads and runs it from npm was blocked by the session's safety layer. Instead I listed the tools with a real MCP client over an in-memory transport (`tools/list` returns all 85 with annotations and schemas). Run it yourself with `npx @modelcontextprotocol/inspector node src/index.js` if you want the visual check.

### All tools
| Tool | What it does (first sentence) | Kind | Input parameters | Annotations |
|---|---|---|---|---|
| `snap_ping` | Check the Snap credentials work, show who is authorized, and show the safety limits this server is running wit… | read | - | yes |
| `snap_connect` | Connect this server to a Snapchat ad account, from inside the chat. | write | redirected_url, ad_account_id | yes |
| `snap_list_campaigns` | List campaigns in an ad account (read-only). | read | ad_account_id, status, name_contains, limit | yes |
| `snap_list_adsquads` | List ad squads for a campaign, or for the whole ad account when only the account is given (read-only). | read | campaign_id, ad_account_id, status, name_contains, limit | yes |
| `snap_list_ads` | List ads in an ad squad (read-only). | read | adsquad_id | yes |
| `snap_get_entity` | Get one campaign, ad squad or ad in full, including targeting (read-only). | read | entity, id | yes |
| `snap_get_stats` | Stats for one campaign, ad squad or ad over a window (read-only). | read | entity, id, start_time, end_time, granularity, fields | yes |
| `snap_list_creatives` | List creatives in an ad account (read-only), so you can see what can be reused. | read | ad_account_id, name_contains, limit | yes |
| `snap_list_media` | List the images and videos in the ad account (read-only), newest first, to find a media_id for snap_create_cre… | read | type, ready_only, name_contains, limit, ad_account_id | yes |
| `snap_get_media` | Get a media asset and its processing status (read-only). | read | media_id | yes |
| `snap_report` | Performance table for a campaign or ad squad broken down by ad squad or ad: spend, purchases, ROAS, CPA, swipe… | read | entity, id, breakdown, start_time, end_time, swipe_up_attribution_wind | yes |
| `snap_api_get` | Read-only GET against the Snap Marketing API for anything without a dedicated tool (allow-listed paths only, e… | read | path, query, max_chars | yes |
| `snap_list_segments` | List audience segments (customer lists, pixel, engagement, lookalike) with size and status, largest first (rea… | read | source_type, min_size, limit, ad_account_id | yes |
| `snap_list_pixels` | List the Snap pixels of the ad account (read-only). | read | ad_account_id | yes |
| `snap_list_catalogs` | List product catalogs of the organization (read-only). | read | organization_id | yes |
| `snap_list_product_sets` | List product sets of a catalog (read-only). | read | catalog_id | yes |
| `snap_list_dynamic_templates` | List the ad account's dynamic templates (how products are laid out in catalog ads), read-only. | read | limit | yes |
| `snap_create_product_set` | Create a product set in a catalog: a group of products chosen by a filter, for catalog ads. | write | catalog_id, name, filter, confirm, approval_token | yes |
| `snap_create_dynamic_template` | Create a dynamic template: the layout and the (up to two) text fields shown with each product in catalog ads. | write | name, layout, text_fields, background_color, confirm, approval_token | yes |
| `snap_targeting_options` | Look up targeting ids (read-only): interests (lifestyle, shopper, visitation), regions, languages, age groups. | read | kind, country, search | yes |
| `snap_report_daily` | Day-by-day performance (spend, purchases, ROAS, CPA, swipe rate) for a campaign, ad squad or ad, up to 31 days… | read | entity, id, start_time, end_time, swipe_up_attribution_window, view_at | yes |
| `snap_report_audience` | Performance split by country, gender, age, region, dma or make (read-only), for a campaign, ad squad or ad. | read | entity, id, dimension, start_time, end_time | yes |
| `snap_health_check` | Audit every ACTIVE campaign's ACTIVE ad squads (read-only): no buyer exclusion, high frequency, low swipe rate… | read | start_time, end_time, max_frequency, min_swipe_rate_pct, min_spend, mi | yes |
| `snap_audience_size` | Snap's estimate of how many people a targeting can reach, BEFORE spending (read-only, nothing is created). | read | adsquad_id, countries, min_age, max_age, gender, interests, os_type, i | yes |
| `snap_spend_pacing` | Is spend on track? (read-only) Today: each ACTIVE ad squad's spend so far vs its daily budget for this time of… | read | monthly_budget | yes |
| `snap_ad_preview` | A link to see how an ad looks on a phone, before turning it on (read-only). | read | ad_id, creative_id | yes |
| `snap_check_landing_pages` | Check that the web pages your ACTIVE ads send people to actually open (read-only; | read | required_params, max_links | yes |
| `snap_anomaly_check` | Did something change sharply yesterday? (read-only) Compares the last full local day with the usual day (the a… | read | baseline_days, min_daily_spend | yes |
| `snap_blended_roas` | Compare Snap's reported revenue with the revenue your store confirms (read-only). | read | store_revenue, store_orders, days, start_date, end_date | yes |
| `snap_audience_insights` | Who is in an audience? (read-only, Snap's Audience Insights) For a targeting you describe (countries, ages, ge… | read | countries, min_age, max_age, gender, interests, os_type, category | yes |
| `snap_competitor_ads` | Look up the ads a company runs on Snapchat, from Snap's public Ads Gallery (read-only; | read | advertiser, countries, status, start_date, end_date, cursor | yes |
| `snap_capi_status` | Conversions API test events (read-only): how many test events Snap received in the last hour, and the last 24 … | read | pixel_id | yes |
| `snap_capi_test_event` | Send ONE test event to Snap's Conversions API validate endpoint, to check your server-side tracking is built c… | write | event_name, event_source_url, email, value, currency, order_id, pixel_ | yes |
| `snap_report_hourly` | Which hours of the day work best? (read-only) Spend, purchases, ROAS and cost per purchase for each local hour… | read | entity, id, days | yes |
| `snap_creative_compare` | Which ads win? (read-only) Compares the ads of a campaign or ad squad: spend, purchases, ROAS, cost per purcha… | read | entity, id, start_time, end_time, min_spend, limit | yes |
| `snap_budget_advice` | Where could budget move? (read-only suggestions; | read | days, min_spend, extra_budget | yes |
| `snap_billing_check` | Will ads keep running? (read-only) The ad account's status, its funding sources (card expiry, daily spend limi… | read | - | yes |
| `snap_unused_media` | Which uploaded images and videos does no creative use? (read-only; | read | limit | yes |
| `snap_audience_health` | Audience problems (read-only): segments that are not targetable, too small (under 1,000 people) or customer li… | read | stale_days, min_size | yes |
| `snap_funnel` | Where do people drop off? (read-only) Impressions, swipes, content views, add to cart, checkout and purchases … | read | entity, id, days | yes |
| `snap_catalog_feed_status` | Are the product feeds loading? (read-only) For each catalog of the organization: its feeds, the last completed… | read | organization_id | yes |
| `snap_portfolio_summary` | All your ad accounts side by side (read-only): for each account yesterday and the last 7 days (spend, purchase… | read | - | yes |
| `snap_review_issues` | Ads that are rejected or pending review, with Snap's reasons (read-only). | read | only_active | yes |
| `snap_pixel_health` | Pixel signal readiness and event-quality recommendations, highest priority first (read-only). | read | pixel_id | yes |
| `snap_report_compare` | Compare two time windows for a campaign, ad squad or ad, optionally per child (ad squads or ads): spend, purch… | read | entity, id, breakdown, current_start, current_end, previous_start, pre | yes |
| `snap_report_async_start` | Start a large CSV report (no size limit, unlike the synchronous reports). | read | entity, id, start_time, end_time, granularity, breakdown | yes |
| `snap_report_async_status` | Status of an async report (STARTED, RUNNING, COMPLETED) (read-only). | read | entity, id, report_run_id | yes |
| `snap_report_async_download` | Download a COMPLETED async report as a CSV into this project's exports/ folder and return its path and row cou… | write | entity, id, report_run_id, file_name | yes |
| `snap_creative_fatigue` | Which ads are tired? Compares each ad of a campaign or ad squad this window vs the one before: FATIGUED (ROAS … | read | entity, id, end_time, days, min_spend | yes |
| `snap_change_log` | Show the most recent changes and audit events this server recorded. | read | limit | yes |
| `snap_set_status` | Pause (PAUSED) or enable (ACTIVE) a campaign, ad squad or ad. | write, destructive | entity, id, status, confirm, approval_token | yes |
| `snap_set_status_bulk` | Enable (ACTIVE) or pause (PAUSED) up to 20 campaigns, ad squads or ads in one go. | write, destructive | entity, ids, status, confirm, approval_token | yes |
| `snap_set_daily_budget` | Set the daily budget (in account currency, e.g. | write, destructive | entity, id, daily_budget, confirm, approval_token | yes |
| `snap_exclude_segments` | Add audience segments (e.g. | write, destructive | adsquad_id, segment_ids, confirm, approval_token | yes |
| `snap_copy_campaign` | Copy a campaign with its ad squads (and optionally ads) into a NEW campaign. | write | campaign_id, new_name, include_ads, budget_scale, squad_ids, resume_ca | yes |
| `snap_clone_ad` | Clone an existing ad (same creative) into other ad squads. | write | ad_id, target_adsquad_ids, new_name, confirm, approval_token | yes |
| `snap_claim_ad_code` | Claim a creator's ad code (adcode_<uuid>) into the ad account. | write | ad_code, profile_id, confirm, approval_token | yes |
| `snap_create_creative` | Create a creative from a READY image or video: WEB_VIEW (default; | write | media_id, name, headline, creative_type, dynamic_template_id, product_ | yes |
| `snap_create_ad` | Create an ad from an existing creative inside an ad squad. | write | creative_id, adsquad_id, name, ad_type, confirm, approval_token | yes |
| `snap_create_story_creative` | Create a Story Ad creative: 1-20 existing creatives (SNAP_AD, WEB_VIEW, APP_INSTALL or DEEP_LINK) shown in the… | write | name, headline, creative_ids, preview, profile_id, confirm, approval_t | yes |
| `snap_create_collection_creative` | Create a Collection Ad creative: a main image or video plus 4-20 product tiles, each a square image (1:1, at l… | write | name, top_snap_media_id, headline, fallback_url, button_label, product | yes |
| `snap_influencer_ad` | Full influencer flow in one step: claim a creator ad code, wait for the media, create a WEB_VIEW creative, and… | write | ad_code, adsquad_id, name, headline, url, call_to_action, profile_id,  | yes |
| `snap_rename` | Rename a campaign, ad squad or ad. | write, destructive | entity, id, new_name, confirm, approval_token | yes |
| `snap_set_bid` | Set the max bid (account currency) on an ad squad that uses a max bid. | write, destructive | adsquad_id, bid, confirm, approval_token | yes |
| `snap_set_frequency_cap` | Limit how often one person sees an ad squad's ads: at most `count` impressions per `every` HOURS or DAYS (up t… | write | adsquad_id, count, every, unit, clear, confirm, approval_token | yes |
| `snap_set_ad_schedule` | Choose which hours of which days an ad squad's ads run (hours 0-23 in each viewer's local time), or run every … | write | adsquad_id, schedule, always, confirm, approval_token | yes |
| `snap_set_bid_strategy` | Switch an ad squad between max bid (LOWEST_COST_WITH_MAX_BID) and target cost (TARGET_COST), with the bid for … | write, destructive | adsquad_id, strategy, bid, confirm, approval_token | yes |
| `snap_set_placement` | Choose where on Snapchat an ad squad's ads may appear: automatic (everywhere) or custom positions (PUBLIC_STOR… | write | adsquad_id, mode, positions, confirm, approval_token | yes |
| `snap_copy_adsquad` | Copy one ad squad (optionally with its ads) into a target campaign. | write | adsquad_id, target_campaign_id, new_name, include_ads, budget_scale, c | yes |
| `snap_create_campaign` | Create a new, empty campaign (always PAUSED, starting shortly after you enable it). | write | name, objective, catalog_id, confirm, approval_token | yes |
| `snap_upload_media` | Upload a local video (.mp4/.mov) or image (.jpg/.png), up to 1 GB (files over 32 MB go in chunks), to the ad a… | write | file_path, name, confirm, approval_token | yes |
| `snap_create_adsquad` | Create a new ad squad from a few choices (a web squad with a max bid, optimized for purchases by default; | write | campaign_id, name, daily_budget, bid, bid_strategy, pixel_id, interest | yes |
| `snap_set_targeting` | Change an ad squad's targeting: countries, age, gender, interests, device OS, include segments, or stop exclud… | write, destructive | adsquad_id, countries, min_age, max_age, gender, interests, clear_inte | yes |
| `snap_set_schedule` | Set start_time and/or end_time (ISO with offset) on a campaign or ad squad. | write, destructive | entity, id, start_time, end_time, confirm, approval_token | yes |
| `snap_create_lookalike` | Create a lookalike audience from a first-party (customer list) seed segment. | write | seed_segment_id, name, countries, type, retention_days, confirm, appro | yes |
| `snap_bulk_exclude_segments` | Add the same buyer-exclusion audiences to up to 20 ad squads. | write, destructive | adsquad_ids, segment_ids, confirm, approval_token | yes |
| `snap_bulk_set_budget` | Change the daily budget of up to 20 ad squads at once: mode 'set' (same value for all) or 'scale' (multiply ea… | write, destructive | adsquad_ids, mode, value, confirm, approval_token | yes |
| `snap_bulk_set_schedule` | Set start/end time on up to 20 campaigns or ad squads. | write, destructive | entity, ids, start_time, end_time, confirm, approval_token | yes |
| `snap_bulk_rename` | Find-and-replace inside the names of up to 20 campaigns, ad squads or ads. | write, destructive | entity, ids, find, replace, confirm, approval_token | yes |
| `snap_influencer_batch` | Influencer flow for up to 10 ad codes into one ad squad: for each, claim, wait for media, create creative, cre… | write | adsquad_id, items, headline, url, call_to_action, profile_id, confirm, | yes |
| `snap_clone_creative` | Duplicate a creative with a new name and optionally a new headline, link or call to action (same media). | write | creative_id, name, headline, url, call_to_action, confirm, approval_to | yes |
| `snap_undo` | Revert one of the changes this server applied (budget, bid, status, targeting, schedule, rename) using the cha… | write, destructive | n_from_last, force, confirm, approval_token | yes |
| `snap_create_pixel_audience` | Create an audience of people who fired pixel events (e.g. | write | name, events, retention_days, pixel_id, confirm, approval_token | yes |
| `snap_upload_customer_list` | Create a customer-list audience from a local CSV of emails or phone numbers. | write | file_path, kind, name, column, default_country_code, confirm, approval | yes |
| `snap_delete` | Permanently delete a campaign, ad squad, ad or audience. | write, destructive | entity, id, confirm_name, confirm, approval_token | yes |

## Phase 2: checklist
Status: PASS, FAIL, PARTIAL, N/A. "Evidence" names the file; line numbers are given where I read them directly.

| ID | Status | Evidence | Fix |
|---|---|---|---|
| A1 goal-based tools | PARTIAL | Goal tools exist (`snap_anomaly_check`, `snap_budget_advice`, `snap_funnel`, `snap_spend_pacing`, 7 prompts) but many are thin wrappers: 10 `list_*`, 10 `set_*`, `get_entity`, `get_stats`. | Keep the goal tools; merge thin wrappers (see A2). |
| A2 near-duplicates | FAIL | `set_status`/`set_status_bulk`; `set_daily_budget`/`bulk_set_budget`; `set_schedule`/`bulk_set_schedule`/`set_ad_schedule`; `rename`/`bulk_rename`; `exclude_segments`/`bulk_exclude_segments`; `report`/`report_daily`/`report_hourly`/`report_compare`/`report_audience`; `copy_campaign`/`copy_adsquad`/`clone_ad`/`clone_creative`; `get_entity` vs `list_*`. | Merge each family into one tool with a parameter (`ids` instead of a bulk twin, `granularity`/`mode` for reports). Keep old names as deprecated aliases. |
| A3 one clear purpose | PARTIAL | Same families as A2 overlap. | Follows from A2. |
| A4 tool count | FAIL (mitigated) | 85 tools. Mitigation: `SNAP_TOOLSETS` hides groups (`src/toolsets.js`), but default is all. | Consolidate toward about 40; make a smaller default toolset. |
| A5 raw passthrough | PASS | `snap_api_get`: readOnlyHint, allow-listed paths only, description says it is for anything without a dedicated tool and "Never writes". | Optionally say "last resort" in the first sentence. |
| A6 naming | PARTIAL | 85/85 are `snap_` + snake_case. About 30 are not verb-first (`snap_report_*`, `snap_audience_*`, `snap_spend_pacing`, `snap_budget_advice`, `snap_funnel`, `snap_health_check`...). | Rename noun-first tools with deprecated aliases (low value, high churn; do last). |
| B1 when to use / not use | PARTIAL | Median description 318 characters, good detail, but 22 of 85 contain no pointer such as "use", "instead", "not", "only" (e.g. `snap_set_daily_budget`, `snap_create_campaign`, `snap_delete`, `snap_rename`). Pointers to a better tool are rare. | Add "Use this when... / Not for...; use X instead" to each. |
| B2 description matches code | PARTIAL | Spot checks match (`snap_get_stats`: "spend is in micro-currency" matches code). No automated check beyond the README table test. | Add a test that every description's referenced tool names exist. |
| B3 parameter names and descriptions | FAIL | 248 of 400 parameters have no description (62%). Generic names: `id` (18 tools), `entity` (21), `name` (14), `ids` (3). | Add `.describe()` with an example to every parameter; where the API allows, rename to `campaign_id`/`adsquad_id` style. |
| B4 strict schemas | PASS | zod schemas with types, enums and length limits throughout (for example `z.string().max(500)` on cursors); limits and ranges validated in `src/policy.js`. | None. |
| B5 dates | PARTIAL | Snap needs hour-aligned ISO date-times with an offset; documented in `snap_get_stats` (tools.js:412) and the report tools; offset setting `SNAP_REPORT_UTC_OFFSET`. Not YYYY-MM-DD. | Accept `YYYY-MM-DD` and convert using the configured offset; keep ISO as an option. |
| B6 where to get IDs | PARTIAL | Some say it (for example "then poll snap_get_media"), not systematic. | One line per ID parameter: "from snap_list_campaigns". |
| C1 names next to IDs | PASS | Lists and breakdown reports return names. Time series drop them by design. | None. |
| C2 money | PASS | `src/report.js` converts micro to currency, totals computed from raw micro values, labeled "account currency". Raw tools (`snap_get_stats`, `snap_get_entity`) return micro and say so. | Optionally add a `currency` field to raw outputs. |
| C3 rates labeled | PARTIAL | Labeled in reports; percent vs fraction not checked everywhere. | Add a units note to each rate field; add a test. |
| C4 response_format | FAIL | 0 tools have it. | Add `response_format: concise\|detailed` to report and list tools. |
| C5 pagination | FAIL | Only 6 list tools take `limit`; none return `has_more`/`next_cursor` (only `snap_competitor_ads` has a cursor, tools.js:737). `snap_list_ads`, `list_pixels`, `list_catalogs`, `list_product_sets` have no limit at all. | Add `limit` (default 25) and `cursor`, return `has_more` and `next_cursor`. |
| C6 truncation messages | PARTIAL | Some tools say what was cut (`creative_compare`, landing page check), no general mechanism. | A shared helper that truncates and says how to narrow the query. |
| C7 structured output | FAIL | 0 tools define `outputSchema`; no `structuredContent` anywhere. Results are JSON text only (tools.js:42). | Return `structuredContent` plus the text copy; add `outputSchema` to the most-used tools first. |
| D1 isError | PASS | Shared `fail()` returns `isError: true` (tools.js:56) in all catch blocks. | None. |
| D2 error = problem + fix | PARTIAL | Many do (for example "Run npx ... setup", supported file types list); not uniform and few include an example of valid input. | Standard error shape: problem, fix, example. |
| D3 Snap errors translated | PARTIAL | 401 refresh-and-retry and login-service messages are clear (snap.js:164-176); other Snap errors pass the reason through, trimmed. | A table of Snap error codes to messages (rate limit, permission, invalid entity). |
| D4 no leaks | PASS | Errors use only the message, no stack; audit log redacts tokens, ad codes, emails, phones (`src/audit-log.js`); tests check no secret is printed. | None. |
| D5 rate limits | PASS | Retries on 429 and 5xx for reads, only on 429 for writes, honoring `Retry-After` (snap.js:132-189). | Tell the user the wait time in the final error. |
| E1 annotations present | PASS | All 85 have `readOnlyHint` and `openWorldHint`; all 40 writes also have `destructiveHint` and `idempotentHint`. The 45 read-only tools omit the last two, which is correct (they only apply to writes). | None. |
| E2 destructive marked correctly | PARTIAL | Marked destructive: status, budget, rename, bid, bid strategy, targeting, schedule, exclude, undo, delete and the bulk tools (15). **Not marked but should be:** `snap_set_frequency_cap`, `snap_set_ad_schedule`, `snap_set_placement` (overwrite existing settings) and `snap_claim_ad_code` (uses up a single-use code, irreversible). | Set `destructiveHint: true` on these four. |
| E3 confirm / dry run | PASS | Every write previews first and needs `confirm` plus a matching `approval_token`; bound to account, parameters and state; tested. | None. |
| E4 hard limits | PASS | `src/policy.js`: daily budget, bid, increase %, 24-hour added-budget ledger, activation limit; independent of annotations; hardening tests. | None. |
| E5 change log / undo | PASS | `changes.log.jsonl`, `snap_change_log`, `snap_undo` (whitelist of fields); tests. | None. |
| E6 created paused | PASS | Builders in `src/create.js` set PAUSED; README states it; tests. | None. |
| F1 secrets from env | PASS | Environment or settings file; the extension stores the secret as sensitive. | None. |
| F2 token refresh | PASS | Automatic refresh (own app or login service), clear "run setup" errors. | None. |
| F3 remote OAuth 2.1 | N/A | The server is local stdio. The optional login service is a separate component that seals tokens to the user's computer. | Revisit if a hosted version is built. |
| F4 input validation | PARTIAL | URLs: https only, public IPs only, redirects checked (`src/checks.js`). Media upload: extension whitelist, exists, size 1 GB (create.js:40-53) but **no directory restriction or symlink check**, so an injected instruction could preview an upload of any .jpg/.png/.mp4 on the computer (approval still required). | `SNAP_MEDIA_DIR` allow-list and `realpath` check; same for customer-list files. |
| F5 stdio hygiene | PASS | No `console.log` or stdout writes in the server code (only in CLI commands). | None. |
| F6 .gitignore | PASS | `.env`, `.env.*`, `changes.log.jsonl`, `exports/` ignored; none tracked. | None. |
| G1 to G8 MCP Apps | FAIL (optional) | No `ui://` resources or `_meta.ui` anywhere. G2 to G8 N/A until G1 exists. | Only if you say yes (Phase 4, step 7). |
| H1 evaluation questions | FAIL | No evaluation question set in the repo. | Write 10 read-only questions with known answers against the fake Snap used in tests. |
| H2 unit tests | PASS | 344 tests in 50 files cover validation, error mapping, money conversion, limits, approvals, login service. | None. |
| H3 README | PARTIAL | Install, auth, every tool (a test enforces completeness), limits and settings are there. Missing: an example per tool, required Snapchat permissions per tool, a rate-limits section. | Add a short example column and a permissions and rate limits section. |
| H4 version and changelog | PASS | `package.json`, `CHANGELOG.md` kept per release. | None. |

## Phase 3: summary
**Top 5 problems by impact**
1. **No structured output and no response_format (C4, C7).** Every answer is JSON text. Clients and models cannot rely on a schema, and long answers cannot be made short.
2. **Tool sprawl (A2, A4).** 85 tools with many near-duplicates make it harder for an AI to pick the right one.
3. **Parameters are mostly undocumented (B3, B6).** 62% have no description, and `id`/`entity` are generic. This is the most likely cause of wrong calls.
4. **No real pagination (C5, C6).** Lists have no `has_more`/`next_cursor`, and four have no limit.
5. **Safety metadata gaps (E2, F4).** Four tools are mislabeled as non-destructive, and media upload accepts any path on the computer.

**Quick (under 1 hour each):** E2 four annotations; F4 upload directory allow-list; H1 ten evaluation questions; D5 retry-time message; B2 test that referenced tool names exist.
**Medium (1 to 3 hours):** B3/B6 parameter descriptions across all tools; C5 limit and cursor on list tools; H3 README additions; B5 date handling; D2/D3 error shapes.
**Big (a day or more):** C7 `outputSchema` and `structuredContent`; C4 `response_format`; A2/A4 consolidation with deprecated aliases; G MCP Apps.

**Recommended order (the brief's priority):** 1) safety: E2, F4; 2) errors: D2, D3, D5; 3) descriptions and parameters: B1, B3, B6, B5; 4) pagination and size: C5, C6, C4; 5) consolidation: A2, A4 (aliases kept); 6) tests and README: H1, H3, C7; 7) MCP Apps only if you say yes.

## What I could not verify
- The MCP Inspector was not run (blocked); the in-memory MCP client check above replaces it.
- B2 and C3 were spot-checked, not checked for every tool.
- Nothing was tested against the real Snap API, by design.

## Phase 4 progress (branch `mcp-quality-upgrade`)
Done, each in its own commit, with tests (370 passing):

| ID | New status | What changed |
|---|---|---|
| E2 | PASS | `snap_set_frequency_cap`, `snap_set_ad_schedule`, `snap_set_placement`, `snap_claim_ad_code` now marked destructive. |
| F4 | PASS (opt-in) | New `SNAP_MEDIA_DIR`: media and customer-list files must be inside it (symbolic links resolved). Not on by default, so nothing breaks for existing users. |
| D2, D3, D5 | PASS | Snap HTTP errors end with a "Fix:" sentence; 429 says how long to wait. |
| B1, B3, B6 | PASS | Every parameter has a description with its id source and units (a test enforces 100%); 22 tools got a "use this / not that" pointer. |
| C4 | PARTIAL | `response_format` (concise or detailed) on all `snap_list_*` tools. Not yet on reports. |
| C5 | PASS | `limit`, `offset`, `has_more`, `next_offset` on every list tool (the tools read all pages from Snap internally, then page the result). |
| C7 | PARTIAL | Object results also come back as `structuredContent`. No `outputSchema` yet. |
| H1 | PASS | `test/eval/questions.json`, ten read-only questions with known answers, run by the tests. |
| H3 | PASS | README: examples, permissions, rate limits, paging. |

Not done yet (waiting for your decision, or optional): A2/A3/A4 consolidation (a plan comes first, because it renames and merges tools), A6 renames, B5 YYYY-MM-DD date input, C3 units sweep, C6 shared truncation helper, `outputSchema`, and MCP Apps (G). Still not run: MCP Inspector.

### Round two
| ID | New status | What changed |
|---|---|---|
| B5 | PASS | A plain `YYYY-MM-DD` is accepted for every start and end time (00:00 that day in `SNAP_REPORT_UTC_OFFSET`); ISO date-times still work. |
| C3 | PASS | Rates already carry their unit in the name (`*_pct` for percent, `roas` as a ratio, money in account currency); noted, no change needed. |
| C6 | PASS | One shared cut-off (`SNAP_MAX_RESPONSE_CHARS`, default 100000) with a note on how to ask for less. |
| C7 | PARTIAL | `outputSchema` on all `snap_list_*` tools; other tools return `structuredContent` without a declared schema. |

### Round three: consolidation (approved with "go")
| ID | New status | What changed |
|---|---|---|
| A2 | PASS | Near-duplicates merged: `snap_set_status`, `snap_rename`, `snap_set_schedule`, `snap_exclude_segments` and `snap_set_daily_budget` take one id or many ids; `snap_report` takes `view` (table, daily, hourly, compare, audience). The old tools do the work unchanged, so every limit, preview and approval is the same. |
| A3 | PASS | Follows from A2. |
| A4 | PARTIAL | 85 tools became 76. A `core` set of 44 everyday tools is the Desktop extension default; `all` shows everything. The count is not near 40 because the remaining tools do different jobs. |
| A6 | NOT DONE | Noun-first names (for example `snap_report_async_start`, `snap_audience_size`) were left as they are: all are `snap_` + snake_case, and renaming them would cost users more than it helps. |
| Compatibility | n/a | Old names are hidden unless `SNAP_LEGACY_TOOLS=1`; then they appear as deprecated aliases that point to the new tool. |

### Round four: MCP Apps (approved with "can we add interactive tools")
| ID | New status | What changed |
|---|---|---|
| G1 | PASS | `snap_dashboard` and `snap_campaign_board` carry `_meta.ui.resourceUri` (and the older `ui/resourceUri` key) pointing to `ui://` pages served as `text/html;profile=mcp-app`; every tool that previews a change shows a preview card. |
| G2 | PASS | Every card tool still returns a text summary and structured data. |
| G3 | PASS | Cards are small and inline; the dashboard has four to five numbers and a chart, the board is a short list. No full-screen mode is requested. |
| G4 | PASS | The pages use the host's style variables, with light and dark fallbacks and the host's theme. |
| G5 | PASS | No network access is declared (empty CSP lists) and none is used; the shared script is inlined, so there are no external files. |
| G6 | PASS | Tested at 320 px wide in dark mode (no sideways scrolling), 44 px tap targets, no dropdown menus, skeleton loading states. |
| G7 | PASS | Cards only use buttons and switches; text entry stays in the chat. |
| G8 | PASS | Pause, Resume and Apply call the same tools with the same preview, approval token, limits and read-only rule (section E). |

Tested in a real browser (Chromium) with a fake chat app speaking the MCP Apps protocol and the real server behind it. **Not tested in Claude Desktop itself**: whether it shows the cards for a local extension has to be checked there.

## Independent audit of 0.9.6: response
An outside reviewer audited 0.9.6 (16 findings). Each was reproduced against this code first (11 with a proof-of-concept test that passed while the bug existed); the fixes are in `test/audit-fixes.test.js`.

| ID | Severity | Status |
|---|---|---|
| F1 stale update after approval | High | Fixed (re-read after the question; updated_at check) |
| F2 forged login token into .env | High | Fixed (token shape check; no line breaks in settings values) |
| F3 campaign-level budget on enable | Medium-high | Fixed |
| F4 board hid the budget on Resume | Medium | Fixed by the interactive patch; regression test in `interactive-browser.test.js` |
| F5 `snap_api_get` encoded dots | Medium-low | Fixed |
| F6 `snap_connect` bypassed safeguards | Medium | Fixed |
| F7 approval off, wording | Medium | Setting added; wording corrected; default stays off (see SECURITY.md) |
| F8 undo with force | Low-medium | Fixed |
| F9 template ownership | Low | Fixed |
| F10 ids not checked | Low | Pixels and audiences fixed; brand profile and media ids still rely on Snap refusing a foreign id |
| F11 link checker rebinding | Low | Fixed (pinned connection); not tested against real DNS from this environment |
| F12 local files / header echo | Low | Header echo fixed; `SNAP_MEDIA_DIR` stays opt-in so existing uploads keep working |
| F13 login service renew endpoint | Medium (design) | **Not fixed in code**: needs a rate limit in the deployed service; documented in SECURITY.md |
| F14 untrusted names in the question | Low | Fixed |
| F15 partial ad schedule | Low | Fixed |
| F16 plain end date, rotated tokens | Info | Fixed |
| Design items | | Download redirects and size, auto-strip, approval store size, copy reuse: fixed. Single-log 24-hour limit, `postMessage` target `*`: documented. |
