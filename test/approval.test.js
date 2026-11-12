import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore, digest } from "../src/approval.js";
import { auditIntent, auditResult, readLogStrict, redact, windowStartMicro } from "../src/audit-log.js";
import { setEnvValue } from "../src/env.js";

test("approval: a token works once, for the same tool and the same binding only", () => {
  let now = 1_000_000;
  const store = new ApprovalStore({ ttlMs: 60_000, now: () => now });
  const binding = digest({ a: 1, b: [2, { c: 3 }] });
  assert.equal(binding, digest({ b: [2, { c: 3 }], a: 1 }), "key order does not matter");
  assert.notEqual(binding, digest({ a: 1, b: [2, { c: 4 }] }));

  assert.throws(() => store.consume("t", undefined, binding), /needs the approval_token/);
  assert.throws(() => store.consume("t", "apr_made_up", binding), /Unknown approval_token/);

  const a = store.issue("t", binding);
  assert.match(a.token, /^apr_/);
  assert.equal(a.expires_in_seconds, 60);
  store.consume("t", a.token, binding);
  assert.throws(() => store.consume("t", a.token, binding), /already used/);

  const other = store.issue("t", binding);
  assert.throws(() => store.consume("other_tool", other.token, binding), /different tool/);
  assert.throws(() => store.consume("t", other.token, binding), /already used/, "a failed attempt burns the token too");

  const changed = store.issue("t", binding);
  assert.throws(() => store.consume("t", changed.token, digest({ a: 2 })), /changed since the preview/);

  const late = store.issue("t", binding);
  now += 60_001;
  assert.throws(() => store.consume("t", late.token, binding), /expired/);
});

test("approval: tokens are unpredictable and the store stays bounded", () => {
  const store = new ApprovalStore({ max: 5 });
  const tokens = new Set(Array.from({ length: 50 }, () => store.issue("t", "b").token));
  assert.equal(tokens.size, 50);
  assert.ok(store.tokens.size <= 6);
});

test("approval: identical create-type requests are remembered for the repeat window", () => {
  let now = 0;
  const store = new ApprovalStore({ repeatWindowMs: 10_000, now: () => now });
  assert.equal(store.recentRepeat("d"), null);
  store.recordExecuted("d", { id: 1 });
  now = 4000;
  assert.equal(store.recentRepeat("d").seconds_ago, 4);
  now = 10_001;
  assert.equal(store.recentRepeat("d"), null);
});

test("audit log: credentials are removed and ad codes masked", () => {
  const r = redact({ ad_code: "adcode_12345678-1234-1234-1234-123456789abc", client_secret: "shh", nested: { refresh_token: "r", Authorization: "Bearer abcdefghijkl", note: "sent Bearer abcdefghijklmnop to host" }, list: ["adcode_12345678-1234-1234-1234-123456789abc"], n: 5, ok: true, long: "x".repeat(3000) });
  const flat = JSON.stringify(r);
  assert.ok(!flat.includes("123456789abc") && !flat.includes("shh") && !flat.includes("abcdefghijkl"));
  assert.equal(r.ad_code, "adcode_…9abc");
  assert.equal(r.client_secret, "[redacted]");
  assert.equal(r.nested.refresh_token, "[redacted]");
  assert.equal(r.n, 5);
  assert.ok(r.long.length < 2100);
});

test("audit log: intent is written before anything runs, and an unwritable log stops the operation", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-"));
  const file = join(dir, "log.jsonl");
  const id = auditIntent(file, { tool: "snap_x", account: "acc", targets: ["s1"], params: { approval_token: "apr_x", value: 3 }, preview: { change: "a -> b" } });
  assert.deepEqual(auditResult(file, { event_id: id, tool: "snap_x", account: "acc", targets: ["s1"], ok: true, result: { applied: true } }), { logged: true });
  const rows = readLogStrict(file);
  assert.deepEqual(rows.map((r) => [r.kind, r.phase, r.event_id, r.tool, r.account, r.target_ids[0]]), [["audit", "intent", id, "snap_x", "acc", "s1"], ["audit", "result", id, "snap_x", "acc", "s1"]]);
  assert.equal(rows[0].params.approval_token, "[redacted]");
  assert.equal(rows[1].status, "ok");
  assert.ok(!Number.isNaN(Date.parse(rows[0].at)));
  assert.equal(statSync(file).mode & 0o077, 0, "the log is private to the user");

  const missing = join(dir, "no-such-dir", "log.jsonl");
  assert.throws(() => auditIntent(missing, { tool: "snap_x", params: {} }), /refusing to run snap_x/);
  // after the fact a failed write is reported, not thrown
  const res = auditResult(missing, { event_id: "e", tool: "snap_x", ok: false, error: "boom" });
  assert.equal(res.logged, false);
});

test("audit log: a damaged log is an error for safety decisions, a missing one is empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-"));
  const file = join(dir, "log.jsonl");
  assert.deepEqual(readLogStrict(file), []);
  writeFileSync(file, '{"at":"2026-01-01T00:00:00Z"}\n{not json\n');
  assert.throws(() => readLogStrict(file), /line 2 is damaged/);
  assert.throws(() => windowStartMicro(file, "s", "daily_budget_micro"), /damaged/);
});

test("audit log: window start is the earliest logged value inside the last 24 hours", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-"));
  const file = join(dir, "log.jsonl");
  const now = Date.parse("2026-11-10T12:00:00Z");
  const row = (at, id, before) => JSON.stringify({ at, id, entity: "adsquad", before: { daily_budget_micro: before }, patch: {} });
  writeFileSync(file, [row("2026-11-08T12:00:00Z", "s", 1e6), row("2026-11-10T01:00:00Z", "s", 10e6), row("2026-11-10T02:00:00Z", "other", 99e6), row("2026-11-10T03:00:00Z", "s", 20e6), JSON.stringify({ at: "2026-11-10T04:00:00Z", kind: "audit", phase: "intent" })].join("\n") + "\n");
  assert.equal(windowStartMicro(file, "s", "daily_budget_micro", { now }), 10e6);
  assert.equal(windowStartMicro(file, "s", "bid_micro", { now }), null);
  assert.equal(windowStartMicro(file, "none", "daily_budget_micro", { now }), null);
});

test("env: saving a value tightens an existing world-readable .env to 0600 and never prints it", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-"));
  const file = join(dir, ".env");
  writeFileSync(file, "A=1\n");
  chmodSync(file, 0o644);
  setEnvValue("SNAP_CLIENT_SECRET", "value-123", file);
  assert.equal((statSync(file).mode & 0o777).toString(8), "600");
  assert.match(readFileSync(file, "utf8"), /^A=1\nSNAP_CLIENT_SECRET=value-123\n$/);
});

test("a refused confirmation names WHICH fields changed, never their values", async () => {
  const { fingerprintOf, explainChange } = await import("../src/approval.js");
  const before = { request: "r1", state: fingerprintOf({ current: { id: "c1", name: "A", status: "PAUSED", secret_like: "hunter2", targeting: { geos: [{ country_code: "sa" }] } }, impact: null }) };
  const same = { request: "r1", state: fingerprintOf({ current: { id: "c1", name: "A", status: "PAUSED", secret_like: "hunter2", targeting: { geos: [{ country_code: "sa" }] } }, impact: null }) };
  assert.equal(explainChange(before, same), " Reason: the previewed state could not be compared.", "nothing differs: no false field names");
  const edited = { request: "r1", state: fingerprintOf({ current: { id: "c1", name: "B", status: "PAUSED", secret_like: "hunter3", targeting: { geos: [{ country_code: "ae" }] } }, impact: null }) };
  const text = explainChange(before, edited);
  assert.match(text, /changed in 3 place\(s\): current\.name, current\.secret_like, current\.targeting\.geos\[0\]\.country_code/);
  assert.ok(!/hunter|"B"|ae\b/.test(text.replace("current.targeting.geos[0].country_code", "")), "no values in the explanation");
  assert.match(explainChange(before, { ...edited, request: "r2" }), /arguments of this call are not the same/);
  assert.equal(explainChange(null, edited), "");
  // arrays are matched by id, so a reordering is not reported as a change of every row
  const a = { request: "r", state: fingerprintOf({ items: [{ id: "x", v: 1 }, { id: "y", v: 2 }] }) };
  const b = { request: "r", state: fingerprintOf({ items: [{ id: "y", v: 2 }, { id: "x", v: 1 }] }) };
  assert.equal(explainChange(a, b), " Reason: the previewed state could not be compared.");
  // big states are bounded
  const big = fingerprintOf({ list: Array.from({ length: 2000 }, (_, i) => ({ id: i, v: i })) });
  assert.ok(Object.keys(big).length <= 405);
});

test("the store passes the reason through on a mismatch", () => {
  const store = new ApprovalStore();
  const { token } = store.issue("t", "bind-1", { request: "r", state: { "current.status": "aaaa" } });
  assert.throws(() => store.consume("t", token, "bind-2", { request: "r", state: { "current.status": "bbbb" } }), /changed since the preview.*Reason: the target changed in 1 place\(s\): current\.status\./);
});

test("stabilizeState drops what Snap computes itself and ignores list order, but keeps real edits visible", async () => {
  const { stabilizeState, digest } = await import("../src/approval.js");
  const a = { current: { id: "c1", name: "A", updated_at: "t1", delivery_status: ["X", "Y", "Z"], review_status: "APPROVED", ids: ["b", "a"], squads: [{ id: "s2", n: 2 }, { id: "s1", n: 1 }] } };
  const reordered = { current: { id: "c1", name: "A", updated_at: "t1", delivery_status: ["Z", "X"], review_status: "REJECTED", ids: ["a", "b"], squads: [{ id: "s1", n: 1 }, { id: "s2", n: 2 }] } };
  assert.equal(digest(stabilizeState(a)), digest(stabilizeState(reordered)), "derived fields and list order do not matter");
  for (const edit of [{ name: "B" }, { updated_at: "t2" }, { ids: ["a", "c"] }, { squads: [{ id: "s1", n: 1 }, { id: "s2", n: 3 }] }, { squads: [{ id: "s1", n: 1 }] }]) {
    assert.notEqual(digest(stabilizeState(a)), digest(stabilizeState({ current: { ...a.current, ...edit } })), JSON.stringify(edit));
  }
  assert.deepEqual(stabilizeState({ delivery_status: ["A"], keep: 1, nested: { review_status_reasons: ["r"], keep: [3, 1, 2] } }), { keep: 1, nested: { keep: [1, 2, 3] } });
  assert.equal(stabilizeState(null), null);
});
