// Hourly report, creative comparison and budget advice (all read-only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetAdvice, classifyAds, creativeCompare, hourlyReport, suggestMoves, summarizeHours } from "../src/advice.js";
import { loadPolicy } from "../src/policy.js";

const policy = loadPolicy({ SNAP_MIN_DAILY_BUDGET: "5", SNAP_MAX_DAILY_BUDGET: "300", SNAP_MAX_BID: "20", SNAP_MAX_BUDGET_INCREASE_PCT: "30" });
const hour = (iso, spend, purchases, value, impressions = 1000) => ({ start_time: iso, stats: { spend: spend * 1e6, conversion_purchases: purchases, conversion_purchases_value: value * 1e6, impressions } });

test("hourly report: local hours, dayparts, best and worst hours", () => {
  // +03:00: 15:00Z is 18:00 local, 16:00Z is 19:00 local, 21:00Z is 00:00 local the next day
  const series = [
    hour("2026-11-10T15:00:00Z", 50, 5, 400), hour("2026-11-11T15:00:00Z", 50, 5, 400),
    hour("2026-11-10T16:00:00Z", 50, 1, 40), hour("2026-11-11T16:00:00Z", 50, 1, 40),
    hour("2026-11-10T21:00:00Z", 1, 0, 0),
  ];
  const s = summarizeHours(series, "2026-11-10T00:00:00+03:00");
  assert.equal(s.by_hour[18].spend, 100);
  assert.equal(s.by_hour[18].roas, 8);
  assert.equal(s.by_hour[19].roas, 0.8);
  assert.equal(s.by_hour[0].spend, 1);
  assert.deepEqual([s.best_hours[0], s.worst_hours[0]], [18, 19], "an hour with under 2% of spend is not judged");
  const evening = s.by_daypart.find((p) => p.label.startsWith("evening"));
  assert.equal(evening.spend, 200);
  assert.equal(s.total_spend, 201);
});

test("hourly report: asks Snap for hourly stats of the last full days and checks its inputs", async () => {
  let asked;
  const client = { request: async (_m, path, { query }) => ((asked = { path, query }), { timeseries_stats: [{ timeseries_stat: { timeseries: [hour("2026-11-10T15:00:00Z", 10, 1, 40)] } }] }) };
  const r = await hourlyReport(client, { entity: "adsquad", id: "sq1", offset: "+03:00", days: 3, now: new Date("2026-11-14T09:00:00Z") });
  assert.deepEqual([asked.path, asked.query.granularity, asked.query.start_time, asked.query.end_time], ["/adsquads/sq1/stats", "HOUR", "2026-11-11T00:00:00+03:00", "2026-11-14T00:00:00+03:00"]);
  assert.equal(r.by_hour[18].spend, 10);
  await assert.rejects(hourlyReport(client, { id: "a", days: 8 }), /1 to 7/);
  await assert.rejects(hourlyReport(client, { entity: "team", id: "a" }), /entity must be/);
});

const ad = (name, creative_id, spend, purchases, value) => ({ id: name, name, creative_id, spend, purchases, purchase_value: value, roas: spend ? Math.round((value / spend) * 100) / 100 : null });

test("creative classification: winners, laggards, normal and too early, against the median", () => {
  const rows = [ad("A", "c1", 200, 10, 1000), ad("B", "c2", 200, 6, 600), ad("C", "c3", 200, 4, 400), ad("D", "c4", 200, 0, 0), ad("E", "c5", 10, 1, 100), ad("F", "c6", 200, 2, 120)];
  const r = classifyAds(rows, { minSpend: 50 });
  assert.equal(r.median_roas, 2, "the median of 5, 3, 2, 0 and 0.6 (an ad with no purchases counts)");
  assert.deepEqual(r.ads.map((a) => [a.name, a.verdict]), [["A", "WINNER"], ["B", "WINNER"], ["C", "NORMAL"], ["D", "LAGGING"], ["E", "TOO_EARLY"], ["F", "LAGGING"]]);
});

test("creative comparison: adds headline and call to action from the creatives and groups by call to action", async () => {
  const client = {
    request: async () => ({ total_stats: [{ total_stat: { breakdown_stats: { ad: [] } } }] }),
    listChildren: async () => [],
    listPaged: async () => ({ complete: true, items: [{ id: "c1", headline: "Big sale", call_to_action: "SHOP_NOW", type: "WEB_VIEW" }, { id: "c2", headline: "New in", call_to_action: "SHOP_NOW", type: "WEB_VIEW" }, { id: "c3", headline: "Learn", call_to_action: "MORE", type: "WEB_VIEW" }] }),
  };
  // use the real breakdown with stats for three ads
  client.request = async () => ({ total_stats: [{ total_stat: { breakdown_stats: { ad: [
    { id: "a1", stats: { spend: 200e6, conversion_purchases: 10, conversion_purchases_value: 1000e6, impressions: 1 } },
    { id: "a2", stats: { spend: 200e6, conversion_purchases: 5, conversion_purchases_value: 500e6, impressions: 1 } },
    { id: "a3", stats: { spend: 200e6, conversion_purchases: 0, conversion_purchases_value: 0, impressions: 1 } },
  ] } } }] });
  client.listChildren = async () => [{ id: "a1", name: "Ad 1", creative_id: "c1" }, { id: "a2", name: "Ad 2", creative_id: "c2" }, { id: "a3", name: "Ad 3", creative_id: "c3" }];
  const r = await creativeCompare(client, { adAccountId: "acc", entity: "adsquad", id: "sq", start_time: "2026-11-01T00:00:00+00:00", end_time: "2026-11-08T00:00:00+00:00", minSpend: 50 });
  assert.deepEqual(r.winners, ["Ad 1"]);
  assert.deepEqual(r.lagging, ["Ad 3"]);
  assert.equal(r.ads[0].headline, "Big sale");
  const shop = r.by_call_to_action.find((g) => g.call_to_action === "SHOP_NOW");
  assert.deepEqual([shop.ads, shop.spend, shop.roas], [2, 400, 3.75]);
  assert.match(r.caution, /different audiences/);
});

const squad = (id, budget, spend, roas, purchases) => ({ id, name: `Squad ${id}`, campaign: "C", daily_budget: budget, spend, roas, purchases });

test("budget advice: frees money from weak squads, gives it to proven ones, nets to zero, stays inside the limits", () => {
  const squads = [squad("w", 100, 700, 0.8, 4), squad("z", 50, 300, 1, 0), squad("m1", 100, 700, 3, 20), squad("m2", 100, 700, 3, 20), squad("t1", 100, 700, 5, 30), squad("t2", 250, 1750, 6, 40)];
  const r = suggestMoves(squads, { policy });
  assert.equal(r.median_roas, 3);
  assert.deepEqual(r.decreases.map((d) => [d.adsquad_id, d.from, d.to]), [["w", 100, 75], ["z", 50, 37.5]]);
  const freed = 25 + 12.5;
  assert.ok(r.increases.every((i) => i.to <= i.from * 1.3 + 1e-9), "never above the per-step increase limit");
  assert.ok(r.increases.every((i) => i.to <= 300), "never above the absolute daily budget limit");
  assert.equal(r.increases.find((i) => i.adsquad_id === "t2").to, 287.5, "the best squad gets everything the weak ones freed (37.5), not more");
  const added = r.increases.reduce((n, i) => n + (i.to - i.from), 0);
  assert.ok(added <= freed + 1e-9, "increases are funded by what the decreases free");
  assert.ok(r.net_daily_budget_change <= 1e-9);
  assert.match(r.increases[0].apply_with, /^snap_set_daily_budget entity=adsquad id=t\d daily_budget=/);
  const withExtra = suggestMoves(squads, { policy, extraBudget: 100 });
  assert.ok(withExtra.net_daily_budget_change > 0 && withExtra.net_daily_budget_change <= 100 + 1e-9);
  assert.equal(withExtra.increases.find((i) => i.adsquad_id === "t2").to, 300, "250 + 20% is exactly the absolute limit of 300");
  const tight = suggestMoves(squads, { policy: loadPolicy({ SNAP_MAX_DAILY_BUDGET: "260", SNAP_MAX_BUDGET_INCREASE_PCT: "30" }), extraBudget: 500 });
  assert.ok(tight.increases.every((i) => i.to <= 260), "the absolute limit caps every suggestion");
  assert.ok(suggestMoves([squad("a", 100, 700, 0.1, 0), squad("b", 100, 700, 3, 20), squad("c", 100, 700, 3, 20)], { policy: loadPolicy({ SNAP_MIN_DAILY_BUDGET: "90" }) }).decreases.every((d) => d.to >= 90), "never below the minimum daily budget");
  assert.match(suggestMoves([squad("a", 100, 700, 1, 5), squad("b", 100, 700, 2, 5)], { policy }).note, /Fewer than 3/);
  assert.deepEqual(suggestMoves([squad("a", 100, 10, 1, 5), squad("b", 100, 10, 2, 5), squad("c", 100, 10, 3, 5)], { policy }).increases, [], "squads with too little spend are not judged");
});

test("budget advice: reads active campaigns' active daily-budget squads and changes nothing", async () => {
  const client = {
    listPaged: async () => ({ complete: true, items: [{ id: "c1", name: "Main", status: "ACTIVE" }, { id: "c2", name: "Off", status: "PAUSED" }] }),
    listChildren: async (_e, id) => (id === "c1" ? [{ id: "s1", name: "A", status: "ACTIVE", daily_budget_micro: 100e6 }, { id: "s2", name: "B", status: "PAUSED", daily_budget_micro: 100e6 }, { id: "s3", name: "Lifetime", status: "ACTIVE", lifetime_budget_micro: 900e6 }] : []),
    request: async (method, path) => {
      assert.equal(method, "GET", "advice only reads");
      return { total_stats: [{ total_stat: { breakdown_stats: { adsquad: [{ id: "s1", stats: { spend: 700e6, conversion_purchases: 10, conversion_purchases_value: 2100e6, impressions: 1 } }] } } }] };
    },
  };
  const r = await budgetAdvice(client, { adAccountId: "acc", policy, offset: "+03:00", days: 7, now: new Date("2026-11-14T09:00:00Z") });
  assert.equal(r.active_squads_with_a_daily_budget, 1, "paused squads, paused campaigns and lifetime budgets are left out");
  assert.match(r.how_to_use, /nothing was changed/);
  await assert.rejects(budgetAdvice(client, { adAccountId: "acc", policy, days: 1 }), /3 to 28/);
});
