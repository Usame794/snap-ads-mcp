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

## What this server connects to
Everything runs on your computer. These are the only outside addresses it contacts:

| Address | What for | What is sent |
|---|---|---|
| `adsapi.snapchat.com`, `accounts.snapchat.com` | The Snapchat Marketing API and login | Your requests, with your access token |
| `tr.snapchat.com` | Conversions API **test** events and their status (`snap_capi_*`) | Your access token and one test event; an email is hashed first. Real conversion events are never sent. |
| `adsapi.snapchat.com/v1/ads_library/...` | Competitor ads (`snap_competitor_ads`) | The advertiser name you search for. **No token**, nothing about your account. |
| The links of your own active ads | `snap_check_landing_pages` opens each link once | A plain request. Only `https`, never private, loopback or link-local addresses, and every redirect is checked again. No credentials. |
| The shared login service (`SNAP_BROKER_URL`, default `ads-mcp-for-snapchat-login.ads-mcp.workers.dev`; `off` disables it), only if you chose the shared login | Logging in, and renewing the 30-minute access token | Your refresh token (it must, to renew). It stores nothing; see `PRIVACY.md`. Only use a service you trust. |

Text that comes back from outside (competitors' ads, page contents, ad review reasons) is untrusted data: it is cut, marked as such in the answer, and must not be followed as instructions. `SNAP_PORTFOLIO_FILES` can only be set by you in your own settings; the AI app cannot choose which files are read. The audit log removes credentials, emails and phone numbers from logged arguments.

## Safety design
Write tools need the approval token of a preview of the exact same request, create objects paused, enforce absolute and relative money limits that fail closed, only touch the configured ad account, and record every write in an audit log. The approval token is not a human signature: keep your MCP client's permission prompt on for write tools (see README, "What the approval token is not"). This tool edits real campaigns: review each preview before approving.
