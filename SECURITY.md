# Security policy

## Reporting a vulnerability
Please do not open a public issue for security problems. Use GitHub's "Report a vulnerability" (private security advisory) on this repository. Never include real tokens, secrets or account data in a report; describe how to reproduce it with a mock.

Supported version: the latest release on `main`. This is a small, unofficial project maintained on a best-effort basis.

## Handling secrets
- Credentials live only in your local `.env`, which is git-ignored. Never commit it, paste it in issues, or share logs that contain it.
- If a client secret or refresh token is ever exposed, revoke it in Snap Ads Manager (Business Details > OAuth Apps) and create a new one.
- `changes.log.jsonl` and `exports/` can contain account data; they are git-ignored too.

- Rotate the client secret whenever it may have been seen outside your machine (pasted in a chat, a screenshot, a shared terminal): create a new secret in Snap Ads Manager, run `node scripts/save-secret.js`, then authorize again with `scripts/get-refresh-token.js`. The old secret and refresh token stop working.
- Anything that can read `.env` holds the full API credentials and bypasses every guard in this server. Deny your AI client's file tools access to `.env` and `changes.log.jsonl`.

## Safety design
Write tools need the approval token of a preview of the exact same request, create objects paused, enforce absolute and relative money limits that fail closed, only touch the configured ad account, and record every write in an audit log. The approval token is not a human signature: keep your MCP client's permission prompt on for write tools (see README, "What the approval token is not"). This tool edits real campaigns: review each preview before approving.
