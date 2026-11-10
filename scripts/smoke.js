#!/usr/bin/env node
// Quick live check: credentials, token refresh and the main read paths. Read-only. Exit code 1 if anything fails.
import { loadEnv } from "../src/env.js";
import { SnapClient } from "../src/snap.js";
import { listPixels, listSegments, targetingOptions } from "../src/readers.js";
import { shiftIso } from "../src/fatigue.js";

loadEnv();
const client = new SnapClient();
const acct = process.env.SNAP_AD_ACCOUNT_ID;
const end = (() => { const d = new Date(Date.now() + 3 * 3_600_000); return `${d.toISOString().slice(0, 10)}T00:00:00+03:00`; })();
const checks = [
  ["settings in .env", async () => { const miss = ["SNAP_CLIENT_ID", "SNAP_CLIENT_SECRET", "SNAP_REFRESH_TOKEN", "SNAP_AD_ACCOUNT_ID", "SNAP_PIXEL_ID", "SNAP_BRAND_PROFILE_ID"].filter((k) => !process.env[k]); if (miss.length) throw new Error("missing " + miss.join(", ")); return "all set"; }],
  ["token refresh", async () => { await client.accessToken(); return "ok"; }],
  ["who am I", async () => { const me = (await client.request("GET", "/me")).me; return `${me.display_name} (${me.member_status})`; }],
  ["ad account", async () => { const a = (await client.request("GET", `/adaccounts/${acct}`)).adaccounts[0].adaccount; return `${a.name}, ${a.status}, ${a.currency}`; }],
  ["campaigns", async () => `${(await client.request("GET", `/adaccounts/${acct}/campaigns`, { query: { limit: 5 } })).campaigns.length} read`],
  ["audiences", async () => `${(await listSegments(client, acct)).length} segments`],
  ["pixels", async () => `${(await listPixels(client, acct)).length} pixel(s)`],
  ["yesterday spend", async () => { const d = await client.request("GET", `/adaccounts/${acct}/stats`, { query: { granularity: "DAY", start_time: shiftIso(end, -86_400_000), end_time: end, fields: "spend" } }); const s = d.timeseries_stats?.[0]?.timeseries_stat?.timeseries?.[0]?.stats?.spend ?? 0; return `$${(s / 1e6).toFixed(2)}`; }],
  ["targeting lookup", async () => `${(await targetingOptions(client, { kind: "interests_lifestyle", country: "sa" })).length} interests`],
];
let failed = 0;
for (const [name, fn] of checks) {
  try {
    console.log(`PASS  ${name.padEnd(18)} ${await fn()}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name.padEnd(18)} ${e.message.slice(0, 160)}`);
  }
}
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
