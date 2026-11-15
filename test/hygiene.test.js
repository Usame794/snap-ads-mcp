// Billing, unused media, audience health, funnel and catalog feed status (all read-only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { audienceHealth, billingCheck, buildFunnel, feedStatus, funnelReport, judgeFunding, judgeUpload, unusedMedia } from "../src/hygiene.js";

const NOW = Date.parse("2026-11-14T10:00:00Z");
const U = (n) => `0000000${n}-aaaa-4bbb-8ccc-00000000000${n}`;

test("funding sources: expired and expiring cards, daily limit vs budgets, low credit and days of credit", () => {
  const codes = (s, b = 0) => judgeFunding(s, { activeDailyBudgets: b, now: NOW }).map((f) => f.code);
  assert.deepEqual(codes({ type: "CREDIT_CARD", last_4: "1100", expiration_month: "10", expiration_year: "2026" }), ["CARD_EXPIRED"]);
  assert.deepEqual(codes({ type: "CREDIT_CARD", last_4: "1100", expiration_month: "12", expiration_year: "2026" }), ["CARD_EXPIRING"], "expires at the end of December: about 47 days");
  assert.deepEqual(codes({ type: "CREDIT_CARD", expiration_month: "12", expiration_year: "2027" }), []);
  assert.deepEqual(codes({ type: "CREDIT_CARD", expiration_month: "12", expiration_year: "2027", daily_spend_limit_micro: 25e6 }, 300), ["DAILY_LIMIT_BELOW_BUDGETS"]);
  assert.deepEqual(codes({ type: "LINE_OF_CREDIT", status: "ACTIVE", available_credit_micro: 5e9, total_budget_micro: 100e9 }, 2000), ["CREDIT_LOW", "CREDIT_DAYS_LEFT"]);
  assert.deepEqual(codes({ type: "LINE_OF_CREDIT", status: "SUSPENDED", available_credit_micro: 90e9, total_budget_micro: 100e9 }), ["CREDIT_NOT_ACTIVE"]);
  assert.deepEqual(codes({ type: "LINE_OF_CREDIT", status: "ACTIVE", available_credit_micro: 90e9, total_budget_micro: 100e9 }, 100), []);
});

test("billing check: reads the account and only its own funding sources, adds up active daily budgets, never writes", async () => {
  const calls = [];
  const client = {
    request: async (m, p) => (calls.push([m, p]), { adaccounts: [{ adaccount: { id: "acc", name: "Shop", status: "ACTIVE", currency: "USD", organization_id: "org", funding_source_ids: ["f1"], billing_type: "REVOLVING" } }] }),
    listPaged: async (path) =>
      path.includes("fundingsources")
        ? { complete: true, items: [{ id: "f1", type: "CREDIT_CARD", name: "Visa", last_4: "4242", expiration_month: "10", expiration_year: "2026", daily_spend_limit_micro: 150e6 }, { id: "other", type: "LINE_OF_CREDIT", status: "SUSPENDED" }] }
        : { complete: true, items: [{ id: "c1", status: "ACTIVE" }, { id: "c2", status: "PAUSED" }] },
    listChildren: async (_e, id) => (id === "c1" ? [{ status: "ACTIVE", daily_budget_micro: 100e6 }, { status: "ACTIVE", daily_budget_micro: 80e6 }, { status: "PAUSED", daily_budget_micro: 999e6 }] : []),
  };
  const r = await billingCheck(client, { adAccountId: "acc", now: NOW });
  assert.equal(r.active_daily_budgets_total, 180);
  assert.deepEqual(r.funding_sources.map((s) => s.id), ["f1"], "a funding source of another account is not shown");
  assert.deepEqual(r.findings.map((f) => f.code).sort(), ["CARD_EXPIRED", "DAILY_LIMIT_BELOW_BUDGETS"]);
  assert.equal(r.verdict, "CRITICAL");
  assert.ok(calls.every(([m]) => m === "GET"));
  const down = await billingCheck({ ...client, request: async () => ({ adaccounts: [{ adaccount: { id: "acc", status: "DISABLED", organization_id: "org", funding_source_ids: ["f1"] } }] }), listPaged: async (p) => { if (p.includes("fundingsources")) throw new Error("403 forbidden"); return { complete: true, items: [] }; } }, { adAccountId: "acc", now: NOW });
  assert.equal(down.findings[0].code, "ACCOUNT_NOT_ACTIVE");
  assert.match(down.funding_sources_unavailable, /403/);
});

test("unused media: a file counts as used when any creative or creative element mentions it", async () => {
  const media = [{ id: U(1), name: "used top snap", type: "VIDEO", created_at: "2026-01-01T00:00:00Z" }, { id: U(2), name: "used tile", type: "IMAGE", created_at: "2026-02-01T00:00:00Z" }, { id: U(3), name: "used by element", type: "IMAGE", created_at: "2026-03-01T00:00:00Z" }, { id: U(4), name: "never used", type: "VIDEO", created_at: "2026-05-01T00:00:00Z" }, { id: U(5), name: "never used old", type: "IMAGE", created_at: "2025-12-01T00:00:00Z" }];
  const lists = { media, creatives: [{ id: "c1", top_snap_media_id: U(1), preview_properties: { preview_media_id: U(2) } }], creative_elements: [{ id: "e1", button_properties: { button_overlay_media_id: U(3).toUpperCase() } }] };
  const client = { listPaged: async (path) => ({ complete: true, items: lists[path.split("/").pop()] }) };
  const r = await unusedMedia(client, { adAccountId: "acc", now: NOW });
  assert.deepEqual(r.unused.map((m) => m.name), ["never used old", "never used"], "oldest first; matching ignores letter case");
  assert.equal(r.unused[0].age_days, 348);
  assert.match(r.how_to_use, /never deletes/);
  const partial = await unusedMedia({ listPaged: async (p) => (p.endsWith("creatives") ? { complete: false, items: [] } : { complete: true, items: p.endsWith("media") ? media : [] }) }, { adAccountId: "acc", now: NOW });
  assert.match(partial.warning, /INCOMPLETE/);
});

test("audience health: not targetable, tiny, stale customer lists, and which segments active squads use", async () => {
  const segs = [
    { id: "a", name: "Buyers", source_type: "FIRST_PARTY", targetable_status: "READY", approximate_number_users: 50000, updated_at: "2026-10-01T00:00:00Z" },
    { id: "b", name: "Old list", source_type: "FIRST_PARTY", targetable_status: "READY", approximate_number_users: 9000, updated_at: "2026-01-01T00:00:00Z" },
    { id: "c", name: "Tiny", source_type: "PIXEL", targetable_status: "TOO_FEW_USERS", approximate_number_users: 120, updated_at: "2026-11-01T00:00:00Z" },
    { id: "d", name: "Cart 30d", source_type: "PIXEL", targetable_status: "READY", approximate_number_users: 80000, updated_at: "2026-11-01T00:00:00Z" },
  ];
  const client = {
    listPaged: async (path) => (path.endsWith("segments") ? { complete: true, items: segs } : { complete: true, items: [{ id: "c1", status: "ACTIVE" }] }),
    listChildren: async () => [{ status: "ACTIVE", targeting: { segments: [{ segment_id: ["a"], operation: "EXCLUDE" }, { segment_id: ["d", "a"], operation: "INCLUDE" }] } }, { status: "PAUSED", targeting: { segments: [{ segment_id: ["b"] }] } }],
  };
  const r = await audienceHealth(client, { adAccountId: "acc", now: NOW });
  assert.deepEqual(r.problems.map((p) => [p.name, p.flags.map((f) => f.code)]), [["Old list", ["STALE"]], ["Tiny", ["NOT_TARGETABLE", "TINY"]]]);
  assert.deepEqual([r.used_by_active_squads, r.unused_audiences, r.active_squads_read], [2, 2, 1]);
});

test("funnel: rates between steps, the weakest step, and missing events are not zeros", () => {
  const f = buildFunnel({ impressions: 100000, swipes: 1000, conversion_view_content: 600, conversion_add_cart: 90, conversion_purchases: 9 });
  assert.deepEqual(f.steps.map((s) => [s.step, s.count, s.of_previous_step_pct]), [["impressions", 100000, undefined], ["swipes", 1000, 1], ["view_content", 600, 60], ["add_to_cart", 90, 15], ["checkout", null, undefined], ["purchases", 9, 10]]);
  assert.equal(f.weakest_step, "add_to_cart -> purchases (10%)", "checkout is skipped because it is missing");
  assert.deepEqual(f.missing_steps, ["checkout"]);
  assert.equal(buildFunnel({}).weakest_step, null);
});

test("funnel report: asks for the funnel fields over the last full local days", async () => {
  let asked;
  const client = { request: async (_m, path, { query }) => ((asked = { path, query }), { total_stats: [{ total_stat: { stats: { impressions: 10, swipes: 5 } } }] }) };
  const r = await funnelReport(client, { adAccountId: "acc", entity: "campaign", id: "c9", offset: "+03:00", days: 7, now: new Date("2026-11-14T09:00:00Z") });
  assert.deepEqual([asked.path, asked.query.granularity, asked.query.start_time, asked.query.end_time], ["/campaigns/c9/stats", "TOTAL", "2026-11-07T00:00:00+03:00", "2026-11-14T00:00:00+03:00"]);
  assert.match(asked.query.fields, /conversion_add_cart/);
  assert.equal(r.steps[1].of_previous_step_pct, 50);
  await assert.rejects(funnelReport(client, { adAccountId: "acc", entity: "x" }), /entity must be/);
});

test("feed status: last completed upload, stale feeds, failed uploads, issues; no credentials shown", async () => {
  const feeds = { cat1: [{ product_feed: { id: "f1", name: "Main feed", status: "ACTIVE", schedule: { url: "ftp://x/y.csv", username: "u", password: "SECRET-PASSWORD", interval_type: "HOURLY", interval_count: 1, timezone: "PST" } } }] };
  const uploads = [
    { feed_upload: { id: "u3", created_at: "2026-11-14T08:00:00Z", status: "FAILED", summary: { issues_summary: { errors: { CAT_FEED_FILE_NO_DATA: 1 } } } } },
    { feed_upload: { id: "u2", created_at: "2026-11-09T08:00:00Z", updated_at: "2026-11-09T08:01:00Z", status: "COMPLETE", summary: { total_items: 120, items_modified: 4, issues_summary: { recommendations: { CAT_RECOMMENDATION_MISSING_APP_INSTALL_PROPERTIES: 120 } } } } },
  ];
  const client = { listPaged: async () => ({ complete: true, items: [{ id: "cat1", name: "Main catalog" }] }), request: async (_m, path) => (path.endsWith("product_feeds") ? { product_feeds: feeds.cat1 } : { feed_uploads: uploads }) };
  const r = await feedStatus(client, { organizationId: "org", now: NOW });
  const f = r.catalogs_detail[0].feeds[0];
  assert.deepEqual(f.last_completed_upload, { at: "2026-11-09T08:01:00Z", total_items: 120, items_modified: 4, days_ago: 5 });
  assert.deepEqual(f.problems, ["The last completed upload was 5 days ago.", "The latest upload is FAILED."]);
  assert.deepEqual(f.upload_issues, ["Upload status FAILED.", "1 x CAT_FEED_FILE_NO_DATA"]);
  assert.equal(r.feeds_with_problems, 1);
  assert.ok(!JSON.stringify(r).includes("SECRET-PASSWORD") && !JSON.stringify(r).includes("ftp://"), "the feed address and password are never shown");
  assert.deepEqual(judgeUpload({ status: "COMPLETE", summary: { issues_summary: { recommendations: { X: 5 } } } }), []);
});

test("audience health: empty audiences are named as such, counted by flag, and the ones in use now come first", async () => {
  const segs = [
    { id: "a", name: "Buyers", source_type: "FIRST_PARTY", targetable_status: "READY", approximate_number_users: 129000, updated_at: "2026-01-01T00:00:00Z" },
    { id: "b", name: "Old engagement", source_type: "ENGAGEMENT", targetable_status: "READY", approximate_number_users: 0, updated_at: "2026-11-01T00:00:00Z" },
    { id: "c", name: "Empty but used", source_type: "PIXEL", targetable_status: "READY", approximate_number_users: 0, updated_at: "2026-11-01T00:00:00Z" },
  ];
  const client = {
    listPaged: async (path) => (path.endsWith("segments") ? { complete: true, items: segs } : { complete: true, items: [{ id: "c1", status: "ACTIVE" }] }),
    listChildren: async () => [{ status: "ACTIVE", targeting: { segments: [{ segment_id: ["a", "c"], operation: "EXCLUDE" }] } }],
  };
  const r = await audienceHealth(client, { adAccountId: "acc", now: NOW });
  assert.deepEqual(r.by_flag, { STALE: 1, EMPTY: 2 });
  assert.deepEqual(r.important_used_by_active_squads.map((p) => p.name), ["Buyers", "Empty but used"], "a stale buyer list that an active ad squad uses is the first thing to look at");
  assert.ok(!r.problems.some((p) => p.flags.some((f) => f.code === "TINY")), "zero is EMPTY, not TINY");
});
