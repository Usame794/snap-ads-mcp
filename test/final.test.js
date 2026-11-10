import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapClient } from "../src/snap.js";
import { BATCH, buildCustomerSegment, normalizeEmail, normalizePhone, readIdentifiers, uploadCustomerList } from "../src/customer-list.js";
import { asyncReportStatus, downloadAsyncReport, startAsyncReport } from "../src/async-report.js";
import { executeDelete, planDelete } from "../src/delete.js";

const env = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };
const tmp = () => mkdtempSync(join(tmpdir(), "fin-"));
const lf = () => join(tmp(), "l.jsonl");
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("email and phone normalisation", () => {
  assert.equal(normalizeEmail("  Ali@Example.COM "), "ali@example.com");
  assert.equal(normalizeEmail("not an email"), null);
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizePhone("0555123456"), "966555123456");
  assert.equal(normalizePhone("+966 55 512 3456"), "966555123456");
  assert.equal(normalizePhone("00966555123456"), "966555123456");
  assert.equal(normalizePhone("555123456"), "966555123456");
  assert.equal(normalizePhone("12"), null);
  assert.equal(normalizePhone("0555123456", "971"), "971555123456");
});

test("reading a CSV: finds the column, hashes, drops invalid and duplicates, never returns raw values", () => {
  const f = join(tmp(), "c.csv");
  writeFileSync(f, '﻿Name,E-mail,Phone\n"Smith, A",A@x.com,0555111111\nB,a@x.com,0555222222\nC,bad,0555333333\nD,d@x.com,\n');
  const r = readIdentifiers(f, { kind: "email" });
  assert.deepEqual([r.column, r.rows, r.valid, r.invalid, r.duplicates], ["e-mail", 4, 2, 1, 1]);
  assert.deepEqual(r.hashes.sort(), [sha("a@x.com"), sha("d@x.com")].sort());
  assert.ok(!JSON.stringify(r).includes("@x.com"), "no raw email in the result");
  const p = readIdentifiers(f, { kind: "phone" });
  assert.equal(p.valid, 3);
  assert.ok(p.hashes.includes(sha("966555111111")));
  assert.throws(() => readIdentifiers(f, { kind: "email", column: "Nope" }), /Could not find/);
  assert.throws(() => readIdentifiers(join(tmp(), "none.csv"), { kind: "email" }), /not found/);
  const one = join(tmp(), "h.csv");
  writeFileSync(one, "email\n");
  assert.throws(() => readIdentifiers(one, { kind: "email" }), /at least one data row/);
});

test("customer segment is FIRST_PARTY; upload sends hashes in batches and reports partial failure", async () => {
  assert.equal(buildCustomerSegment({ adAccountId: "a", name: "List one" }).source_type, "FIRST_PARTY");
  assert.throws(() => buildCustomerSegment({ adAccountId: "a", name: "ab" }), /3 characters/);
  const posts = [];
  let fail = false;
  const fetchImpl = async (url, opts = {}) => {
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (String(url).includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    posts.push({ u: String(url), body: JSON.parse(opts.body) });
    if (fail && posts.length === 2) return json({ request_status: "ERROR", debug_message: "boom" }, 400);
    return json({ request_status: "SUCCESS" });
  };
  const client = new SnapClient({ env, fetchImpl });
  const hashes = Array.from({ length: BATCH * 2 + 5 }, (_, i) => sha("u" + i));
  const sent = await uploadCustomerList({ client, segmentId: "seg", hashes, kind: "email", logFile: lf() });
  assert.equal(sent, hashes.length);
  assert.equal(posts.length, 3);
  assert.match(posts[0].u, /\/segments\/seg\/users$/);
  assert.deepEqual(posts[0].body.users[0].schema, ["EMAIL_SHA256"]);
  assert.deepEqual(posts[0].body.users[0].data[0], [hashes[0]]);
  posts.length = 0;
  fail = true;
  await assert.rejects(() => uploadCustomerList({ client, segmentId: "seg", hashes, kind: "phone", logFile: lf() }), /10000 identifiers were uploaded/);
});

test("async reports: start, status, download to a file", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => "id,spend\n1,10\n2,20\n" });
    if (u.hostname.includes("accounts")) return json({ access_token: "t", expires_in: 1800 });
    if (u.hostname === "files.example") return json({});
    calls.push({ path: u.pathname.replace(/^\/v1/, ""), q: Object.fromEntries(u.searchParams) });
    if (u.pathname.endsWith("/stats")) return json({ async_stats_reports: [{ async_stats_report: { report_run_id: "RUN1", async_status: "STARTED" } }] });
    return json({ async_stats_report_results: [{ async_stats_report_result: { async_status: calls.length > 2 ? "COMPLETED" : "RUNNING", result: "https://files.example/r.csv" } }] });
  };
  const client = new SnapClient({ env, fetchImpl });
  const s = await startAsyncReport(client, { entity: "adaccount", id: "a", start_time: "2026-10-01T00:00:00+03:00", end_time: "2026-10-05T00:00:00+03:00", breakdown: "campaign" });
  assert.deepEqual(s, { report_run_id: "RUN1", status: "STARTED" });
  assert.equal(calls[0].path, "/adaccounts/a/stats");
  assert.equal(calls[0].q.async, "true");
  assert.equal(calls[0].q.async_format, "csv");
  assert.equal((await asyncReportStatus(client, { entity: "adaccount", id: "a", report_run_id: "RUN1" })).status, "RUNNING");
  const dir = tmp();
  const early = await downloadAsyncReport(client, { entity: "adaccount", id: "a", report_run_id: "RUN1", fetchImpl, dir });
  assert.equal(early.downloaded, true);
  assert.equal(readFileSync(early.path, "utf8").startsWith("id,spend"), true);
  assert.equal(early.rows, 2);
  assert.match(early.path, /\.csv$/);
  await assert.rejects(() => startAsyncReport(client, { entity: "nope", id: "a", start_time: "x", end_time: "y" }), /entity/);
});

function deleteApi({ status = "PAUSED", spend = 0, activeSquads = 0, adsInSquad = 0 }) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (u.hostname.includes("accounts")) return json({ access_token: "t", expires_in: 1800 });
    const path = u.pathname.replace(/^\/v1/, "");
    calls.push({ m: opts.method ?? "GET", path });
    if (opts.method === "DELETE") return json({ request_status: "SUCCESS" });
    if (path.endsWith("/stats")) return json({ total_stats: [{ total_stat: { stats: { spend: spend * 1e6 } } }] });
    if (path === "/campaigns/c1") return json({ campaigns: [{ sub_request_status: "SUCCESS", campaign: { id: "c1", name: "Camp One", status } }] });
    if (path === "/adsquads/s1") return json({ adsquads: [{ sub_request_status: "SUCCESS", adsquad: { id: "s1", name: "Squad One", status, campaign_id: "c1" } }] });
    if (path === "/campaigns/c1/adsquads") return json({ adsquads: Array.from({ length: 2 }, (_, i) => ({ sub_request_status: "SUCCESS", adsquad: { id: "q" + i, name: "q", status: i < activeSquads ? "ACTIVE" : "PAUSED" } })) });
    if (path === "/adsquads/s1/ads") return json({ ads: Array.from({ length: adsInSquad }, (_, i) => ({ sub_request_status: "SUCCESS", ad: { id: "a" + i } })) });
    return json({}, 404);
  };
  return { calls, client: new SnapClient({ env, fetchImpl }) };
}
const NOW = new Date("2026-10-27T12:00:00Z");

test("delete: blocked when active, recently spent, or has active children", async () => {
  const active = await planDelete(deleteApi({ status: "ACTIVE" }).client, { entity: "campaign", id: "c1", confirmName: "Camp One", now: NOW });
  assert.match(active.blockers[0], /ACTIVE; pause it first/);
  const spent = await planDelete(deleteApi({ spend: 12.5 }).client, { entity: "adsquad", id: "s1", confirmName: "Squad One", now: NOW });
  assert.match(spent.blockers[0], /\$12.5 in the last 30 days/);
  const kids = await planDelete(deleteApi({ activeSquads: 1 }).client, { entity: "campaign", id: "c1", confirmName: "Camp One", now: NOW });
  assert.match(kids.blockers.join(" "), /1 of its ad squads are ACTIVE/);
  await assert.rejects(() => planDelete(deleteApi({}).client, { entity: "account", id: "x" }), /entity must be/);
});

test("delete: needs the exact name, then deletes and logs; a clean item shows what goes with it", async () => {
  const { calls, client } = deleteApi({ adsInSquad: 3 });
  const plan = await planDelete(client, { entity: "adsquad", id: "s1", confirmName: "wrong", now: NOW });
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.nameOk, false);
  assert.deepEqual(plan.summary.will_also_remove, { ads: 3 });
  await assert.rejects(() => executeDelete({ client, entity: "adsquad", id: "s1", plan, logFile: lf() }), /exactly the name/);
  assert.ok(!calls.some((c) => c.m === "DELETE"));
  const ok = await planDelete(client, { entity: "adsquad", id: "s1", confirmName: "Squad One", now: NOW });
  const file = lf();
  const r = await executeDelete({ client, entity: "adsquad", id: "s1", plan: ok, logFile: file });
  assert.equal(r.deleted, true);
  assert.deepEqual(calls.filter((c) => c.m === "DELETE").map((c) => c.path), ["/adsquads/s1"]);
  assert.match(readFileSync(file, "utf8"), /deleted adsquad \\"Squad One\\"/);
  const blocked = await planDelete(deleteApi({ spend: 5 }).client, { entity: "adsquad", id: "s1", confirmName: "Squad One", now: NOW });
  await assert.rejects(() => executeDelete({ client, entity: "adsquad", id: "s1", plan: blocked }), /Refusing to delete/);
});
