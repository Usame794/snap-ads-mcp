# Contributing

Thanks for helping. This tool can change real ad campaigns that spend real money, so the bar for changes is a little higher than usual.

## Ground rules
- **Never use a real account in tests, issues or pull requests.** All tests run against a mocked Snap API (`test/helpers/harness.js`). Do not paste tokens, secrets, account/pixel/profile IDs or ad codes anywhere.
- **Do not weaken a safety control to make something work.** If a limit, preview, approval or audit rule gets in the way, open an issue and explain the case.
- **No market-specific defaults.** Anything that depends on a country, currency, language or time zone must be a setting (see `SNAP_DEFAULT_COUNTRY`), not a constant.
- **New write tools** must go through `write(...)` in `src/tools.js`. `test/safety-tools.test.js` lists every mutating tool and fails if one skips the approval, ownership, limit or audit steps.
- Keep the tool names and input schemas stable. If a change must break them, say so clearly in the pull request.

## Workflow
```bash
npm ci
npm test
npm audit --omit=dev
```
Add tests for every change: the normal case, invalid input, and the case where it should be refused. Describe in the pull request what you verified against a mock and what only the real API can confirm.

## Reporting security problems
Do not open a public issue. See `SECURITY.md`.
