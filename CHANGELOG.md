# Changelog

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
