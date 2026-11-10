# Security policy

## Reporting a vulnerability
Please do not open a public issue for security problems. Use GitHub's "Report a vulnerability" (private security advisory) on this repository.

## Handling secrets
- Credentials live only in your local `.env`, which is git-ignored. Never commit it, paste it in issues, or share logs that contain it.
- If a client secret or refresh token is ever exposed, revoke it in Snap Ads Manager (Business Details > OAuth Apps) and create a new one.
- `changes.log.jsonl` and `exports/` can contain account data; they are git-ignored too.

## Safety design
Write tools preview by default, create objects paused, enforce size limits and verify changes after applying them. Still, this tool edits real campaigns: review each preview before confirming.
