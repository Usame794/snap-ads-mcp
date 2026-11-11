// Reporting accuracy: unit conversion, ratios, totals, paging, dates, attribution, and the account health check.
// All inputs are representative mocked responses; nothing here is checked against the live Snap API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { basisOf, breakdownReport, checkWindow, collectBreakdown, dailyReport, dimensionReport, localDate, summarizeRow, totalsOf } from "../src/report.js";
import { compareReport, healthCheck, judgeSquad } from "../src/audit.js";

const W = { start_time: "2026-10-19T00:00:00+03:00", end_time: "2026-10-26T00:00:00+03:00" };
const stats = (spend, purchases, value, impressions = 1000, swipes = 10, frequency = 2) => ({ spend: Math.round(spend * 1e6), conversion_purchases: purchases, conversion_purchases_value: Math.round(value * 1e6), impressions, swipes, frequency });

test("row maths: micro-currency, ROAS, CPA, swipe rate, and missing values", () => {
  assert.deepEqual(summarizeRow("A", "a", stats(123.456, 4, 500.5, 20000, 150, 2.345)), { id: "a", name: "A", spend: 123.46, purchases: 4, purchase_value: 500.5, roas: 4.05, cpa: 30.86, impressions: 20000, swipe_rate_pct: 0.75, frequency: 2.35 });
  // nothing spent: ratios are null, not 0 and not Infinity
  assert.deepEqual(summarizeRow("B", "b", { impressions: 0 }), { id: "b", name: "B", spend: 0, purchases: 0, purchase_value: 0, roas: null, cpa: null, impressions: 0, swipe_rate_pct: null, frequency: null });
  // spend but no purchases: ROAS 0 (real), CPA null (undefined)
  const noSales = summarizeRow("C", "c", stats(50, 0, 0));
  assert.deepEqual([noSales.roas, noSales.cpa], [0, null]);
  // a frequency Snap did not report stays unknown
  assert.equal(summarizeRow("D", "d", { spend: 1e6 }).frequency, null);
  assert.equal(summarizeRow("E", "e").spend, 0);
  // 1 micro-unit is not rounded up into money
  assert.equal(summarizeRow("F", "f", { spend: 1 }).spend, 0);
});

test("totals come from raw micro values, not from rounded rows", () => {
  const tiny = [{ spend: 4000 }, { spend: 4000 }, { spend: 4000 }]; // 0.004 each: every row rounds to 0.00
  assert.equal(tiny.map((s) => summarizeRow("", "", s).spend).reduce((a, b) => a + b, 0), 0);
  assert.equal(totalsOf(tiny).total_spend, 0.01);
  const t = totalsOf([stats(100, 2, 300, 1000, 10), stats(300, 1, 300, 3000, 60), undefined]);
  assert.deepEqual(t, { total_spend: 400, total_purchases: 3, total_purchase_value: 600, total_roas: 1.5, total_cpa: 133.33, total_impressions: 4000, total_swipe_rate_pct: 1.75 });
  // account ROAS is value/spend (1.5), not the average of the rows' ROAS (3 and 1 -> 2)
  assert.notEqual(t.total_roas, (3 + 1) / 2);
  assert.deepEqual(totalsOf([]), { total_spend: 0, total_purchases: 0, total_purchase_value: 0, total_roas: null, total_cpa: null, total_impressions: 0, total_swipe_rate_pct: null });
});

test("windows must be unambiguous instants in order", () => {
  checkWindow(W.start_time, W.end_time);
  checkWindow("2026-10-19T00:00:00Z", "2026-10-20T00:00:00Z");
  assert.throws(() => checkWindow("2026-10-19T00:00:00", W.end_time), /start_time must be an ISO date-time with an offset/);
  assert.throws(() => checkWindow("2026-10-19", W.end_time), /offset/);
  assert.throws(() => checkWindow(W.start_time, "yesterday"), /end_time must be/);
  assert.throws(() => checkWindow(W.end_time, W.start_time), /end_time must be after start_time/);
  assert.throws(() => checkWindow(W.start_time, W.start_time), /after start_time/);
  assert.throws(() => checkWindow(undefined, W.end_time), /start_time/);
});

test("the local day is right whether Snap answers in the requested offset or in UTC", () => {
  assert.equal(localDate("2026-10-19T00:00:00.000+03:00", W.start_time), "2026-10-19");
  assert.equal(localDate("2026-10-18T21:00:00.000Z", W.start_time), "2026-10-19", "same instant, UTC form");
  assert.equal(localDate("2026-10-19T05:00:00.000Z", "2026-10-19T00:00:00-05:00"), "2026-10-19");
  assert.equal(localDate("2026-10-19T00:00:00.000-07:00", "2026-10-19T00:00:00-07:00"), "2026-10-19");
  assert.equal(localDate("2026-10-18T18:30:00.000Z", "2026-10-19T00:00:00+05:30"), "2026-10-19");
});

// A fake stats endpoint that serves breakdown rows in pages.
function pagedClient(pages, children, { everNext = false } = {}) {
  const queries = [];
  return {
    queries,
    request: async (_m, path, { query }) => {
      queries.push({ path, ...query });
      const i = query.cursor ? Number(query.cursor) : 0;
      const rows = pages[Math.min(i, pages.length - 1)];
      const more = everNext || i < pages.length - 1;
      return { total_stats: [{ total_stat: { breakdown_stats: { adsquad: rows, ad: rows }, ...(more ? { paging: { next_link: `https://adsapi.snapchat.com/v1${path}?cursor=${i + 1}` } } : {}) } }] };
    },
    listChildren: async () => children,
  };
}

test("breakdown report: follows pages, names rows, totals everything, states its basis", async () => {
  const client = pagedClient([[{ id: "s1", stats: stats(100, 2, 300) }, { id: "s2", stats: stats(0, 0, 0) }], [{ id: "s3", stats: stats(300, 1, 300) }, { id: "gone", stats: stats(10.004, 0, 0) }]], [{ id: "s1", name: "One" }, { id: "s3", name: "Three" }]);
  const r = await breakdownReport(client, { entity: "campaign", id: "c1", breakdown: "adsquad", ...W });
  assert.deepEqual(r.rows.map((x) => [x.name, x.spend, x.roas]), [["Three", 300, 1], ["One", 100, 3], ["gone", 10, 0]], "sorted by spend; zero rows dropped; unknown child keeps its id");
  assert.deepEqual([r.total_spend, r.total_purchases, r.total_purchase_value, r.total_roas, r.total_cpa], [410, 3, 600, 1.46, 136.67]);
  assert.equal(r.incomplete, undefined);
  assert.match(r.basis.attribution, /default attribution windows.*not pinned/);
  assert.match(r.basis.money, /micro-currency divided by 1,000,000/);
  assert.equal(client.queries.length, 2);
  assert.deepEqual([client.queries[0].granularity, client.queries[0].breakdown, client.queries[0].start_time, client.queries[0].swipe_up_attribution_window], ["TOTAL", "adsquad", W.start_time, undefined]);
});

test("breakdown report: pinned attribution is sent and reported; bad values and bad windows are refused before any request", async () => {
  const client = pagedClient([[{ id: "s1", stats: stats(10, 1, 20) }]], []);
  const r = await breakdownReport(client, { entity: "campaign", id: "c1", breakdown: "adsquad", ...W, swipe_up_attribution_window: "7_DAY", view_attribution_window: "1_DAY" });
  assert.deepEqual([client.queries[0].swipe_up_attribution_window, client.queries[0].view_attribution_window], ["7_DAY", "1_DAY"]);
  assert.equal(r.basis.attribution, "swipe 7_DAY, view 1_DAY");
  assert.equal(basisOf({ swipe_up_attribution_window: "28_DAY" }).attribution, "swipe 28_DAY, view account default");
  const before = client.queries.length;
  await assert.rejects(() => breakdownReport(client, { entity: "campaign", id: "c1", breakdown: "adsquad", ...W, swipe_up_attribution_window: "90_DAY" }), /swipe_up_attribution_window/);
  await assert.rejects(() => breakdownReport(client, { entity: "campaign", id: "c1", breakdown: "adsquad", start_time: "2026-10-19", end_time: W.end_time }), /offset/);
  await assert.rejects(() => breakdownReport(client, { entity: "adsquad", id: "s1", breakdown: "adsquad", ...W }), /breakdown for a adsquad/);
  assert.equal(client.queries.length, before);
});

test("breakdown report: a result cut off by the page limit says so instead of looking complete", async () => {
  const endless = pagedClient([[{ id: "s1", stats: stats(1, 0, 0) }]], [], { everNext: true });
  const rows = await collectBreakdown(endless, "/campaigns/c1/stats", {}, "adsquad", { maxPages: 3 });
  assert.equal(rows.length, 3);
  assert.equal(rows.incomplete, true);
  const r = await breakdownReport(endless, { entity: "campaign", id: "c1", breakdown: "adsquad", ...W });
  assert.equal(r.incomplete, true);
  assert.match(r.warning, /lower bound/);
  // a paging link that does not advance must not loop forever or be reported as complete
  const stuck = { request: async () => ({ total_stats: [{ total_stat: { breakdown_stats: { adsquad: [{ id: "s", stats: {} }] }, paging: { next_link: "https://adsapi.snapchat.com/v1/x?cursor=same" } } }] }), listChildren: async () => [] };
  const s = await collectBreakdown(stuck, "/x", {}, "adsquad", { maxPages: 50 });
  assert.equal(s.incomplete, true);
  assert.ok(s.length <= 2);
});

test("daily report: local dates, totals, 31-day limit", async () => {
  const series = [
    { start_time: "2026-10-18T21:00:00.000Z", stats: stats(100, 2, 300) }, // UTC form of 19 Oct 00:00 +03:00
    { start_time: "2026-10-20T00:00:00.000+03:00", stats: stats(50, 0, 0) },
  ];
  const client = { request: async (_m, path, { query }) => ((client.last = { path, ...query }), { timeseries_stats: [{ timeseries_stat: { timeseries: series } }] }) };
  const r = await dailyReport(client, { entity: "campaign", id: "c1", ...W });
  assert.deepEqual(r.rows.map((d) => [d.date, d.spend, d.roas, d.cpa]), [["2026-10-19", 100, 3, 50], ["2026-10-20", 50, 0, null]]);
  assert.deepEqual([r.days, r.total_spend, r.total_roas, r.total_purchases], [2, 150, 2, 2]);
  assert.ok(!("id" in r.rows[0]) && !("name" in r.rows[0]));
  assert.equal(client.last.granularity, "DAY");
  await assert.rejects(() => dailyReport(client, { entity: "campaign", id: "c1", start_time: "2026-09-01T00:00:00+03:00", end_time: "2026-10-03T00:00:00+03:00" }), /31 days/);
  await assert.rejects(() => dailyReport(client, { entity: "campaign", id: "c1", start_time: W.end_time, end_time: W.start_time }), /after start_time/);
  await assert.rejects(() => dailyReport(client, { entity: "pixel", id: "p", ...W }), /entity must be/);
  // an empty series is zero days, not an error
  series.length = 0;
  assert.deepEqual([(await dailyReport(client, { entity: "ad", id: "a1", ...W })).days, (await dailyReport(client, { entity: "ad", id: "a1", ...W })).total_spend], [0, 0]);
});

test("dimension report: totals cover every row even when only 100 are listed", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({ country: `c${i}`, ...stats(i + 1, 1, 2 * (i + 1)) }));
  const client = { request: async () => ({ total_stats: [{ total_stat: { dimension_stats: rows } }] }) };
  const r = await dimensionReport(client, { entity: "campaign", id: "c1", dimension: "country", ...W });
  assert.deepEqual([r.rows.length, r.rows_total, r.truncated, r.rows[0].country, r.rows[0].spend], [100, 150, true, "c149", 150]);
  assert.equal(r.total_spend, (150 * 151) / 2);
  assert.equal(r.total_roas, 2);
  const few = await dimensionReport({ request: async () => ({ total_stats: [{ total_stat: { dimension_stats: rows.slice(0, 3) } }] }) }, { entity: "campaign", id: "c1", dimension: "country", ...W });
  assert.equal(few.truncated, undefined);
  const age = await dimensionReport({ request: async () => ({ total_stats: [{ total_stat: { dimension_stats: [{ age_bucket: "18-24", ...stats(5, 0, 0) }] } }] }) }, { entity: "campaign", id: "c1", dimension: "age", ...W });
  assert.equal(age.rows[0].age, "18-24");
});

test("compare report: changes, and children present in only one window", async () => {
  const cur = [{ id: "a1", stats: stats(200, 4, 800) }, { id: "new", stats: stats(60, 1, 60) }];
  const prev = [{ id: "a1", stats: stats(100, 4, 400) }, { id: "old", stats: stats(80, 2, 160) }];
  const client = {
    request: async (_m, _p, { query }) => ({ total_stats: [{ total_stat: { breakdown_stats: { ad: query.start_time === W.start_time ? cur : prev } } }] }),
    listChildren: async () => [{ id: "a1", name: "Ad one" }, { id: "new", name: "New ad" }, { id: "old", name: "Old ad" }],
  };
  const r = await compareReport(client, { entity: "campaign", id: "c1", breakdown: "ad", current: W, previous: { start_time: "2026-10-12T00:00:00+03:00", end_time: W.start_time } });
  const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  assert.deepEqual(by.a1.spend, { now: 200, before: 100, change_pct: 100 });
  assert.deepEqual(by.a1.roas, { now: 4, before: 4, change: 0 });
  assert.deepEqual(by.a1.cpa, { now: 50, before: 25, change: 25 });
  assert.deepEqual(by.new.spend, { now: 60, before: 0, change_pct: null }, "no baseline: the change is unknown, not infinite");
  assert.deepEqual(by.old.spend, { now: 0, before: 80, change_pct: -100 });
  assert.equal(by.old.roas.change, null);
  assert.deepEqual(r.rows.map((x) => x.id), ["a1", "new", "old"]);
});

// ---- health check ----
function accountClient({ campaigns, squads, statsBy, failStats = [], campaignPages }) {
  const calls = [];
  return {
    calls,
    request: async (_m, path, { query } = {}) => {
      calls.push(path);
      if (path.endsWith("/campaigns")) {
        if (!campaignPages) return { campaigns: campaigns.map((campaign) => ({ campaign })) };
        const i = query.cursor ? Number(query.cursor) : 0;
        return { campaigns: campaignPages[i].map((campaign) => ({ campaign })), ...(i < campaignPages.length - 1 ? { paging: { next_link: `https://adsapi.snapchat.com/v1${path}?cursor=${i + 1}` } } : {}) };
      }
      const id = path.split("/")[2];
      if (failStats.includes(id)) throw new Error(`Snap API GET ${path} failed (500): stats unavailable`);
      return { total_stats: [{ total_stat: { breakdown_stats: { adsquad: statsBy[id] ?? [] } } }] };
    },
    listChildren: async (_p, id) => squads[id] ?? [],
  };
}
const sq = (id, o = {}) => ({ id, name: `Squad ${id}`, status: "ACTIVE", daily_budget_micro: 50e6, targeting: { segments: [{ operation: "EXCLUDE", segment_id: ["buyers"] }] }, ...o });

test("judgeSquad: every issue code and its threshold edge", () => {
  const th = { maxFrequency: 5, minSwipeRatePct: 0.15, minSpend: 100, minRoas: 3 };
  const camp = { status: "ACTIVE" };
  const codes = (squad, row, campaign = camp) => judgeSquad({ squad, campaign, row, thresholds: th }).map((i) => i.code);
  const row = (o) => ({ spend: 200, purchases: 5, roas: 4, swipe_rate_pct: 1, frequency: 2, ...o });
  assert.deepEqual(codes(sq("a"), row()), []);
  assert.deepEqual(codes(sq("a", { targeting: {} }), row()), ["NO_BUYER_EXCLUSION"]);
  assert.deepEqual(codes(sq("a", { targeting: { product_audiences: [{}] } }), row()), [], "catalog retargeting rule counts as an exclusion rule");
  assert.deepEqual(codes(sq("a", { targeting: {} }), row({ spend: 0 })), [], "no spend, nothing to exclude from");
  assert.deepEqual(codes(sq("a"), row({ frequency: 5 })), ["HIGH_FREQUENCY"]);
  assert.deepEqual(codes(sq("a"), row({ frequency: 4.99 })), []);
  assert.deepEqual(codes(sq("a"), row({ frequency: null })), [], "unknown frequency is not judged");
  assert.deepEqual(codes(sq("a"), row({ swipe_rate_pct: 0.14 })), ["LOW_SWIPE_RATE"]);
  assert.deepEqual(codes(sq("a"), row({ swipe_rate_pct: 0.14, spend: 99 })), [], "below the spend needed to judge");
  assert.deepEqual(codes(sq("a"), row({ roas: 2.99 })), ["LOW_ROAS"]);
  assert.deepEqual(codes(sq("a"), row({ roas: null, purchases: 0 })), ["LOW_ROAS", "SPEND_NO_PURCHASES"]);
  assert.deepEqual(codes(sq("a"), undefined, { status: "PAUSED" }), ["PARENT_NOT_ACTIVE"]);
  assert.deepEqual(codes(sq("a", { status: "PAUSED" }), undefined, { status: "PAUSED" }), []);
  assert.deepEqual(codes(sq("a"), undefined), [], "no stats row: nothing claimed");
});

test("healthCheck: audits ACTIVE squads of ACTIVE campaigns and counts issues", async () => {
  const client = accountClient({
    campaigns: [{ id: "c1", name: "Live", status: "ACTIVE" }, { id: "c2", name: "Off", status: "PAUSED" }, { id: "c3", name: "Empty", status: "ACTIVE" }],
    squads: { c1: [sq("good"), sq("noex", { targeting: {} }), sq("tired"), sq("idle"), sq("paused", { status: "PAUSED", targeting: {} })], c2: [sq("ignored", { targeting: {} })], c3: [sq("off", { status: "PAUSED" })] },
    statsBy: { c1: [{ id: "good", stats: stats(200, 5, 800, 10000, 100, 2) }, { id: "noex", stats: stats(300, 10, 1500, 10000, 100, 2) }, { id: "tired", stats: stats(400, 0, 0, 100000, 100, 6.2) }, { id: "paused", stats: stats(999, 0, 0) }] },
  });
  const r = await healthCheck(client, { adAccountId: "acc", ...W });
  assert.deepEqual([r.active_campaigns, r.active_squads_checked, r.active_squads_with_no_spend_in_window, r.squads_with_issues], [2, 4, 1, 2]);
  assert.equal(r.stats_unavailable, undefined);
  const by = Object.fromEntries(r.findings.map((f) => [f.adsquad_id, f.issues.map((i) => i.code)]));
  assert.deepEqual(by, { noex: ["NO_BUYER_EXCLUSION"], tired: ["HIGH_FREQUENCY", "LOW_SWIPE_RATE", "LOW_ROAS", "SPEND_NO_PURCHASES"] });
  assert.deepEqual(r.issue_counts, { NO_BUYER_EXCLUSION: 1, HIGH_FREQUENCY: 1, LOW_SWIPE_RATE: 1, LOW_ROAS: 1, SPEND_NO_PURCHASES: 1 });
  assert.deepEqual([r.findings[0].campaign, r.findings[0].campaign_id, r.findings[0].daily_budget], ["Live", "c1", 50]);
  assert.deepEqual(r.thresholds, { maxFrequency: 5, minSwipeRatePct: 0.15, minSpend: 100, minRoas: 3 });
  assert.ok(!client.calls.some((p) => p.includes("/campaigns/c2/")), "paused campaigns are not queried");
  assert.ok(!client.calls.some((p) => p.includes("/campaigns/c3/stats")), "a campaign with no ACTIVE squads needs no stats call");
});

test("healthCheck: custom thresholds change the verdicts", async () => {
  const client = accountClient({ campaigns: [{ id: "c1", name: "Live", status: "ACTIVE" }], squads: { c1: [sq("a")] }, statsBy: { c1: [{ id: "a", stats: stats(60, 1, 120, 10000, 100, 3) }] } });
  assert.equal((await healthCheck(client, { adAccountId: "acc", ...W })).squads_with_issues, 0, "below the default 100 spend floor");
  const strict = await healthCheck(client, { adAccountId: "acc", ...W, thresholds: { minSpend: 50, minRoas: 2.5, maxFrequency: 3 } });
  assert.deepEqual(strict.findings[0].issues.map((i) => i.code), ["HIGH_FREQUENCY", "LOW_ROAS"]);
  assert.equal(strict.thresholds.minSwipeRatePct, 0.15, "unspecified thresholds keep their defaults");
});

test("healthCheck: when stats cannot be read the result says UNKNOWN, not 'no spend' or 'no issues'", async () => {
  const client = accountClient({
    campaigns: [{ id: "c1", name: "Broken", status: "ACTIVE" }, { id: "c2", name: "Fine", status: "ACTIVE" }],
    squads: { c1: [sq("x", { targeting: {} }), sq("y")], c2: [sq("z")] },
    statsBy: { c2: [{ id: "z", stats: stats(200, 5, 800) }] },
    failStats: ["c1"],
  });
  const r = await healthCheck(client, { adAccountId: "acc", ...W });
  assert.equal(r.active_squads_checked, 3);
  assert.equal(r.active_squads_with_no_spend_in_window, 0, "unread squads are not reported as idle");
  assert.deepEqual([r.stats_unavailable.squads_not_judged_on_performance, r.stats_unavailable.campaigns[0].campaign_id], [2, "c1"]);
  assert.match(r.stats_unavailable.campaigns[0].error, /stats unavailable/);
  assert.match(r.stats_unavailable.warning, /UNKNOWN, not absent/);
  assert.equal(r.squads_with_issues, 0);
});

test("healthCheck: reads every page of campaigns", async () => {
  const mk = (id) => ({ id, name: id, status: "ACTIVE" });
  const client = accountClient({ campaignPages: [[mk("c1"), mk("c2")], [mk("c3")]], squads: { c1: [sq("a")], c2: [sq("b")], c3: [sq("c", { targeting: {} })] }, statsBy: { c3: [{ id: "c", stats: stats(150, 3, 600) }] } });
  const r = await healthCheck(client, { adAccountId: "acc", ...W });
  assert.deepEqual([r.active_campaigns, r.active_squads_checked, r.findings.map((f) => f.adsquad_id)], [3, 3, ["c"]]);
});
