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

## Known limits (from the independent audit of 0.9.6)
These are real and not fixed in code. Know them before you rely on the guards.
- **Shared login: your refresh token is a bearer secret.** In shared-login mode the login service swaps any refresh token issued to the shared app for an access token, without needing a secret from your computer. Anyone who copies the token out of your settings file can use it until you revoke the app in Snapchat Business Manager. The service has **no rate limit yet**, so heavy use of its renew endpoint could get the shared app limited for everyone. A per-address and per-token limit (a Cloudflare Workers rate limit) is the fix and has to be set up in the deployed service. If this matters to you, use your own Snapchat OAuth app.
- **The 24-hour spending limit is kept in one change log file.** Two server processes for the same account with different log files each get a full allowance, deleting the log (or pointing `SNAP_LOG_FILE` at `/dev/null`) resets it, and entries dated more than a minute in the future are ignored, so setting the clock back also resets it. The limit protects against mistakes and a misled assistant, not against someone who can edit files on your computer.
- **Asking you is optional.** `SNAP_HUMAN_APPROVAL` (the Desktop extension's "Ask me before every change") is off by default, because an app that cannot show the question would refuse every change. With it off, the assistant previews and applies changes itself, inside your limits. Turn it on if you want to be asked.
- **Card pages talk to the chat app with `postMessage(..., "*")`.** Incoming messages are accepted only from the window that embeds the card, so this is safe while the chat app is the only parent; the target origin cannot be narrowed because the app's origin is not known to the card.
- **Settings in your environment win over the settings file for limits** that the Desktop extension sets itself, and a person or program that can edit your settings file can change limits after a restart.

