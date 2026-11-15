// Landing page checker, anomaly check and blended ROAS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { anomalyCheck, blendedRoas, checkUrl, isPrivateAddress, judgeDays, landingPageReport, urlsOfCreative } from "../src/checks.js";

const pub = async () => [{ address: "93.184.216.34", family: 4 }];
const res = (status, location) => ({ status, headers: { get: (k) => (k.toLowerCase() === "location" ? location : null) }, body: { cancel: async () => {} } });

test("private, loopback, link-local and reserved addresses are never contacted", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1"]) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:2800:220:1::1"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("checkUrl: OK, broken, server error, blocked, slow, timeouts and redirects", async () => {
  const answer = (status, loc) => async () => res(status, loc);
  assert.equal((await checkUrl("https://shop.example/a", { fetchImpl: answer(200), lookup: pub })).verdict, "OK");
  assert.equal((await checkUrl("https://shop.example/a", { fetchImpl: answer(404), lookup: pub })).verdict, "BROKEN");
  assert.equal((await checkUrl("https://shop.example/a", { fetchImpl: answer(410), lookup: pub })).verdict, "BROKEN");
  assert.equal((await checkUrl("https://shop.example/a", { fetchImpl: answer(503), lookup: pub })).verdict, "SERVER_ERROR");
  assert.equal((await checkUrl("https://shop.example/a", { fetchImpl: answer(403), lookup: pub })).verdict, "UNCHECKED");
  let t = 0;
  assert.equal((await checkUrl("https://shop.example/a", { fetchImpl: answer(200), lookup: pub, now: () => (t += 6000) })).verdict, "SLOW");
  const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
  assert.equal((await checkUrl("https://shop.example/a", { fetchImpl: async () => { throw timeout; }, lookup: pub })).verdict, "TIMEOUT");
  assert.equal((await checkUrl("https://shop.example/a", { fetchImpl: async () => { throw new TypeError("fetch failed"); }, lookup: pub })).verdict, "UNREACHABLE");
  const hops = [res(301, "/b"), res(302, "https://other.example/c"), res(200)];
  const r = await checkUrl("https://shop.example/a", { fetchImpl: async () => hops.shift(), lookup: pub });
  assert.deepEqual([r.verdict, r.final_url, r.chain], ["OK", "https://other.example/c", [301, 302, 200]]);
  assert.equal((await checkUrl("https://shop.example/a", { fetchImpl: answer(301, "/a"), lookup: pub })).verdict, "BROKEN", "a redirect loop ends");
});

test("checkUrl never reaches a private target, directly, by name or through a redirect, and refuses http", async () => {
  let fetched = 0;
  const fetchImpl = async () => (fetched++, res(302, "https://169.254.169.254/latest/meta-data"));
  assert.equal((await checkUrl("https://127.0.0.1/", { fetchImpl, lookup: pub })).verdict, "UNSAFE_TARGET");
  assert.equal((await checkUrl("https://localhost/", { fetchImpl, lookup: pub })).verdict, "UNSAFE_TARGET");
  assert.equal((await checkUrl("https://intranet.example/", { fetchImpl, lookup: async () => [{ address: "10.0.0.5" }] })).verdict, "UNSAFE_TARGET");
  assert.equal(fetched, 0, "nothing was contacted");
  const viaRedirect = await checkUrl("https://shop.example/", { fetchImpl, lookup: pub });
  assert.equal(viaRedirect.verdict, "UNSAFE_TARGET");
  assert.equal(fetched, 1, "only the public first hop was contacted");
  const http = await checkUrl("http://shop.example/", { fetchImpl, lookup: pub });
  assert.equal(http.verdict, "NOT_HTTPS");
  assert.equal(fetched, 1);
});

test("urlsOfCreative: web view and collection links; nothing for Snap-only, Story and catalog creatives", () => {
  assert.deepEqual(urlsOfCreative({ web_view_properties: { url: "https://a.example/" } }), ["https://a.example/"]);
  assert.deepEqual(urlsOfCreative({ collection_properties: { web_view_properties: { url: "https://b.example/" } } }), ["https://b.example/"]);
  assert.deepEqual(urlsOfCreative({ type: "SNAP_AD" }), []);
  assert.deepEqual(urlsOfCreative(undefined), []);
});

test("landing page report: only active ads of active squads, each distinct link once, the ads behind each problem, missing parameters", async () => {
  const campaigns = [{ id: "k1", name: "Camp", status: "ACTIVE" }, { id: "k2", name: "Paused camp", status: "PAUSED" }];
  const squads = { k1: [{ id: "s1", status: "ACTIVE" }, { id: "s2", status: "PAUSED" }], k2: [{ id: "s9", status: "ACTIVE" }] };
  const ads = { s1: [
    { id: "a1", name: "Ad 1", status: "ACTIVE", creative_id: "c1", ad_squad_id: "s1" },
    { id: "a2", name: "Ad 2", status: "ACTIVE", creative_id: "c2", ad_squad_id: "s1" },
    { id: "a3", name: "Ad 3", status: "ACTIVE", creative_id: "c1", ad_squad_id: "s1" },
    { id: "a4", name: "Paused", status: "PAUSED", creative_id: "c3", ad_squad_id: "s1" },
    { id: "a5", name: "Story", status: "ACTIVE", creative_id: "c4", ad_squad_id: "s1" },
  ], s2: [{ id: "x", name: "never read", status: "ACTIVE", creative_id: "c3", ad_squad_id: "s2" }], s9: [{ id: "y", name: "never read either", status: "ACTIVE", creative_id: "c3", ad_squad_id: "s9" }] };
  const creatives = {
    c1: { id: "c1", web_view_properties: { url: "https://shop.example/a?utm_source=snap" } },
    c2: { id: "c2", web_view_properties: { url: "https://shop.example/gone" } },
    c3: { id: "c3", web_view_properties: { url: "https://shop.example/paused" } },
    c4: { id: "c4", type: "COMPOSITE" },
  };
  const reads = [];
  const client = {
    listPaged: async () => ({ items: campaigns, complete: true }),
    listChildren: async (parent, id, child) => (reads.push(`${parent}:${id}`), child === "adsquad" ? squads[id] : ads[id]),
    getEntity: async (_e, id) => (reads.push(`creative:${id}`), creatives[id]),
  };
  const seen = [];
  const check = async (url) => (seen.push(url), url.endsWith("/gone") ? { url, verdict: "BROKEN", status: 404, detail: "Page not found (404)" } : { url, verdict: "OK", status: 200 });
  const r = await landingPageReport(client, { adAccountId: "acc", requiredParams: ["utm_source"], check });
  assert.deepEqual(seen.sort(), ["https://shop.example/a?utm_source=snap", "https://shop.example/gone"], "paused ads and Story ads are not checked, a shared link once");
  assert.deepEqual([r.active_campaigns, r.active_squads, r.active_ads, r.ads_without_a_web_link, r.links_checked, r.all_links_ok], [1, 1, 4, 1, 2, false]);
  assert.ok(!reads.some((x) => x === "campaign:k2" || x === "adsquad:s2" || x === "creative:c3"), "paused campaigns, paused squads and the creatives only they use are never read");
  const gone = r.problems.find((p) => p.url.endsWith("/gone"));
  assert.deepEqual([gone.verdict, gone.missing_params, gone.ads.map((x) => x.ad_id)], ["BROKEN", ["utm_source"], ["a2"]]);
  assert.equal(r.problems.length, 1, "the working link that has its parameter is not a problem");
  assert.match(r.not_checked, /out of stock/);
  const limited = await landingPageReport(client, { adAccountId: "acc", maxUrls: 1, check });
  assert.equal(limited.links_not_checked, 1);
});

test("landing page report: a time limit stops the work and says what was not covered", async () => {
  let t = 0;
  const now = () => (t += 30_000);
  const client = {
    listPaged: async () => ({ items: [{ id: "k1", name: "C", status: "ACTIVE" }], complete: true }),
    listChildren: async (_p, _id, child) => (child === "adsquad" ? [{ id: "s1", status: "ACTIVE" }] : [{ id: "a1", name: "A", status: "ACTIVE", creative_id: "c1", ad_squad_id: "s1" }]),
    getEntity: async () => ({ id: "c1", web_view_properties: { url: "https://shop.example/a" } }),
  };
  const r = await landingPageReport(client, { adAccountId: "acc", check: async (url) => ({ url, verdict: "OK" }), timeBudgetMs: 40_000, now });
  assert.equal(r.partial, true);
  assert.match(r.partial_reason, /Stopped after about 40 seconds/);
  assert.equal(r.all_links_ok, false, "an incomplete check never claims everything is fine");
});

const day = (date, spend, purchases, value = purchases * 40) => ({ date, spend, purchases, purchase_value: value, roas: spend ? Math.round((value / spend) * 100) / 100 : null, cpa: purchases ? Math.round((spend / purchases) * 100) / 100 : null });
const normal = (n) => Array.from({ length: n }, (_, i) => day(`2026-11-0${i + 1}`, 100, 5, 400));

test("anomaly check: normal days, spend spike and drop, silent tracking, purchase drop, ROAS drop, CPA spike", () => {
  assert.equal(judgeDays([...normal(7), day("d8", 100, 5, 400), day("d9", 105, 5, 410)]).verdict, "NORMAL");
  assert.equal(judgeDays(normal(3)).verdict, "NOT_ENOUGH_DATA");
  assert.equal(judgeDays([...normal(7).map((d) => ({ ...d, spend: 5, purchases: 0, purchase_value: 0 })), day("a", 5, 0), day("b", 5, 0)]).verdict, "TOO_LITTLE_SPEND");
  const codes = (rows) => judgeDays(rows).findings.map((f) => f.code);
  assert.deepEqual(codes([...normal(7), day("a", 100, 5), day("b", 260, 13, 1040)]), ["SPEND_SPIKE"], "more spend with proportionally more purchases");
  assert.deepEqual(codes([...normal(7), day("a", 100, 5), day("b", 260, 5, 400)]), ["SPEND_SPIKE", "ROAS_DROP", "CPA_SPIKE"], "more spend and no extra purchases is worse");
  assert.deepEqual(codes([...normal(7), day("a", 100, 5), day("b", 30, 1, 40)]), ["SPEND_DROP"]);
  const silent = judgeDays([...normal(7), day("a", 100, 0, 0), day("b", 95, 0, 0)]);
  assert.deepEqual([silent.verdict, silent.findings.map((f) => f.code)], ["CRITICAL", ["TRACKING_SILENT"]]);
  assert.deepEqual(codes([...normal(7), day("a", 100, 5), day("b", 95, 0, 0)]), ["NO_PURCHASES"], "one empty day is only a warning");
  assert.deepEqual(codes([...normal(7), day("a", 100, 5), day("b", 100, 2, 160)]), ["PURCHASES_DROP", "ROAS_DROP", "CPA_SPIKE"]);
  assert.deepEqual(codes([...normal(7), day("a", 100, 5), day("b", 100, 5, 150)]), ["ROAS_DROP"], "same purchases, lower value");
  const spike = judgeDays([...normal(7), day("a", 100, 5), day("b", 100, 5, 400)]);
  assert.equal(spike.baseline.roas, 4);
});

test("anomaly check: reads the account's last full local days and judges the last one", async () => {
  let asked;
  const rows = [...normal(7), day("2026-11-08", 100, 5), day("2026-11-09", 100, 0, 0)];
  const r = await anomalyCheck({}, { adAccountId: "acc", offset: "+03:00", baselineDays: 7, now: new Date("2026-11-10T09:00:00Z"), report: async (_c, a) => ((asked = a), { rows }) });
  assert.deepEqual([asked.entity, asked.id, asked.start_time, asked.end_time], ["adaccount", "acc", "2026-11-01T00:00:00+03:00", "2026-11-10T00:00:00+03:00"]);
  assert.equal(r.judged_day, "2026-11-09");
  assert.equal(r.findings[0].code, "NO_PURCHASES");
  await assert.rejects(anomalyCheck({}, { adAccountId: "acc", baselineDays: 2 }), /3 to 29/);
});

test("blended ROAS: overstates, understates, consistent, and the inputs are checked", async () => {
  const report = (v) => async () => ({ total_spend: 1000, total_purchases: 40, total_purchase_value: v, total_roas: v / 1000, total_cpa: 25 });
  const now = new Date("2026-11-10T09:00:00Z");
  const over = await blendedRoas({}, { adAccountId: "acc", storeRevenue: 3000, storeOrders: 50, now, report: report(5000) });
  assert.deepEqual([over.verdict, over.snap_claims_vs_store, over.store_reported.roas, over.store_reported.cpa], ["SNAP_OVERSTATES", 1.67, 3, 20]);
  assert.match(over.note, /Judge campaigns on the store's ROAS/);
  assert.equal((await blendedRoas({}, { adAccountId: "acc", storeRevenue: 6000, now, report: report(3000) })).verdict, "SNAP_UNDERSTATES");
  assert.equal((await blendedRoas({}, { adAccountId: "acc", storeRevenue: 3000, now, report: report(3100) })).verdict, "CONSISTENT");
  assert.equal((await blendedRoas({}, { adAccountId: "acc", storeRevenue: 3000, now, report: report(0) })).verdict, "SNAP_REPORTS_NO_REVENUE");
  assert.equal((await blendedRoas({}, { adAccountId: "acc", storeRevenue: 3000, now, report: async () => ({ total_spend: 0, total_purchase_value: 0 }) })).verdict, "NO_SPEND");
  let asked;
  await blendedRoas({}, { adAccountId: "acc", offset: "+03:00", storeRevenue: 3000, startDate: "2026-11-01", endDate: "2026-11-07", report: async (_c, a) => ((asked = a), { total_spend: 1, total_purchase_value: 1 }) });
  assert.deepEqual([asked.start_time, asked.end_time], ["2026-11-01T00:00:00+03:00", "2026-11-08T00:00:00+03:00"]);
  await assert.rejects(blendedRoas({}, { adAccountId: "acc", storeRevenue: 0, now, report: report(1) }), /store_revenue/);
  await assert.rejects(blendedRoas({}, { adAccountId: "acc", storeRevenue: 5, startDate: "2026-11-01", now, report: report(1) }), /both start_date and end_date/);
  await assert.rejects(blendedRoas({}, { adAccountId: "acc", storeRevenue: 5, startDate: "2026-09-01", endDate: "2026-11-01", now, report: report(1) }), /at most 31 days/);
});
