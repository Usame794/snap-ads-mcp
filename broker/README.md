# Login service (optional)

A small, **stateless** Cloudflare Worker that lets people connect their Snapchat ad account with a normal "log in with Snapchat" click, without creating their own Snapchat OAuth app. It holds one shared app's secret and nothing else: no tokens, no accounts, no logs. See `../PRIVACY.md`.

You only need this folder if you want to **run the login service** (the maintainer does this once, for everyone). Normal users never touch it.

## How it works
1. `npx ads-mcp-for-snapchat setup` (or the Claude Desktop extension) makes a one-time key pair on the user's computer and opens `https://<service>/login?port=...&pk=<public key>&nonce=...`.
2. The service sends the browser to Snapchat's login with a **signed** state (no storage needed) and a cookie that ties the login to that browser.
3. Snapchat sends the browser back to `/callback`. The service checks the signature, expiry and cookie, exchanges the code (using the secret) for a refresh token, **seals it to the user's public key**, and redirects the browser to `http://127.0.0.1:<port>/callback` on the user's own machine. The service keeps nothing.
4. Later the computer sends its refresh token to `POST /v1/refresh` to get a 30-minute access token, because that needs the secret.

## Deploy (about 20 minutes)
You need a free Cloudflare account and a Snapchat Business Manager login.

1. Install the tool and sign in: `npm install -g wrangler`, then `wrangler login`.
2. Deploy once to learn the address: `cd broker && wrangler deploy`. It prints something like `https://ads-mcp-for-snapchat-login.<you>.workers.dev`. (Or attach your own domain in the Cloudflare dashboard.)
3. In Snap Business Manager open **Business Details > OAuth Apps > + OAuth App**. Name it "Ads MCP for Snapchat". Set the **Redirect URI** to `https://<your address>/callback` exactly. Copy the Client ID and Client Secret.
4. Store the three secrets (they are never put in files):
   ```
   wrangler secret put SNAP_CLIENT_ID
   wrangler secret put SNAP_CLIENT_SECRET
   wrangler secret put STATE_KEY
   ```
   For `STATE_KEY` paste any random text of 32+ characters, for example the output of `openssl rand -base64 48`.
5. Check it: open `https://<your address>/` (a short home page) and `/privacy`. Then on your own computer run:
   ```
   SNAP_BROKER_URL=https://<your address> npx -y ads-mcp-for-snapchat setup
   ```
   Choose option 1 (shared login). It should open Snapchat's login, then say Connected.
6. Make it the default for everyone: put the address in `package.json` as `"adsMcpBroker": "https://<your address>"`, then release a new version.

## Before you tell other people about it
- **Ask Snap** whether an OAuth app may connect advertisers other than your own company, and whether the app needs review. Snap's rules decide this, not this code. Give them the privacy page address.
- **Add rate limits** in the Cloudflare dashboard (Security > WAF > Rate limiting): for example 30 requests per minute per IP for `/login` and `/v1/refresh`.
- **Know what you are running.** The service briefly holds each user's refresh token in memory while it handles a request. If its secrets leak, an attacker could use the shared app, so keep them in Cloudflare secrets only and rotate them if in doubt.
- If the service is down, shared-login users cannot renew their 30-minute access tokens until it is back. People with their own app are unaffected.

## Run your own copy
The same code works with your own Snapchat app: deploy it as above and give your users `SNAP_BROKER_URL=https://<your address>`. Only point `SNAP_BROKER_URL` at a service you trust: a refresh token is sent there.

## What is tested
`npm test` runs the real Worker code against a fake Snapchat: the state signature (tampered, expired, other key, other browser), the loopback-only redirect, sealing (only the user's key opens it), that no plaintext token or secret is ever in a redirect or an error, that nothing is logged or stored, and the whole login end to end. The Worker was also run in Cloudflare's own local runtime (`wrangler dev`): a token sealed there opens on a computer running Node, and forged or invalid requests are refused. It has **not** been run against the real Snapchat login: do step 5 above before announcing it.
