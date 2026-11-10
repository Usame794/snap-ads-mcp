#!/usr/bin/env node
// One-time helper: exchange the authorization code for a refresh token and save it to .env.
// Usage: CODE=<code> node scripts/get-refresh-token.js     (or pass the code as the first argument)
// Needs SNAP_CLIENT_ID, SNAP_CLIENT_SECRET and SNAP_REDIRECT_URI in .env. Prints nothing secret.
import { loadEnv, setEnvValue } from "../src/env.js";

loadEnv();
const code = process.argv[2] || process.env.CODE;
const { SNAP_CLIENT_ID, SNAP_CLIENT_SECRET, SNAP_REDIRECT_URI } = process.env;
const missing = Object.entries({ code, SNAP_CLIENT_ID, SNAP_CLIENT_SECRET, SNAP_REDIRECT_URI }).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing: ${missing.join(", ")}. Usage: CODE=<code> node scripts/get-refresh-token.js`);
  process.exit(1);
}
const res = await fetch("https://accounts.snapchat.com/login/oauth2/access_token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: SNAP_REDIRECT_URI,
    client_id: SNAP_CLIENT_ID,
    client_secret: SNAP_CLIENT_SECRET,
  }),
});
const data = await res.json().catch(() => ({}));
if (!res.ok || !data.refresh_token) {
  console.error(`Exchange failed (${res.status}): ${data.error_description || data.error || "no detail"}. The code may have expired; get a new one.`);
  process.exit(1);
}
setEnvValue("SNAP_REFRESH_TOKEN", data.refresh_token);
console.log(`Saved SNAP_REFRESH_TOKEN to .env (${data.refresh_token.length} chars).`);
