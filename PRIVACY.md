# Privacy

Ads MCP for Snapchat is open-source software that runs **on your own computer**. This page covers the optional **shared login service** and the tool itself.

## The tool (on your computer)
- Your settings, the change log and exports stay on your computer. Nothing is sent to the maintainer.
- It talks to Snapchat's servers with your login to read and change your own ad account, as you ask. It also contacts the addresses listed in `SECURITY.md`.
- Your AI app (for example Claude) sees the data the tool returns, under that app's own terms.

## The shared login service (optional)
The default service is at `https://ads-mcp-for-snapchat-login.ads-mcp.workers.dev`. It is run by the maintainer of this project on Cloudflare Workers; the code it runs is `broker/worker.js` in this repository. Set `SNAP_BROKER_URL=off` to turn it off, or point `SNAP_BROKER_URL` at your own copy.

The service lets you log in with Snapchat without creating your own Snapchat app. It is a small, stateless program (`broker/worker.js`, running on Cloudflare Workers).

**What it does**
- At login, Snapchat sends it a one-time code. It exchanges that code, using the shared app's secret, for your refresh token.
- It immediately **seals** that token to a key that only your computer holds, and sends it to your own computer (an address starting with `http://127.0.0.1`, which is your machine). After that it cannot read it again.
- Later, your computer sends its refresh token to the service to get a short-lived access token, because that step needs the app's secret.

**What it does not do**
- It stores **no** tokens, no ad account data, no names, emails or IP addresses. It has no database and writes no logs of its own (a test checks the code uses no storage and no logging).
- It cannot read your ad account: your computer talks to Snapchat directly.
- It does not sell, share or analyze anything.

**Good to know**
- While a request is being handled the service holds your refresh token in memory, as it must. Its hosting provider (Cloudflare) may keep standard request metadata under its own terms.
- If you prefer, skip the shared login and use your own Snapchat OAuth app (see the README). You can also run your own copy of the service (`broker/README.md`).
- To stop access: revoke the app in Snapchat Business Manager and delete your settings file.

This is an unofficial project and is not affiliated with or endorsed by Snap Inc.
