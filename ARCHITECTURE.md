# Architecture and design notes

For contributors. Unofficial local MCP server (Node ESM, stdio) for the Snapchat Marketing API: 57 tools, all tests mocked (`npm test`). Read `README.md` first for setup and the tool table.

## Architecture (src/)
- `index.js`: MCP server entry. `tools.js`: all 57 tool definitions (zod schemas, handlers).
- `snap.js`: `SnapClient` (token refresh, retry), `ENTITIES` (campaign, adsquad, ad, creative, media, segment), sanitize-for-create/update helpers, `createEntity/updateEntity/getEntity/listChildren`, `upload`.
- `env.js`: `.env` loading and `setEnvValue` (writes a value without printing it).
- `changes.js`: plan functions (status, budget, exclusions, rename, bid, targeting, schedule), `applyChange` (logs before/after), `containsDeep`, `planUndo`.
- Feature modules: `formats.js` (SNAP_AD, Story and Collection builders, ad type per creative type, CTA list), `copy.js`, `clone-ad.js`, `bulk.js`, `bulk-edit.js`, `influencer.js`, `influencer-batch.js`, `create.js`, `creative-tools.js`, `readers.js`, `report.js`, `async-report.js`, `audit.js`, `fatigue.js`, `customer-list.js`, `delete.js`.
- `policy.js` (limits and market settings, validated at startup), `approval.js`, `ownership.js`, `activation.js`, `audit-log.js` (see "Safety design").
- `scripts/`: `check.js`, `get-refresh-token.js`, `save-secret.js` (clipboard or `--stdin`, via `src/clipboard.js`), `smoke.js` (9 live read checks), `live-create-creative.js`, `weekly-report.js`.

## Safety design (keep it)
- Writes go through one path in `tools.js` (`write`): preview with a single-use `approval_token` (`approval.js`), ownership check (`ownership.js`), audit intent/result (`audit-log.js`). `confirm=true` without the token of that exact preview sends nothing.
- Everything created is PAUSED. Status is only ACTIVE or PAUSED.
- Limits live in `policy.js`, validated at startup (invalid = server does not start): absolute daily budget / bid / lifetime / activation ceilings, +100% budget and +50% bid per step and per 24h, minimum daily budget. 20 items per bulk action (fixed).
- Each change is read back and verified (`containsDeep` compares only changed fields), then appended to `changes.log.jsonl` with before/after so `snap_undo` works (it refuses if the object changed again).
- Multi-step flows stop at the first failure. `snap_delete` is guarded: paused, no spend in 30 days, no active children, exact name typed.
- Reads retry on 429/5xx/network with backoff. Writes retry only on 429, so a create or claim is never repeated.

## Snap API quirks learned the hard way
- OAuth redirect URI must be https (`https://127.0.0.1/callback`); `localhost` is rejected. The client secret is shown once.
- `claim_media_by_ad_code`: `ad_code` and `profile_id` go as QUERY params (a JSON body gives a 500). Ad codes are single-use and one-way; expired codes are not consumed.
- Reading ad squads needs `return_placement_v2=true` if you plan to re-create them. `catalog_vertical` must be stripped on create. Keep `render_type` for ads. A creative's product set must match the ad squad's.
- Breakdown stats are paged: follow `paging.next_link` (`collectBreakdown`). `report_dimension` values: country, gender, age, region, dma, make. Conversion fields do not work with `dimension=`.
- Chunked media upload: INIT/ADD/FINALIZE, 30 MiB chunks, up to 1 GB.
- Snap's default attribution (1-day view) overstates results vs last-click store data. Use Snap numbers to compare trends, not as revenue.

## Not built
- Hosted multi-user version (needs per-user OAuth, encrypted token storage, abuse protection). Not planned in this repository.
- Non-WEB_VIEW creatives (Collection, Story, video formats), product set creation, position-level reports, lifetime / reach-and-frequency budgets, custom location targeting.
- Not run live on their own: `snap_create_creative`, `snap_create_ad` (ran inside the influencer flow), campaign-level `snap_set_daily_budget`, a successful `snap_delete` of an ad squad / ad / audience, real-data customer-list upload.

## Working rules for contributors
- Run `npm test` after every change. Run `npm run smoke` (needs real credentials) after touching the API client.
- Never commit `.env`, `changes.log.jsonl`, or `exports/`. Never print secrets or paste them into chat.
- Test live changes only on paused throwaway objects, and clean them up in Ads Manager.
- Keep identifiers (account, pixel, profile IDs, ad codes) and anything specific to one market or one business out of committed files and tests.
- A new write tool must go through `write` in `src/tools.js`, so it gets the preview/approval, ownership check, spend limits and audit trail. `test/safety-tools.test.js` fails if a mutating tool bypasses them.
