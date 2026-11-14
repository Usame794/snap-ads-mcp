// Regression tests for the findings of the final code review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { planUndo, readLog, undoableEntries } from "../src/changes.js";
import { remember, safetyEntries, windowStartMicro } from "../src/audit-log.js";
import { ApprovalStore } from "../src/approval.js";
import { SnapClient } from "../src/snap.js";
import { checkDownloadUrl, downloadAsyncReport } from "../src/async-report.js";
import { CTAS, buildCreative } from "../src/influencer.js";
import { ROOT } from "../src/env.js";
import { setup } from "./helpers/harness.js";

const tmp = () => mkdtempSync(join(tmpdir(), "rv-"));

test("undo of a targeting change is not refused because Snap returned the lists in another order", () => {
  const after = { geos: [{ country_code: "sa" }, { country_code: "ae" }], segments: [{ segment_id: ["1", "2"], operation: "EXCLUDE" }] };
  const entry = { entity: "adsquad", id: "s", change: "targeting", patch: { targeting: after }, before: { targeting: { geos: [{ country_code: "sa" }] } }, after: { targeting: after } };
  const reordered = { targeting: { geos: [{ country_code: "ae" }, { country_code: "sa" }], segments: [{ operation: "EXCLUDE", segment_id: ["2", "1"] }] } };
  assert.deepEqual(planUndo(entry, { id: "s", ...reordered }).patch, { targeting: { geos: [{ country_code: "sa" }] } });
  // a real change is still caught
  const edited = { targeting: { geos: [{ country_code: "kw" }] } };
  assert.throws(() => planUndo(entry, { id: "s", ...edited }), /changed again/);
});

test("a damaged change log is reported, not shown as empty; undo refuses instead of saying there is nothing", () => {
  const file = join(tmp(), "log.jsonl");
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), entity: "adsquad", id: "s", change: "x", verified: true, patch: { name: "B" }, before: { name: "Aaa" }, after: { name: "B" } }) + "\n{broken\n");
  const shown = readLog(20, file);
  assert.equal(shown[0].id, "s", "good lines are still shown");
  assert.match(shown.at(-1).warning, /1 damaged line/);
  assert.throws(() => undoableEntries(file), /damaged/);
  assert.deepEqual(readLog(20, join(tmp(), "missing.jsonl")), []);
});

test("snap_change_log and snap_undo surface a damaged log through the tools", async () => {
  const t = await setup();
  writeFileSync(t.logFile, "{not json\n");
  assert.match(JSON.stringify((await t.call("snap_change_log", {})).data), /damaged line/);
  assert.match((await t.call("snap_undo", {})).error, /damaged/);
  await t.close();
});

test("the log is parsed once per change of the file, and new lines are always seen", () => {
  const file = join(tmp(), "log.jsonl");
  const row = (id, before) => JSON.stringify({ at: new Date().toISOString(), id, entity: "adsquad", before: { daily_budget_micro: before }, patch: {} }) + "\n";
  writeFileSync(file, row("a", 10e6));
  const first = safetyEntries(file);
  assert.equal(safetyEntries(file), first, "unchanged file: the same parsed entries are reused");
  appendFileSync(file, row("b", 20e6));
  assert.equal(windowStartMicro(file, "b", "daily_budget_micro"), 20e6, "a new line is picked up");
  assert.equal(safetyEntries(file).length, 2);
});

test("the in-memory copy keeps only the last ~25 hours", () => {
  const file = join(tmp(), "mem.jsonl");
  const old = new Date(Date.now() - 30 * 3_600_000).toISOString();
  remember(file, { at: old, kind: "audit", phase: "intent", event_id: "old", added_daily_budget: 999 });
  remember(file, { at: new Date().toISOString(), kind: "audit", phase: "intent", event_id: "new", added_daily_budget: 5 });
  assert.deepEqual(safetyEntries(file).map((e) => e.event_id), ["new"]);
});

test("a token confirmed after it expired says 'expired', not 'unknown', for an hour", () => {
  let now = 0;
  const store = new ApprovalStore({ ttlMs: 600_000, now: () => now });
  const { token } = store.issue("t", "b");
  now = 600_000 + 120_000; // 2 minutes after expiry, and a prune runs
  store.issue("t", "other");
  assert.throws(() => store.consume("t", token, "b"), /expired/);
});

test("upload gets a fresh token once on 401, like every other request", async () => {
  let tokens = 0;
  const seen = [];
  const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b, headers: { get: () => null } });
  const fetchImpl = async (url, opts) => {
    if (String(url).includes("accounts.snapchat.com")) return json({ access_token: `tok${++tokens}`, expires_in: 1800 });
    seen.push(opts.headers.Authorization);
    return seen.length === 1 ? json({ request_status: "ERROR" }, 401) : json({ request_status: "SUCCESS" });
  };
  const client = new SnapClient({ env: { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" }, fetchImpl });
  await client.upload("/media/m/upload", new FormData());
  assert.deepEqual(seen, ["Bearer tok1", "Bearer tok2"]);
});

test("the report download only follows a public https link", async () => {
  for (const bad of ["http://example.com/r.csv", "https://127.0.0.1/r.csv", "https://localhost/r.csv", "https://[::1]/r.csv", "https://intranet/r.csv", "https://db.internal/r.csv", "file:///etc/passwd", "not a url"]) {
    assert.throws(() => checkDownloadUrl(bad), /not (a public https address|a valid URL)/, bad);
  }
  assert.equal(checkDownloadUrl("https://storage.example.com/reports/r.csv?sig=1").hostname, "storage.example.com");
  let fetched = false;
  const client = { request: async () => ({ async_stats_report: { async_status: "COMPLETED", result: "http://169.254.169.254/latest" } }) };
  await assert.rejects(() => downloadAsyncReport(client, { entity: "campaign", id: "c", report_run_id: "r", fetchImpl: async () => ((fetched = true), {}), dir: tmp() }), /public https/);
  assert.equal(fetched, false, "nothing is fetched");
});

test("call to action list has no duplicates and the error lists each once", () => {
  assert.equal(new Set(CTAS).size, CTAS.length);
  assert.throws(() => buildCreative({ adAccountId: "a", profileId: "p", mediaId: "m", name: "n", headline: "h", url: "https://x.com", callToAction: "NOPE" }), (e) => (e.message.match(/SHOP_NOW/g) ?? []).length === 1);
});

test("the weekly report names a missing account id instead of calling the API with 'undefined'", () => {
  const dir = tmp();
  const env = join(dir, ".env.empty");
  writeFileSync(env, "SNAP_CLIENT_ID=i\n");
  const r = spawnSync(process.execPath, ["scripts/weekly-report.js"], { cwd: ROOT, encoding: "utf8", timeout: 20000, env: { PATH: process.env.PATH, SNAP_ENV_FILE: env } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SNAP_AD_ACCOUNT_ID is not set in .*\.env\.empty/);
});
