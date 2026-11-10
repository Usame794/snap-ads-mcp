#!/usr/bin/env node
// Live check for snap_create_creative on ONE existing READY media asset.
// Usage: node scripts/live-create-creative.js <media_id> [--confirm]
// Without --confirm it only previews. A creative has no status and does not deliver until an ad uses it.
// There is no delete tool for creatives: remove the test one in Ads Manager afterwards.
import { loadEnv } from "../src/env.js";
import { SnapClient } from "../src/snap.js";
import { buildCreative, getMedia } from "../src/influencer.js";

loadEnv();
const [mediaId, flag] = process.argv.slice(2);
if (!mediaId) {
  console.error("Usage: node scripts/live-create-creative.js <media_id> [--confirm]");
  process.exit(2);
}
const confirm = flag === "--confirm";
const missing = ["SNAP_AD_ACCOUNT_ID", "SNAP_BRAND_PROFILE_ID"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Missing in .env: " + missing.join(", "));
  process.exit(2);
}

const client = new SnapClient();
const obj = buildCreative({
  adAccountId: process.env.SNAP_AD_ACCOUNT_ID,
  profileId: process.env.SNAP_BRAND_PROFILE_ID,
  mediaId,
  name: `TEST - creative check - ${new Date().toISOString().slice(0, 10)}`,
  headline: "Test headline",
  callToAction: "SHOP_NOW",
  url: "https://example.com/",
});

const media = await getMedia(client, mediaId);
console.log(`media ${mediaId}: ${media.media_status}`);
if (media.media_status !== "READY") {
  console.error("Media is not READY. Stopping.");
  process.exit(1);
}
if (!confirm) {
  console.log("PREVIEW only, nothing created. Would create:", JSON.stringify({ name: obj.name, headline: obj.headline, cta: obj.call_to_action, url: obj.web_view_properties.url }));
  console.log("Re-run with --confirm to create it.");
  process.exit(0);
}

const created = await client.createEntity("creative", obj);
console.log(`created creative ${created.id} (${created.name})`);
const back = await client.getEntity("creative", created.id);
const checks = [
  ["type", back.type === "WEB_VIEW"],
  ["headline", back.headline === obj.headline],
  ["call_to_action", back.call_to_action === obj.call_to_action],
  ["url", back.web_view_properties?.url === obj.web_view_properties.url],
  ["media", back.top_snap_media_id === mediaId],
];
let failed = 0;
for (const [k, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${k}`);
}
console.log(failed ? `${failed} read-back check(s) failed.` : "Read-back matches. Delete the test creative in Ads Manager.");
process.exit(failed ? 1 : 0);
