import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapClient } from "../src/snap.js";
import { buildAd, buildCreative, claimAdCode, runInfluencerFlow, validateAdCode, waitForMedia } from "../src/influencer.js";

const CODE = "adcode_00000000-0000-4000-8000-000000000000";
const env = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };

test("ad code validation accepts adcode_<uuid> only", () => {
  assert.equal(validateAdCode(`  ${CODE} `), CODE);
  assert.throws(() => validateAdCode("#lW0uxwIzrscTRHOyJERM/VNULSPhzPynn1vubTYL3IJ2vSPb"), /adcode_/);
  assert.throws(() => validateAdCode("adcode-Q9jTBBfHRbE8EJm9"), /adcode_/);
  assert.throws(() => validateAdCode(""), /adcode_/);
});

test("creative builder checks headline length, https url, cta", () => {
  const ok = { adAccountId: "a", profileId: "p", mediaId: "m", name: "n", headline: "hello", url: "https://example.com/shop" };
  const c = buildCreative(ok);
  assert.equal(c.type, "WEB_VIEW");
  assert.equal(c.top_snap_media_id, "m");
  assert.equal(c.profile_properties.profile_id, "p");
  assert.throws(() => buildCreative({ ...ok, headline: "x".repeat(35) }), /34/);
  assert.throws(() => buildCreative({ ...ok, url: "http://x.com" }), /https/);
  assert.throws(() => buildCreative({ ...ok, callToAction: "NOPE" }), /call_to_action/);
  assert.throws(() => buildCreative({ ...ok, name: " " }), /name/);
});

test("ad builder is always PAUSED", () => {
  const a = buildAd({ adSquadId: "s", creativeId: "c", name: "n" });
  assert.equal(a.status, "PAUSED");
  assert.equal(a.type, "REMOTE_WEBPAGE");
});

function fake({ mediaStatuses = ["READY"], claimStatus = 200, failCreative = false } = {}) {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (u.includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ m: opts.method ?? "GET", u, body });
    if (u.includes("claim_media_by_ad_code")) {
      return claimStatus === 200 ? json({ request_status: "SUCCESS", media_entity_id: "media1" }) : json({ request_status: "ERROR", debug_message: "code expired" }, claimStatus);
    }
    if (u.includes("/media/")) return json({ media: [{ sub_request_status: "SUCCESS", media: { id: "media1", media_status: mediaStatuses[Math.min(polls++, mediaStatuses.length - 1)], type: "VIDEO" } }] });
    if (u.endsWith("/creatives")) {
      if (failCreative) return json({ request_status: "ERROR", debug_message: "bad creative" }, 400);
      return json({ request_status: "SUCCESS", creatives: [{ sub_request_status: "SUCCESS", creative: { ...body.creatives[0], id: "cr1" } }] });
    }
    if (u.endsWith("/ads")) return json({ request_status: "SUCCESS", ads: [{ sub_request_status: "SUCCESS", ad: { ...body.ads[0], id: "ad1" } }] });
    return json({}, 404);
  };
  return { calls, client: new SnapClient({ env, fetchImpl }) };
}
const lf = () => join(mkdtempSync(join(tmpdir(), "i-")), "l.jsonl");
const flowArgs = (client) => ({ client, adAccountId: "acc", profileId: "prof", adCode: CODE, adSquadId: "sq", name: "Paid - h - TEST", headline: "hi there", url: "https://example.com/shop", logFile: lf(), sleep: async () => {} });

test("claim sends ad_code and profile_id as query parameters", async () => {
  const { calls, client } = fake();
  assert.equal(await claimAdCode(client, { adAccountId: "acc", adCode: CODE, profileId: "prof" }), "media1");
  const u = new URL(calls[0].u);
  assert.match(u.pathname, /\/adaccounts\/acc\/claim_media_by_ad_code$/);
  assert.equal(u.searchParams.get("ad_code"), CODE);
  assert.equal(u.searchParams.get("profile_id"), "prof");
  assert.equal(calls[0].body, null);
});

test("claim failure surfaces Snap's message and nothing else is called", async () => {
  const { calls, client } = fake({ claimStatus: 404 });
  await assert.rejects(() => runInfluencerFlow(flowArgs(client)), /code expired/);
  assert.equal(calls.length, 1);
});

test("flow waits for READY, then creates creative and a PAUSED ad", async () => {
  const { calls, client } = fake({ mediaStatuses: ["PENDING_UPLOAD", "PENDING_UPLOAD", "READY"] });
  const done = await runInfluencerFlow(flowArgs(client));
  assert.deepEqual(done, { media_id: "media1", creative_id: "cr1", ad_id: "ad1" });
  const ad = calls.find((c) => c.u.endsWith("/ads")).body.ads[0];
  assert.equal(ad.status, "PAUSED");
  assert.equal(ad.creative_id, "cr1");
  assert.equal(calls.filter((c) => c.u.includes("/media/")).length, 3);
});

test("flow reports progress when the creative step fails (code already claimed)", async () => {
  const { client } = fake({ failCreative: true });
  await assert.rejects(() => runInfluencerFlow(flowArgs(client)), (e) => /bad creative/.test(e.message) && e.done.media_id === "media1" && !e.done.creative_id);
});

test("media ERROR and timeout are reported clearly", async () => {
  const a = fake({ mediaStatuses: ["ERROR"] });
  await assert.rejects(() => waitForMedia(a.client, "media1", { sleep: async () => {} }), /new ad code/);
  const b = fake({ mediaStatuses: ["PENDING_UPLOAD"] });
  await assert.rejects(() => waitForMedia(b.client, "media1", { timeoutMs: -1, sleep: async () => {} }), /still PENDING_UPLOAD/);
});
