import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapClient } from "../src/snap.js";
import { compareReport, judgeSquad, pixelHealth, reviewIssues } from "../src/audit.js";

const env = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };
const th = { maxFrequency: 5, minSwipeRatePct: 0.15, minSpend: 100, minRoas: 3 };
const camp = { status: "ACTIVE", name: "C" };
const clean = { status: "ACTIVE", targeting: { segments: [{ segment_id: ["b"], operation: "EXCLUDE" }] } };

test("judge: flags missing exclusion, frequency, view-through, ROAS, no purchases, paused parent", () => {
  const codes = (squad, campaign, row) => judgeSquad({ squad, campaign, row, thresholds: th }).map((i) => i.code);
  assert.deepEqual(codes(clean, camp, { spend: 500, frequency: 2, swipe_rate_pct: 1, roas: 6, purchases: 20 }), []);
  const spent = { spend: 50, frequency: 1, swipe_rate_pct: 1, roas: 5, purchases: 5 };
  assert.deepEqual(codes({ status: "ACTIVE", targeting: {} }, camp, spent), ["NO_BUYER_EXCLUSION"]);
  assert.deepEqual(codes({ status: "ACTIVE", targeting: { product_audiences: [{ x: 1 }] } }, camp, spent), []);
  assert.deepEqual(codes({ status: "ACTIVE", targeting: {} }, camp, null), [], "idle squads are not flagged");
  assert.deepEqual(codes(clean, camp, { spend: 500, frequency: 6, swipe_rate_pct: 0.05, roas: 1.5, purchases: 3 }), ["HIGH_FREQUENCY", "LOW_SWIPE_RATE", "LOW_ROAS"]);
  assert.deepEqual(codes(clean, camp, { spend: 150, frequency: 1, swipe_rate_pct: 1, roas: 0, purchases: 0 }), ["LOW_ROAS", "SPEND_NO_PURCHASES"]);
  assert.deepEqual(codes(clean, camp, { spend: 20, frequency: 1, swipe_rate_pct: 0.01, roas: 0, purchases: 0 }), [], "small spend is not judged");
  assert.deepEqual(codes(clean, { status: "PAUSED", name: "P" }, null), ["PARENT_NOT_ACTIVE"]);
});

function api(routes) {
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (String(url).includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    const hit = routes[u.pathname.replace(/^\/v1/, "")];
    return hit ? json(typeof hit === "function" ? hit(u) : hit) : json({}, 404);
  };
  return new SnapClient({ env, fetchImpl });
}

test("review issues: only non-approved ads under ACTIVE squads, with reasons", async () => {
  const client = api({
    "/adaccounts/a/ads": { ads: [
      { ad: { id: "1", name: "ok", ad_squad_id: "s1", review_status: "APPROVED" } },
      { ad: { id: "2", name: "bad", ad_squad_id: "s1", status: "ACTIVE", review_status: "REJECTED", review_status_reasons: ["logo blank"] } },
      { ad: { id: "3", name: "bad2", ad_squad_id: "s2", review_status: "REJECTED", review_status_reasons: ["x"] } },
    ] },
    "/adsquads/s1": { adsquads: [{ sub_request_status: "SUCCESS", adsquad: { id: "s1", name: "Live", status: "ACTIVE" } }] },
    "/adsquads/s2": { adsquads: [{ sub_request_status: "SUCCESS", adsquad: { id: "s2", name: "Off", status: "PAUSED" } }] },
  });
  const r = await reviewIssues(client, { adAccountId: "a" });
  assert.equal(r.scanned_non_approved, 2);
  assert.deepEqual(r.items.map((i) => i.ad_id), ["2"]);
  assert.deepEqual(r.items[0].reasons, ["logo blank"]);
  assert.equal((await reviewIssues(client, { adAccountId: "a", onlyActive: false })).items.length, 2);
});

test("pixel health: summarises readiness and lists P1 issues", async () => {
  const client = api({
    "/pixels/p/signal_readiness_scores": { signal_readiness_score: [{ signal_readiness_score: { readiness_status: "GOOD", event_source: "API", use_case: { gbb_use_case: "PIXEL_PURCHASE", is_spending: true } } }] },
    "/pixels/p/event_quality_scores": { event_quality_scores: [{ event_quality_score: { event_type: "SIGN_UP", event_source: "SDK", recommendations: [{ priority: "P2", score: "BAD", title: "Low phone", description: "line1\nline2" }, { priority: "P1", score: "BAD", title: "Volume", description: "few events" }] } }] },
  });
  const h = await pixelHealth(client, "p");
  assert.equal(h.spending_use_cases.length, 1);
  assert.deepEqual(h.top_priority_issues, ["SIGN_UP/SDK: Volume"]);
  assert.equal(h.events[0].recommendations[0].priority, "P1");
  assert.equal(h.events[0].recommendations[1].detail, "line1");
});

test("compare: percentage and absolute changes, per child matched by id", async () => {
  const stat = (spend, p, v) => ({ spend: spend * 1e6, conversion_purchases: p, conversion_purchases_value: v * 1e6, impressions: 1000, swipes: 10, frequency: 2 });
  const client = api({
    "/campaigns/c/stats": (u) => ({ total_stats: [{ total_stat: { breakdown_stats: { adsquad: u.searchParams.get("start_time").startsWith("2026-10-20") ? [{ id: "s1", stats: stat(200, 20, 1200) }] : [{ id: "s1", stats: stat(100, 5, 300) }] } } }] }),
    "/campaigns/c/adsquads": { adsquads: [{ sub_request_status: "SUCCESS", adsquad: { id: "s1", name: "Squad" } }] },
  });
  const r = await compareReport(client, { entity: "campaign", id: "c", breakdown: "adsquad", current: { start_time: "2026-10-20T00:00:00+03:00", end_time: "2026-10-27T00:00:00+03:00" }, previous: { start_time: "2026-10-13T00:00:00+03:00", end_time: "2026-10-20T00:00:00+03:00" } });
  const row = r.rows[0];
  assert.equal(row.spend.change_pct, 100);
  assert.equal(row.purchases.change_pct, 300);
  assert.deepEqual([row.roas.now, row.roas.before, row.roas.change], [6, 3, 3]);
  assert.deepEqual([row.cpa.now, row.cpa.before], [10, 20]);
});
