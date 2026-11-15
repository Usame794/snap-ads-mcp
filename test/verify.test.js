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
