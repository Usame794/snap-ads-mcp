import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapClient, sanitizeForCreate, sanitizeForUpdate } from "../src/snap.js";
import { executeCopy, loadSource, planCopy } from "../src/copy.js";

const env = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };
const campaign = { id: "c1", name: "Src", ad_account_id: "acc", status: "ACTIVE", start_time: "2026-01-01T00:00:00Z", end_time: "2026-02-01T00:00:00Z", created_at: "x", updated_at: "y", delivery_status: ["VALID"] };
const squads = [
  { id: "s1", name: "A", campaign_id: "c1", type: "SNAP_ADS", status: "ACTIVE", daily_budget_micro: 100_000_000, targeting: { segments: [{ segment_id: ["x"], operation: "EXCLUDE" }] }, start_time: "2026-01-01T00:00:00Z", creation_state: "PUBLISHED" },
  { id: "s2", name: "B", campaign_id: "c1", type: "SNAP_ADS", status: "ACTIVE", daily_budget_micro: 50_000_000, targeting: {} },
];
const adsBySquad = { s1: [{ id: "a1", name: "ad1", ad_squad_id: "s1", creative_id: "cr1", type: "REMOTE_WEBPAGE", status: "ACTIVE" }], s2: [] };

test("plan: everything paused, budgets scaled, retimed, original untouched", () => {
  const plan = planCopy({ campaign, squads, adsBySquad, newName: "Copy", budgetScale: 0.5, now: "2026-10-26T12:00:00.000Z" });
  assert.equal(plan.campaign.status, "PAUSED");
  assert.equal(plan.campaign.end_time, undefined);
  assert.equal(plan.campaign.start_time, "2026-10-26T12:00:00.000Z");
  assert.deepEqual(plan.squads.map((s) => s.obj.daily_budget_micro), [50_000_000, 25_000_000]);
  assert.ok(plan.squads.every((s) => s.obj.status === "PAUSED" && s.ads.every((a) => a.status === "PAUSED")));
  assert.equal(plan.summary.total_daily_budget_if_enabled, 75);
  assert.equal(plan.summary.total_ads, 1);
  assert.equal(squads[0].status, "ACTIVE");
  assert.deepEqual(plan.squads[0].obj.targeting.segments, squads[0].targeting.segments);
});

test("plan: input checks", () => {
  assert.throws(() => planCopy({ campaign, squads, adsBySquad, newName: " " }), /new_name/);
  assert.throws(() => planCopy({ campaign, squads, adsBySquad, newName: "x", budgetScale: 3 }), /budget_scale/);
  assert.equal(planCopy({ campaign, squads, adsBySquad, newName: "x", includeAds: false }).summary.total_ads, 0);
});

test("sanitizeForCreate keeps render_type (needed to match the creative)", () => {
  assert.equal(sanitizeForCreate({ id: "a", render_type: "DYNAMIC", created_at: "x" }).render_type, "DYNAMIC");
  assert.equal("render_type" in sanitizeForUpdate({ render_type: "DYNAMIC" }), false);
  assert.equal(sanitizeForCreate({ product_properties: { catalog_vertical: "COMMERCE", product_set_id: "p" } }).product_properties.catalog_vertical, undefined);
});

test("sanitizeForCreate drops ids and read-only fields", () => {
  const o = sanitizeForCreate(squads[0]);
  for (const f of ["id", "creation_state", "created_at"]) assert.equal(f in o, false);
  assert.equal(o.name, "A");
});

function fakeApi() {
  const posts = [];
  let n = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const json = (b, status = 200) => ({ ok: status < 300, status, json: async () => b });
    if (u.includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    if (opts.method === "POST") {
      const body = JSON.parse(opts.body);
      const key = Object.keys(body)[0];
      posts.push({ url: u, key, obj: body[key][0] });
      if (posts.length === 4 && fakeApi.failOn4) return json({ request_status: "ERROR", debug_message: "boom" }, 400);
      const single = key.slice(0, -1);
      return json({ request_status: "SUCCESS", [key]: [{ sub_request_status: "SUCCESS", [single]: { ...body[key][0], id: `new${++n}` } }] });
    }
    if (u.endsWith("/campaigns/c1")) return json({ campaigns: [{ sub_request_status: "SUCCESS", campaign }] });
    if (u.includes("/campaigns/c1/adsquads")) return json({ adsquads: squads.map((s) => ({ sub_request_status: "SUCCESS", adsquad: s })) });
    const m = u.match(/adsquads\/(s\d)\/ads/);
    if (m) return json({ ads: adsBySquad[m[1]].map((a) => ({ sub_request_status: "SUCCESS", ad: a })) });
    return json({}, 404);
  };
  return { posts, client: new SnapClient({ env, fetchImpl }) };
}

test("execute: creates campaign, squads, ads in order with new parent ids", async () => {
  fakeApi.failOn4 = false;
  const { posts, client } = fakeApi();
  const src = await loadSource(client, "c1");
  const plan = planCopy({ ...src, newName: "Copy" });
  const created = await executeCopy({ client, plan, sourceCampaignId: "c1", logFile: join(mkdtempSync(join(tmpdir(), "c-")), "l.jsonl") });
  assert.deepEqual(posts.map((p) => p.key), ["campaigns", "adsquads", "ads", "adsquads"]);
  assert.match(posts[1].url, /\/campaigns\/new1\/adsquads$/);
  assert.equal(posts[1].obj.campaign_id, "new1");
  assert.match(posts[2].url, /\/adsquads\/new2\/ads$/);
  assert.equal(posts[2].obj.creative_id, "cr1");
  assert.ok(posts.every((p) => p.obj.status === "PAUSED" && !("id" in p.obj)));
  assert.equal(created.adsquads.length, 2);
  assert.equal(created.ads, 1);
});

test("execute: on failure reports what was already created and stops", async () => {
  fakeApi.failOn4 = true;
  const { posts, client } = fakeApi();
  const src = await loadSource(client, "c1");
  const plan = planCopy({ ...src, newName: "Copy" });
  await assert.rejects(
    () => executeCopy({ client, plan, sourceCampaignId: "c1", logFile: join(mkdtempSync(join(tmpdir(), "c-")), "l.jsonl") }),
    (e) => /boom/.test(e.message) && /Already created/.test(e.message) && e.created.adsquads.length === 1,
  );
  assert.equal(posts.length, 4);
  fakeApi.failOn4 = false;
});
