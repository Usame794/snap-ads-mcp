import { test } from "node:test";
import assert from "node:assert/strict";
import { planTargeting } from "../src/changes.js";
import { buildAdSquad } from "../src/create.js";
import { dailyReport, dimensionReport } from "../src/report.js";
import { SnapClient } from "../src/snap.js";

const env = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };
const cur = { targeting: { geos: [{ country_code: "sa" }], segments: [{ segment_id: ["b1", "b2"], operation: "EXCLUDE" }, { segment_id: ["i1"], operation: "INCLUDE" }], interests: [{ category_id: ["SLC_1"], operation: "INCLUDE" }], devices: [{ os_type: "iOS", operation: "INCLUDE" }], auto_expansion_options: { x: 1 } } };

test("targeting: interests, devices and clearing them", () => {
  const a = planTargeting(cur, { interests: ["SLC_11", "SHP_3"], osType: "ANDROID" });
  assert.deepEqual(a.patch.targeting.interests, [{ category_id: ["SLC_11", "SHP_3"], operation: "INCLUDE" }]);
  assert.deepEqual(a.patch.targeting.devices, [{ os_type: "ANDROID", operation: "INCLUDE" }]);
  assert.deepEqual(a.patch.targeting.auto_expansion_options, { x: 1 });
  const b = planTargeting(cur, { clearInterests: true, clearDevices: true });
  assert.equal(b.patch.targeting.interests, undefined);
  assert.equal(b.patch.targeting.devices, undefined);
  assert.throws(() => planTargeting(cur, { interests: ["bad id"] }), /SLC_11/);
  assert.throws(() => planTargeting(cur, { osType: "WINDOWS" }), /os_type/);
  assert.throws(() => planTargeting(cur, { interests: ["SLC_1"], clearInterests: true }), /either interests/);
  assert.equal(cur.targeting.interests[0].category_id[0], "SLC_1");
});

test("targeting: include segments and remove exclusions", () => {
  const inc = planTargeting(cur, { includeSegments: ["i1", "i2"] });
  assert.deepEqual(inc.patch.targeting.segments.at(-1), { segment_id: ["i2"], operation: "INCLUDE" });
  assert.throws(() => planTargeting(cur, { includeSegments: ["i1"] }), /already included/);
  const rm = planTargeting(cur, { removeExclusions: ["b1"] });
  assert.deepEqual(rm.patch.targeting.segments.find((s) => s.operation === "EXCLUDE").segment_id, ["b2"]);
  const all = planTargeting(cur, { removeExclusions: ["b1", "b2"] });
  assert.equal(all.patch.targeting.segments.some((s) => s.operation === "EXCLUDE"), false);
  assert.equal(all.patch.targeting.segments.length, 1);
  assert.throws(() => planTargeting(cur, { removeExclusions: ["zzz"] }), /None of those/);
  assert.equal(cur.targeting.segments[0].segment_id.length, 2);
});

test("ad squad builder: exclusions, interests, device, auto-bid", () => {
  const ok = { campaignId: "c", name: "Squad X", dailyBudget: 10, pixelId: "px", bid: 2 };
  const s = buildAdSquad({ ...ok, excludeSegmentIds: ["b1"], includeSegmentIds: ["i1"], interests: ["SLC_11"], osType: "iOS" });
  assert.deepEqual(s.targeting.segments, [{ segment_id: ["i1"], operation: "INCLUDE" }, { segment_id: ["b1"], operation: "EXCLUDE" }]);
  assert.deepEqual(s.targeting.interests, [{ category_id: ["SLC_11"], operation: "INCLUDE" }]);
  assert.deepEqual(s.targeting.devices, [{ os_type: "iOS", operation: "INCLUDE" }]);
  assert.equal(s.bid_micro, 2_000_000);
  const auto = buildAdSquad({ ...ok, bid: undefined, bidStrategy: "AUTO_BID" });
  assert.equal(auto.bid_strategy, "AUTO_BID");
  assert.equal("bid_micro" in auto, false);
  assert.throws(() => buildAdSquad({ ...ok, bid: undefined }), /bid must be/);
  assert.throws(() => buildAdSquad({ ...ok, bidStrategy: "TARGET_COST" }), /bid_strategy/);
  assert.throws(() => buildAdSquad({ ...ok, osType: "WINDOWS" }), /os_type/);
  assert.throws(() => buildAdSquad({ ...ok, interests: ["nope"] }), /SLC_11/);
});

function api(handler) {
  const calls = [];
  const fetchImpl = async (url) => {
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (String(url).includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    const u = new URL(String(url));
    calls.push(Object.fromEntries(u.searchParams));
    return json(handler(u));
  };
  return { calls, client: new SnapClient({ env, fetchImpl }) };
}

test("daily report: one row per day with ROAS/CPA, limited to 31 days", async () => {
  const { calls, client } = api(() => ({ timeseries_stats: [{ timeseries_stat: { timeseries: [
    { start_time: "2026-10-20T00:00:00.000+03:00", stats: { spend: 100_000_000, conversion_purchases: 10, conversion_purchases_value: 600_000_000, impressions: 1000, swipes: 10 } },
    { start_time: "2026-10-21T00:00:00.000+03:00", stats: { spend: 50_000_000, conversion_purchases: 0, conversion_purchases_value: 0, impressions: 500, swipes: 5 } },
  ] } }] }));
  const r = await dailyReport(client, { entity: "campaign", id: "c", start_time: "2026-10-20T00:00:00+03:00", end_time: "2026-10-22T00:00:00+03:00" });
  assert.equal(calls[0].granularity, "DAY");
  assert.deepEqual(r.rows.map((x) => [x.date, x.spend, x.roas, x.cpa]), [["2026-10-20", 100, 6, 10], ["2026-10-21", 50, 0, null]]);
  await assert.rejects(() => dailyReport(client, { entity: "campaign", id: "c", start_time: "2026-09-01T00:00:00+03:00", end_time: "2026-10-22T00:00:00+03:00" }), /31 days/);
  await assert.rejects(() => dailyReport(client, { entity: "nope", id: "c", start_time: "a", end_time: "b" }), /entity/);
});

test("audience report: uses report_dimension, maps age_bucket, sorts by spend", async () => {
  const { calls, client } = api(() => ({ total_stats: [{ total_stat: { dimension_stats: [
    { age_bucket: "18-20", spend: 10_000_000, conversion_purchases: 1, conversion_purchases_value: 50_000_000, impressions: 100, swipes: 1 },
    { age_bucket: "21-24", spend: 90_000_000, conversion_purchases: 9, conversion_purchases_value: 450_000_000, impressions: 900, swipes: 9 },
  ] } }] }));
  const r = await dimensionReport(client, { entity: "adsquad", id: "s", start_time: "2026-10-20T00:00:00+03:00", end_time: "2026-10-26T00:00:00+03:00", dimension: "age" });
  assert.equal(calls[0].report_dimension, "age");
  assert.deepEqual(r.rows.map((x) => x.age), ["21-24", "18-20"]);
  assert.equal(r.rows[0].roas, 5);
  await assert.rejects(() => dimensionReport(client, { entity: "adsquad", id: "s", start_time: "a", end_time: "b", dimension: "operating_system" }), /dimension must be/);
});
