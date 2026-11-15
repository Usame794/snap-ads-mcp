// The verify command: it only calls read-only tools, forces read-only mode, hides ids and tokens, and reports honestly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksFor, runVerify, tidy } from "../src/verify.js";
import { SnapClient } from "../src/snap.js";
import { ACC, fakeSnap, sampleWorld } from "./helpers/harness.js";

const ENV = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r", SNAP_AD_ACCOUNT_ID: ACC, SNAP_DEFAULT_COUNTRY: "sa", SNAP_BRAND_PROFILE_ID: "p", SNAP_LOG_FILE: join(mkdtempSync(join(tmpdir(), "verify-")), "log.jsonl") };

test("tidy: ids are shortened and long secret-looking strings are hidden", () => {
  assert.equal(tidy("failed for 12345678-1234-1234-1234-123456789abc ok"), "failed for 12345678… ok");
  assert.ok(!tidy(`token ${"A".repeat(60)} end`).includes("AAAA"));
  assert.ok(tidy("x".repeat(500)).length <= 220);
});

test("every check names a read-only tool that exists, and settings-dependent ones are skipped without the setting", async () => {
  const snap = fakeSnap(sampleWorld());
  const lines = [];
  const client = new SnapClient({ env: ENV, fetchImpl: snap.fetchImpl, sleep: async () => {} });
  const { results } = await runVerify({ client, env: { ...ENV, SNAP_DEFAULT_COUNTRY: "" }, log: (l) => lines.push(l) });
  const names = checksFor({ start: "s", end: "e", hasPixel: true, hasCountry: true }).map((c) => c.tool);
  assert.equal(new Set(names).size, names.length, "no tool twice");
  assert.deepEqual(results.map((r) => r.tool), checksFor({ start: "s", end: "e", hasPixel: false, hasCountry: false }).map((c) => c.tool));
  assert.ok(results.every((r) => r.status !== "SKIP" || /needs SNAP_|not read-only|not available/.test(r.detail)), "a skip always says why");
  assert.match(results.find((r) => r.tool === "snap_audience_size").detail, /needs SNAP_DEFAULT_COUNTRY/);
  assert.match(results.find((r) => r.tool === "snap_pixel_health").detail, /needs SNAP_PIXEL_ID/);
  assert.ok(!results.some((r) => r.status === "SKIP" && r.detail === "tool is not available"), "no check refers to a tool that does not exist");
  assert.equal(results.find((r) => r.tool === "snap_ping").status, "OK");
  assert.match(lines.at(-1) + lines.at(-2), /worked/);
});

test("it never changes anything: only GETs and the two read-only POSTs, even with write settings on", async () => {
  const snap = fakeSnap(sampleWorld());
  const client = new SnapClient({ env: { ...ENV, SNAP_PIXEL_ID: "pix-1" }, fetchImpl: snap.fetchImpl, sleep: async () => {} });
  await runVerify({ client, env: { ...ENV, SNAP_PIXEL_ID: "pix-1", SNAP_READ_ONLY: "0" }, log: () => {} });
  const posts = snap.writes().map((w) => `${w.method} ${w.path.replace(ACC, ":account")}`);
  const allowed = [/^POST \/:account\/audience_size_v2$/, /^POST \/adaccounts\/:account\/audience_size_v2$/, /^POST \/adaccounts\/:account\/targeting_insights$/];
  assert.deepEqual(posts.filter((p) => !allowed.some((re) => re.test(p))), [], "no other non-GET request was sent");
});

test("failures are reported with a short, tidy reason and counted", async () => {
  const client = { request: async () => { throw new Error("Snap API GET /x failed (403): not allowed for 12345678-1234-1234-1234-123456789abc"); }, listPaged: async () => { throw new Error("boom"); }, listChildren: async () => [], getEntity: async () => ({}) , env: ENV, fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) };
  const lines = [];
  const { results, failed } = await runVerify({ client, env: ENV, log: (l) => lines.push(l) });
  assert.ok(failed > 5);
  const ping = results.find((r) => r.tool === "snap_ping");
  assert.equal(ping.status, "FAIL");
  assert.match(ping.detail, /not allowed for 12345678…/);
  assert.ok(lines.some((l) => l.startsWith("  ✗ snap_ping")));
  assert.match(lines.at(-1), /Copy everything above/);
});

test("Snap refusing the normal login for the Conversions API test tools is a skip that names the setting, not a failure", async () => {
  const snap = fakeSnap(sampleWorld());
  const base = snap.fetchImpl;
  const fetchImpl = async (url, opts) => (new URL(String(url)).hostname === "tr.snapchat.com" ? { ok: false, status: 401, json: async () => ({ reason: "Invalid access token" }), headers: { get: () => null } } : base(url, opts));
  const client = new SnapClient({ env: { ...ENV, SNAP_PIXEL_ID: "pix-1" }, fetchImpl, sleep: async () => {} });
  const { results } = await runVerify({ client, env: { ...ENV, SNAP_PIXEL_ID: "pix-1" }, log: () => {} });
  const capi = results.find((r) => r.tool === "snap_capi_status");
  assert.equal(capi.status, "SKIP");
  assert.match(capi.detail, /needs SNAP_CAPI_TOKEN/);
  assert.ok(results.find((r) => r.tool === "snap_ping").status === "OK", "everything else is still run");
});

test("verify --details lists the specifics, without query strings or full ids", async () => {
  const { DETAILS } = await import("../src/verify.js");
  const lines = DETAILS.snap_check_landing_pages({ problems: [{ verdict: "BROKEN", status: 404, url: "https://shop.example/p/1?utm_source=x&token=SECRETSECRET", detail: "Page not found (404)", ads: [{ ad: "Ad one" }, { ad: "Ad two" }], missing_params: ["utm_content"] }] });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^BROKEN 404 shop\.example\/p\/1: Page not found \(404\) \(missing utm_content\) \[2 ad\(s\), e\.g\. Ad one\]$/);
  assert.ok(!lines[0].includes("SECRET") && !lines[0].includes("utm_source"));
  assert.deepEqual(DETAILS.snap_pixel_health({ top_priority_issues: ["Event quality is low", { code: "X" }] }), ["Event quality is low", '{"code":"X"}']);
  assert.match(DETAILS.snap_catalog_feed_status({ catalogs_detail: [{ catalog: "Main", feeds: [{ name: "F", problems: ["The latest upload is FAILED."], upload_errors: 1, upload_issues: ["1 x CAT_FEED_FILE_NO_DATA"] }, { name: "OK", problems: [], upload_errors: 0 }] }] })[0], /^Main \/ F: The latest upload is FAILED\.; 1 x CAT_FEED_FILE_NO_DATA$/);
  const snap = fakeSnap(sampleWorld());
  const client = new SnapClient({ env: ENV, fetchImpl: snap.fetchImpl, sleep: async () => {} });
  const out = [];
  await runVerify({ client, env: ENV, details: true, log: (l) => out.push(l) });
  assert.ok(out.includes("Details"));
  const plain = [];
  await runVerify({ client, env: ENV, log: (l) => plain.push(l) });
  assert.ok(!plain.includes("Details"), "details only when asked for");
});

test("verify: a rate-limited Ads Gallery is a skip, a blocked link is shown as blocked, and upper-case error codes stay readable", async () => {
  const { DETAILS, tidy } = await import("../src/verify.js");
  assert.equal(tidy("1 x CAT_VALIDATION_ERROR_PRODUCT_IMAGE_URL_NOT_REACHABLE_FOR_ITEMS_IN_FEED"), "1 x CAT_VALIDATION_ERROR_PRODUCT_IMAGE_URL_NOT_REACHABLE_FOR_ITEMS_IN_FEED");
  assert.equal(tidy(`token ${"aB3".repeat(20)} end`), "token [hidden] end");
  const lines = DETAILS.snap_check_landing_pages({ problems: [], could_not_check: [{ url: "https://shop.example/%D8%B3?x=1", status: 403, ads: [{ ad: "Ad one" }] }] });
  assert.match(lines[0], /^BLOCKED 403 shop\.example\/س: the website answered with a block/);
  const audience = DETAILS.snap_audience_health({ important_used_by_active_squads: [{ name: "Buyers", source_type: "FIRST_PARTY", size: 129000, used_by_active_squads: 12, flags: [{ code: "STALE" }] }], by_flag: { EMPTY: 40, STALE: 2 } });
  assert.deepEqual(audience, ["USED NOW by 12 active ad squad(s): Buyers (FIRST_PARTY, 129000 people): STALE", "EMPTY: 40 audience(s)", "STALE: 2 audience(s)"]);
});
