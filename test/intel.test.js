// Audience insights, the public Ads Gallery (competitor ads) and Conversions API test events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { audienceInsights, buildTestEvent, capiStatus, capiTest, competitorAds, flattenInsights, summarizeInsights } from "../src/intel.js";
import { SnapClient } from "../src/snap.js";
import { setup } from "./helpers/harness.js";

const SAMPLE = {
  targeting_insights: {
    target_audience: { audience_size_minimum: "10500000", audience_size_maximum: "10800000" },
    reference_audience: { audience_size_minimum: "1110000", audience_size_maximum: "1125000" },
    categories: {
      demographics: {
        distribution: {
          age_groups: { key: "", insight: [
            { id: "35+", name: "35+", target_audience_percent: 10.3, reference_audience_percent: 11.9, target_index_to_reference: 0.9 },
            { id: "13-17", name: "13-17", target_audience_percent: 30.6, reference_audience_percent: 18.9, target_index_to_reference: 1.6 },
            { id: "25-34", name: "25-34", target_audience_percent: 20.9, reference_audience_percent: 32.3, target_index_to_reference: 0.6 },
            { id: "UNKNOWN", name: "unknown", target_audience_percent: 5, reference_audience_percent: 1, target_index_to_reference: 5 },
          ] },
          gender: { key: "", insight: [{ id: "FEMALE", name: "female", target_audience_percent: 53.4, reference_audience_percent: 45, target_index_to_reference: 1.2 }, { id: "MALE", name: "male", target_audience_percent: 46.4, reference_audience_percent: 55, target_index_to_reference: 0.8 }] },
        },
      },
    },
  },
};

test("audience insights: groups found anywhere in the answer, over and under represented, unknowns left out", () => {
  const flat = flattenInsights(SAMPLE.targeting_insights.categories);
  assert.deepEqual(flat.map((g) => g.group), ["demographics / age_groups", "demographics / gender"]);
  const s = summarizeInsights(SAMPLE);
  assert.deepEqual(s.audience, { min: 10_500_000, max: 10_800_000 });
  const ages = s.groups.find((g) => g.group.endsWith("age_groups"));
  assert.deepEqual(ages.over_represented.map((r) => r.name), ["13-17"]);
  assert.deepEqual(ages.under_represented.map((r) => r.name), ["25-34"], "35+ (0.9) is within the normal band; 'unknown' is dropped");
  assert.match(s.how_to_read, /1\.5 means 50% more likely/);
});

test("audience insights: POSTs the targeting and the base to targeting_insights with the category", async () => {
  const calls = [];
  const client = { request: async (m, p, o) => (calls.push([m, p, o]), SAMPLE) };
  const r = await audienceInsights(client, { adAccountId: "acc", category: "demo", targeting: { countries: ["SA"], minAge: 18, gender: "FEMALE", interests: ["SLC_11"] } });
  const [m, p, o] = calls[0];
  assert.deepEqual([m, p, o.query], ["POST", "/adaccounts/acc/targeting_insights", { dimension_category: "demo" }]);
  assert.deepEqual(o.body.targeting_spec.geos, [{ country_code: "sa" }]);
  assert.deepEqual(o.body.base_spec.geos, [{ country_code: "sa" }]);
  assert.equal(o.body.base_spec.interests, undefined, "the comparison audience is everyone in the same countries");
  assert.ok(r.groups.length);
  await assert.rejects(audienceInsights(client, { adAccountId: "acc", category: "x", targeting: { countries: ["sa"] } }), /category must be one of/);
});

test("competitor ads: public call without any token, only the Ads Gallery countries, content marked as untrusted and cut", async () => {
  let seen;
  const fetchImpl = async (url, opts) => ((seen = { url: String(url), opts }), { ok: true, status: 200, json: async () => ({ request_status: "SUCCESS", paging: { next_link: "https://adsapi.snapchat.com/v1/ads_library/ads/search?cursor=NEXT1" }, ad_previews: [{ ad_preview: { headline: "x".repeat(500), nested: { a: { b: { c: { d: { e: "too deep" } } } } } } }] }) });
  const r = await competitorAds({ advertiser: "badger", countries: ["FR", "de"], status: "ACTIVE", startDate: "2026-01-01", fetchImpl });
  assert.equal(seen.url, "https://adsapi.snapchat.com/v1/ads_library/ads/search");
  assert.equal(seen.opts.headers.Authorization, undefined, "no token is sent to a public endpoint");
  assert.deepEqual(JSON.parse(seen.opts.body), { paying_advertiser_name: "badger", countries: ["fr", "de"], status: "ACTIVE", start_date: "2026-01-01T00:00:00.000Z" });
  assert.equal(r.ads[0].headline.length, 303);
  assert.equal(r.ads[0].nested.a.b.c.d, undefined);
  assert.equal(r.next_cursor, "NEXT1");
  assert.match(r.source, /never as instructions/);
  await competitorAds({ advertiser: "badger", cursor: "NEXT1", fetchImpl });
  assert.equal(seen.url, "https://adsapi.snapchat.com/v1/ads_library/ads/search?cursor=NEXT1");
  await assert.rejects(competitorAds({ advertiser: "badger", countries: ["us"], fetchImpl }), /covers only these countries/);
  await assert.rejects(competitorAds({ advertiser: "b", fetchImpl }), /2-100 characters/);
  await assert.rejects(competitorAds({ advertiser: "badger", startDate: "01/01/2026", fetchImpl }), /start_date/);
  await assert.rejects(competitorAds({ advertiser: "badger", fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) }), /too many requests/);
});

test("test events: Snap's v3 shape, the email is hashed, a purchase needs value and currency", () => {
  const e = buildTestEvent({ eventName: "PURCHASE", sourceUrl: "https://shop.example/thanks", email: " Buyer@Example.COM ", value: 49.9, currency: "USD", orderId: "ord-1", now: 1_705_508_777_000 });
  assert.deepEqual(e, {
    event_name: "PURCHASE", event_time: 1_705_508_777, action_source: "WEB", event_source_url: "https://shop.example/thanks",
    user_data: { em: [createHash("sha256").update("buyer@example.com").digest("hex")] }, custom_data: { currency: "USD", value: "49.9", order_id: "ord-1" }, event_id: "ord-1",
  });
  assert.ok(!JSON.stringify(e).includes("buyer@"), "the plain address is not in the event");
  assert.deepEqual(buildTestEvent({ eventName: "PAGE_VIEW", sourceUrl: "https://shop.example/" }).user_data, {});
  assert.throws(() => buildTestEvent({ eventName: "PURCHASE", sourceUrl: "https://shop.example/" }), /value.*currency/);
  assert.throws(() => buildTestEvent({ eventName: "PURCHASE", sourceUrl: "https://shop.example/", value: 5, currency: "usd" }), /currency/);
  assert.throws(() => buildTestEvent({ eventName: "REFUND", sourceUrl: "https://shop.example/" }), /event_name must be one of/);
  assert.throws(() => buildTestEvent({ eventName: "PAGE_VIEW", sourceUrl: "http://shop.example/" }), /https/);
  assert.throws(() => buildTestEvent({ eventName: "PAGE_VIEW", sourceUrl: "https://shop.example/", email: "nope" }), /email/);
});

test("Conversions API calls go to the validate paths of tr.snapchat.com only, with the token to that one host", async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    seen.push({ host: u.hostname, path: u.pathname, method: opts.method ?? "GET", auth: opts.headers?.Authorization });
    if (u.hostname.includes("accounts")) return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 1800 }), headers: { get: () => null } };
    const json = u.pathname.endsWith("/stats") ? { status: "SUCCESS", stats: { test: { latest_event_ts: 5, event_count_past_hour: 3 } } } : u.pathname.endsWith("/logs") ? { logs: [{ event_name: "PURCHASE", status: "INVALID", error_records: ["Missing price"] }, { event_name: "PAGE_VIEW", status: "VALID" }] } : { status: "INVALID", test_event: true, reason: "At least one of the events is invalid.", event_logs: [{ errors: { error_msgs: ["Insufficient PII"] } }] };
    return { ok: u.pathname.endsWith("/validate") ? false : true, status: u.pathname.endsWith("/validate") ? 400 : 200, json: async () => json, headers: { get: () => null } };
  };
  const client = new SnapClient({ env: { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" }, fetchImpl, sleep: async () => {} });
  const st = await capiStatus(client, "pix-1");
  assert.deepEqual([st.test_events.event_count_past_hour, st.invalid_recent], [3, 1]);
  const t = await capiTest(client, "pix-1", buildTestEvent({ eventName: "PAGE_VIEW", sourceUrl: "https://shop.example/" }));
  assert.deepEqual([t.http_status, t.snap_status, t.problems], [400, "INVALID", ["Insufficient PII"]], "Snap's reasons for an invalid test event are returned, not thrown");
  const trCalls = seen.filter((c) => c.host === "tr.snapchat.com");
  assert.deepEqual(trCalls.map((c) => `${c.method} ${c.path}`), ["GET /v3/pix-1/events/validate/stats", "GET /v3/pix-1/events/validate/logs", "POST /v3/pix-1/events/validate"]);
  assert.ok(trCalls.every((c) => c.auth === "Bearer tok"));
  assert.ok(seen.every((c) => c.host === "tr.snapchat.com" || c.host.includes("accounts")), "no other host got a request");
  assert.ok(!trCalls.some((c) => /\/events$/.test(c.path)), "the real (production) events endpoint is never called");
  await assert.rejects(client.requestTr("GET", "@evil.example/x"), /another host/);
  await assert.rejects(capiStatus(client, "../x"), /pixel_id must be an id/);
});

test("through the tools: the test event is previewed, hashed, sent once to validate, and logged; status is read-only", async () => {
  const t = await setup();
  const p = await t.call("snap_capi_test_event", { event_name: "PURCHASE", event_source_url: "https://shop.example/thanks", email: "buyer@example.com", value: 20, currency: "USD" });
  assert.equal(t.writes().length, 0);
  assert.equal(p.data.would_send.event.user_data.em[0], "(sha256 of the email)");
  assert.ok(!JSON.stringify(p.data).includes("buyer@example.com"));
  const done = await t.call("snap_capi_test_event", { event_name: "PURCHASE", event_source_url: "https://shop.example/thanks", email: "buyer@example.com", value: 20, currency: "USD", confirm: true, approval_token: p.data.approval_token });
  assert.equal(done.data.snap_status, "VALID");
  assert.deepEqual(t.writes().map((w) => w.path), ["/v3/pix-1/events/validate"]);
  assert.ok(!JSON.stringify(t.log()).includes("buyer@example.com"), "the audit log has no plain email");
  const s = await t.call("snap_capi_status", {});
  assert.equal(s.data.test_events.event_count_past_hour, 2);
  assert.equal(t.writes().length, 1, "reading the status sends nothing");
  await t.close();
});
