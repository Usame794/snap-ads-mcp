import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapClient } from "../src/snap.js";
import { buildAdSquad, buildCampaign, CHUNK_BYTES, createAdSquad, createCampaign, inspectMediaFile, MAX_UPLOAD_BYTES, uploadMedia } from "../src/create.js";

const env = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };
const tmp = () => mkdtempSync(join(tmpdir(), "cr-"));

test("campaign builder: paused, validated, retimed", () => {
  const c = buildCampaign({ adAccountId: "acc", name: " My Test ", objective: "TRAFFIC", now: "2026-10-26T12:00:00.000Z" });
  assert.equal(c.status, "PAUSED");
  assert.equal(c.name, "My Test");
  assert.equal(c.objective_v2_properties.objective_v2_type, "TRAFFIC");
  assert.equal(c.start_time, "2026-10-26T12:00:00.000Z");
  assert.throws(() => buildCampaign({ adAccountId: "a", name: "ab" }), /3 characters/);
  assert.throws(() => buildCampaign({ adAccountId: "a", name: "abc", objective: "NOPE" }), /objective/);
});

test("media file inspection: type, size and missing/empty/oversize files", () => {
  const dir = tmp();
  const ok = join(dir, "clip.MP4");
  writeFileSync(ok, Buffer.alloc(1000));
  assert.deepEqual(inspectMediaFile(ok), { type: "VIDEO", size: 1000, fileName: "clip.MP4" });
  assert.equal(inspectMediaFile((() => { const p = join(dir, "a.png"); writeFileSync(p, "x"); return p; })()).type, "IMAGE");
  assert.throws(() => inspectMediaFile(join(dir, "doc.pdf")), /Unsupported/);
  assert.throws(() => inspectMediaFile(join(dir, "missing.mp4")), /not found/);
  const empty = join(dir, "e.mp4");
  writeFileSync(empty, "");
  assert.throws(() => inspectMediaFile(empty), /empty/);
  assert.throws(() => inspectMediaFile("big.mp4", () => ({ size: MAX_UPLOAD_BYTES + 1 })), /1 GB/);
  assert.equal(inspectMediaFile("big.mp4", () => ({ size: 100 * 1024 * 1024 })).size, 100 * 1024 * 1024);
});

function fake(failUpload = false) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (u.includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    calls.push({ u, method: opts.method, isForm: opts.body instanceof FormData, hasAuth: Boolean(opts.headers?.Authorization), json: typeof opts.body === "string" ? JSON.parse(opts.body) : null });
    if (u.endsWith("/media") && opts.method === "POST") {
      const o = JSON.parse(opts.body).media[0];
      return json({ request_status: "SUCCESS", media: [{ sub_request_status: "SUCCESS", media: { ...o, id: "m1" } }] });
    }
    if (u.endsWith("/media/m1/upload")) return failUpload ? json({ request_status: "ERROR", debug_message: "bad file" }, 400) : json({ request_status: "SUCCESS" });
    if (u.endsWith("/campaigns")) {
      const o = JSON.parse(opts.body).campaigns[0];
      return json({ request_status: "SUCCESS", campaigns: [{ sub_request_status: "SUCCESS", campaign: { ...o, id: "c1" } }] });
    }
    return json({}, 404);
  };
  return { calls, client: new SnapClient({ env, fetchImpl }) };
}
const lf = () => join(tmp(), "l.jsonl");

test("upload: creates the media entity, then sends the file as multipart", async () => {
  const f = join(tmp(), "v.mp4");
  writeFileSync(f, Buffer.alloc(2048));
  const { calls, client } = fake();
  const r = await uploadMedia({ client, adAccountId: "acc", filePath: f, name: "Test clip", logFile: lf() });
  assert.deepEqual(r, { media_id: "m1", type: "VIDEO", bytes: 2048, parts: 1 });
  assert.match(calls[0].u, /\/adaccounts\/acc\/media$/);
  assert.deepEqual(calls[0].json.media[0], { ad_account_id: "acc", name: "Test clip", type: "VIDEO" });
  assert.equal(calls[1].isForm, true);
  assert.equal(calls[1].hasAuth, true);
});

test("upload failure names the created media entity", async () => {
  const f = join(tmp(), "v.mp4");
  writeFileSync(f, Buffer.alloc(10));
  const { client } = fake(true);
  await assert.rejects(() => uploadMedia({ client, adAccountId: "a", filePath: f, logFile: lf() }), /bad file.*m1/s);
});

test("campaign creation posts a paused campaign to the ad account", async () => {
  const { calls, client } = fake();
  const created = await createCampaign({ client, campaign: buildCampaign({ adAccountId: "acc", name: "Camp test" }), logFile: lf() });
  assert.equal(created.id, "c1");
  assert.match(calls[0].u, /\/adaccounts\/acc\/campaigns$/);
  assert.equal(calls[0].json.campaigns[0].status, "PAUSED");
});

test("chunked upload: INIT, one ADD per chunk (absolute paths), then FINALIZE", async () => {
  const f = join(tmp(), "big.mp4");
  writeFileSync(f, "");
  truncateSync(f, CHUNK_BYTES * 2 + 5); // sparse file: 3 parts
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (u.includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    const fields = opts.body instanceof FormData ? Object.fromEntries([...opts.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"])) : null;
    calls.push({ u, fields, json: typeof opts.body === "string" ? JSON.parse(opts.body) : null });
    if (u.endsWith("/media") ) return json({ request_status: "SUCCESS", media: [{ sub_request_status: "SUCCESS", media: { id: "m1" } }] });
    if (u.includes("action=INIT")) return json({ request_status: "SUCCESS", upload_id: "up1", add_path: "/us/v1/media/m1/multipart-upload-v2?action=ADD", finalize_path: "/v1/media/m1/multipart-upload-v2?action=FINALIZE" });
    return json({ request_status: "SUCCESS" });
  };
  const client = new SnapClient({ env, fetchImpl });
  const r = await uploadMedia({ client, adAccountId: "acc", filePath: f, logFile: lf() });
  assert.equal(r.parts, 3);
  const init = calls.find((c) => c.u.includes("action=INIT"));
  assert.equal(init.fields.number_of_parts, "3");
  assert.equal(init.fields.file_size, String(CHUNK_BYTES * 2 + 5));
  const adds = calls.filter((c) => c.u.includes("action=ADD"));
  assert.equal(adds.length, 3);
  assert.ok(adds.every((c) => c.u.startsWith("https://adsapi.snapchat.com/us/v1/media/m1/")));
  assert.deepEqual(adds.map((c) => c.fields.part_number), ["1", "2", "3"]);
  assert.ok(adds.every((c) => c.fields.upload_id === "up1" && c.fields.file === "<file>"));
  const fin = calls.at(-1);
  assert.match(fin.u, /^https:\/\/adsapi\.snapchat\.com\/v1\/media\/m1\/multipart-upload-v2\?action=FINALIZE$/);
  assert.equal(fin.fields.upload_id, "up1");
});

test("ad squad builder: paused, purchase goal, max bid, validated", () => {
  const ok = { campaignId: "c", name: "Squad test", dailyBudget: 20, bid: 12.5, pixelId: "px", now: "2026-10-26T12:00:00.000Z" };
  const s = buildAdSquad(ok);
  assert.equal(s.status, "PAUSED");
  assert.equal(s.bid_micro, 12_500_000);
  assert.equal(s.daily_budget_micro, 20_000_000);
  assert.equal(s.optimization_goal, "PIXEL_PURCHASE");
  assert.deepEqual(s.targeting.geos, [{ country_code: "sa" }]);
  assert.equal(s.targeting.demographics, undefined);
  assert.deepEqual(buildAdSquad({ ...ok, minAge: 20, gender: "FEMALE" }).targeting.demographics, [{ operation: "INCLUDE", min_age: "20", gender: "FEMALE" }]);
  assert.throws(() => buildAdSquad({ ...ok, dailyBudget: 3 }), /at least 5/);
  assert.throws(() => buildAdSquad({ ...ok, bid: 0 }), /bid/);
  assert.throws(() => buildAdSquad({ ...ok, pixelId: "" }), /pixel_id/);
  assert.throws(() => buildAdSquad({ ...ok, countries: ["saudi"] }), /2-letter/);
  assert.throws(() => buildAdSquad({ ...ok, conversionWindow: "NOPE" }), /conversion_window/);
});

test("ad squad creation posts to the campaign's adsquads endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (String(url).includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    calls.push({ u: String(url), body: JSON.parse(opts.body) });
    const o = calls.at(-1).body.adsquads[0];
    return json({ request_status: "SUCCESS", adsquads: [{ sub_request_status: "SUCCESS", adsquad: { ...o, id: "sq1" } }] });
  };
  const client = new SnapClient({ env, fetchImpl });
  const made = await createAdSquad({ client, adsquad: buildAdSquad({ campaignId: "c9", name: "Squad test", dailyBudget: 10, bid: 1, pixelId: "px" }), logFile: lf() });
  assert.equal(made.id, "sq1");
  assert.match(calls[0].u, /\/campaigns\/c9\/adsquads$/);
  assert.equal("id" in calls[0].body.adsquads[0], false);
});
