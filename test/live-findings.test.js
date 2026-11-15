// Regression tests for what the first run on a real ad account found.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountSeries, accountTotals, dailyReport } from "../src/report.js";
import { hourlyReport, suggestMoves } from "../src/advice.js";
import { feedStatus, funnelReport, scheduleDays, uploadErrorCount } from "../src/hygiene.js";
import { audienceInsights } from "../src/intel.js";
import { anomalyCheck } from "../src/checks.js";
import { loadPolicy } from "../src/policy.js";
import { SnapClient } from "../src/snap.js";

const ACC = "acc-1";
const WINDOW = { start_time: "2026-11-01T00:00:00+00:00", end_time: "2026-11-04T00:00:00+00:00" };
const day = (d, spend, purchases, value) => ({ start_time: `2026-11-0${d}T00:00:00.000+00:00`, end_time: `2026-11-0${d + 1}T00:00:00.000+00:00`, stats: { spend: spend * 1e6, impressions: 1000, swipes: 10, conversion_purchases: purchases, conversion_purchases_value: value * 1e6 } });
const camp = (id, rows) => ({ timeseries_stat: { id, type: "CAMPAIGN", timeseries: rows } });

// A fake that behaves like the real Snap did: an account-level query with fields other than `spend` and no breakdown is a 400.
function snapLike({ breakdown = "ok", campaignsActive = ["c1", "c2"], accountSpend } = {}) {
  const calls = [];
  const perCampaign = { c1: [day(1, 60, 3, 240), day(2, 60, 3, 240), day(3, 60, 3, 240)], c2: [day(1, 40, 2, 160), day(2, 40, 2, 160), day(3, 40, 2, 160)] };
  const total = (accountSpend ?? 300) * 1e6;
  return {
    calls,
    client: {
      request: async (m, path, { query } = {}) => {
        calls.push({ path, query });
        if (path === `/adaccounts/${ACC}/stats`) {
          if (!query.breakdown) {
            if (query.fields !== "spend") throw new Error("Snap API GET /adaccounts/x/stats failed (400): Unsupported Stats Query: Only field 'spend' should be used when querying AdAccount stats.");
            return { total_stats: [{ total_stat: { stats: { spend: total } } }] };
          }
          if (breakdown === "400") throw new Error("Snap API GET /adaccounts/x/stats failed (400): Unsupported Stats Query: breakdown");
          if (breakdown === "empty") return { timeseries_stats: [] };
          if (query.granularity === "TOTAL") return { total_stats: [{ total_stat: { breakdown_stats: { campaign: [{ id: "c1", stats: { spend: 180e6, conversion_purchases: 9, conversion_purchases_value: 720e6, impressions: 3000 } }, { id: "c2", stats: { spend: 120e6, conversion_purchases: 6, conversion_purchases_value: 480e6, impressions: 2000 } }] } } }] };
          return { timeseries_stats: [camp("c1", perCampaign.c1), camp("c2", perCampaign.c2)] };
        }
        const id = path.split("/")[2];
        return { timeseries_stats: [camp(id, perCampaign[id])] };
      },
      listPaged: async () => ({ complete: true, items: ["c1", "c2", "c3"].map((id) => ({ id, status: campaignsActive.includes(id) ? "ACTIVE" : "PAUSED" })) }),
    },
  };
}

test("account totals come from the campaign breakdown, never from account-level fields other than spend", async () => {
  const { client, calls } = snapLike();
  const t = await accountTotals(client, ACC, { ...WINDOW });
  assert.deepEqual([t.stats.spend, t.stats.conversion_purchases, t.stats.conversion_purchases_value, t.campaigns], [300e6, 15, 1200e6, 2]);
  assert.equal(calls[0].query.breakdown, "campaign");
  const f = await funnelReport(client, { adAccountId: ACC, days: 3, now: new Date("2026-11-04T09:00:00Z") });
  assert.equal(f.steps.find((s) => s.step === "purchases").count, 15);
});

test("account series: merged from the breakdown, checked against Snap's own spend, and rebuilt when the answer is not the whole account", async () => {
  const good = snapLike();
  const a = await accountSeries(good.client, ACC, { granularity: "DAY", ...WINDOW });
  assert.deepEqual([a.source, a.coverage_pct, a.series.map((s) => s.stats.spend)], ["campaign breakdown", 100, [100e6, 100e6, 100e6]]);
  assert.equal(a.warning, undefined);
  // Snap refuses the breakdown with a 400: fall back to the active campaigns' own series
  const refused = snapLike({ breakdown: "400" });
  const b = await accountSeries(refused.client, ACC, { granularity: "DAY", ...WINDOW });
  assert.deepEqual([b.source, b.coverage_pct, b.series.length], ["active campaigns only", 100, 3]);
  // an unexpected answer shape (no series) while the account clearly spent: never silent zeros
  const odd = snapLike({ breakdown: "empty" });
  const c = await accountSeries(odd.client, ACC, { granularity: "DAY", ...WINDOW });
  assert.equal(c.source, "active campaigns only");
  assert.equal(c.series.reduce((n, s) => n + s.stats.spend, 0), 300e6);
  // a paused campaign also spent: coverage is reported, not hidden
  const partial = snapLike({ breakdown: "400", accountSpend: 400 });
  const d = await accountSeries(partial.client, ACC, { granularity: "DAY", ...WINDOW });
  assert.equal(d.coverage_pct, 75);
  assert.match(d.warning, /cover about 75% of the account's spend/);
  // other errors are not swallowed
  await assert.rejects(accountSeries({ request: async () => { throw new Error("Snap API GET failed (500): boom"); } }, ACC, { granularity: "DAY", ...WINDOW }), /500/);
});

test("daily and hourly reports and the anomaly check work at account level with Snap's real limits", async () => {
  const { client } = snapLike();
  const daily = await dailyReport(client, { entity: "adaccount", id: ACC, ...WINDOW });
  assert.deepEqual([daily.days, daily.total_spend, daily.total_purchases, daily.coverage_pct], [3, 300, 15, 100]);
  const hourly = await hourlyReport(client, { entity: "adaccount", id: ACC, offset: "+00:00", days: 3, now: new Date("2026-11-04T09:00:00Z") });
  assert.equal(hourly.total_spend, 300);
  assert.equal(hourly.coverage_pct, 100);
  const a = await anomalyCheck(client, { adAccountId: ACC, offset: "+00:00", baselineDays: 3, now: new Date("2026-11-04T09:00:00Z") });
  assert.ok(a.days.length >= 3, JSON.stringify(a).slice(0, 200));
});

test("conversions API: the token is an access_token parameter to tr.snapchat.com only; SNAP_CAPI_TOKEN replaces the login token; a refusal explains what to do", async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    seen.push({ host: u.hostname, path: u.pathname, token: u.searchParams.get("access_token"), auth: opts.headers?.Authorization });
    if (u.hostname.includes("accounts")) return { ok: true, status: 200, json: async () => ({ access_token: "OAUTH-TOKEN", expires_in: 1800 }), headers: { get: () => null } };
    return { ok: u.searchParams.get("access_token") !== "REFUSED", status: u.searchParams.get("access_token") === "REFUSED" ? 401 : 200, json: async () => ({ status: "SUCCESS", stats: {} }), headers: { get: () => null } };
  };
  const base = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };
  const login = new SnapClient({ env: base, fetchImpl, sleep: async () => {} });
  await login.requestTr("GET", "/v3/pix-1/events/validate/stats");
  const tr = seen.find((c) => c.host === "tr.snapchat.com");
  assert.deepEqual([tr.token, tr.auth], ["OAUTH-TOKEN", "Bearer OAUTH-TOKEN"], "the login's access token, as the documented parameter");
  seen.length = 0;
  const own = new SnapClient({ env: { ...base, SNAP_CAPI_TOKEN: "CAPI-TOKEN" }, fetchImpl, sleep: async () => {} });
  await own.requestTr("GET", "/v3/pix-1/events/validate/logs");
  assert.deepEqual(seen.map((c) => [c.host, c.token, c.auth]), [["tr.snapchat.com", "CAPI-TOKEN", undefined]], "only the dedicated token, and no call to the login service for it");
  const refused = new SnapClient({ env: { ...base, SNAP_CAPI_TOKEN: "REFUSED" }, fetchImpl, sleep: async () => {} });
  await assert.rejects(refused.requestTr("GET", "/v3/pix-1/events/validate/stats"), (e) => /Check SNAP_CAPI_TOKEN/.test(e.message) && !e.message.includes("REFUSED"));
  const noOwn = new SnapClient({ env: base, fetchImpl: async (url, opts = {}) => (String(url).includes("accounts") ? fetchImpl(url, opts) : { ok: false, status: 401, json: async () => ({ reason: "Invalid access token" }), headers: { get: () => null } }), sleep: async () => {} });
  await assert.rejects(noOwn.requestTr("GET", "/v3/pix-1/events/validate/stats"), /set SNAP_CAPI_TOKEN in your settings/);
  await assert.rejects(login.requestTr("GET", "@evil.example/x"), /another host/);
});

test("audience insights say why there are no groups when the targeting equals the comparison", async () => {
  const same = { request: async () => ({ targeting_insights: { target_audience: { audience_size_minimum: "5", audience_size_maximum: "6" }, categories: { demographics: { distribution: { gender: { insight: [{ name: "female", target_audience_percent: 50, reference_audience_percent: 50, target_index_to_reference: 1 }] } } } } } }) };
  const r = await audienceInsights(same, { adAccountId: ACC, targeting: { countries: ["sa"] } });
  assert.equal(r.groups.length, 0);
  assert.match(r.note, /expected when your targeting is only the countries/);
});

test("budget advice says how many ad squads were compared and why nothing is suggested", () => {
  const policy = loadPolicy({});
  const sq = (id, roas) => ({ id, name: id, campaign: "C", daily_budget: 100, spend: 700, roas, purchases: 20 });
  const r = suggestMoves([sq("a", 3), sq("b", 3.1), sq("c", 2.9)], { policy });
  assert.equal(r.squads_compared, 3);
  assert.match(r.note, /3 ad squads had enough spend to compare and none is far enough/);
  assert.equal(suggestMoves([sq("a", 3)], { policy }).squads_compared, 1);
});

test("feed status respects each feed's schedule and counts only real upload errors", async () => {
  assert.equal(scheduleDays({ interval_type: "HOURLY", interval_count: 1 }) < 0.1, true);
  assert.equal(scheduleDays({ interval_type: "DAILY", interval_count: 2 }), 2);
  assert.equal(scheduleDays({ interval_type: "WEEKLY", interval_count: 1 }), 7);
  assert.equal(scheduleDays(null), null);
  assert.equal(uploadErrorCount({ summary: { issues_summary: { errors: { A: 2, B: 1 }, warnings: { W: 9 }, recommendations: { R: 4 } } } }), 3);
  const now = Date.parse("2026-11-14T10:00:00Z");
  const feed = (schedule, completedAt, issues = {}) => ({ feeds: [{ product_feed: { id: "f", name: "F", schedule } }], uploads: [{ feed_upload: { id: "u", created_at: completedAt, updated_at: completedAt, status: "COMPLETE", summary: { total_items: 10, issues_summary: issues } } }] });
  const run = async (f) => feedStatus({ listPaged: async () => ({ items: [{ id: "cat", name: "C" }] }), request: async (_m, p) => (p.endsWith("product_feeds") ? { product_feeds: f.feeds } : { feed_uploads: f.uploads }) }, { organizationId: "org", now });
  const weekly = await run(feed({ interval_type: "WEEKLY", interval_count: 1 }, "2026-11-08T10:00:00Z"));
  assert.equal(weekly.feeds_with_problems, 0, "6 days old is normal for a weekly feed");
  const hourly = await run(feed({ interval_type: "HOURLY", interval_count: 1 }, "2026-11-08T10:00:00Z"));
  assert.equal(hourly.feeds_with_problems, 1, "6 days old is stale for an hourly feed");
  const warnings = await run(feed({ interval_type: "DAILY", interval_count: 1 }, "2026-11-14T08:00:00Z", { warnings: { W: 50 } }));
  assert.equal(warnings.feeds_with_problems, 0, "warnings are listed but are not problems");
  const errors = await run(feed({ interval_type: "DAILY", interval_count: 1 }, "2026-11-14T08:00:00Z", { errors: { E: 1 } }));
  assert.equal(errors.feeds_with_problems, 1);
});
