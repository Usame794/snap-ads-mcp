#!/usr/bin/env node
// Refreshes the access token and makes read-only test calls. Prints only non-secret results.
import { loadEnv } from "../src/env.js";
import { SnapClient } from "../src/snap.js";

loadEnv();
const client = new SnapClient();
try {
  await client.accessToken();
  console.log("Token refresh: OK");
  const me = (await client.request("GET", "/me")).me ?? {};
  console.log(`GET /me: OK (${me.display_name ?? me.email ?? "authorized user"})`);
  const acct = process.env.SNAP_AD_ACCOUNT_ID;
  const data = await client.request("GET", `/adaccounts/${acct}`);
  const a = data.adaccounts?.[0]?.adaccount ?? {};
  console.log(`Ad account: OK (${a.name}, ${a.status}, ${a.currency})`);
} catch (e) {
  console.error("Check failed:", e.message);
  process.exit(1);
}
