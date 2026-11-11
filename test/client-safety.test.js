import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapClient } from "../src/snap.js";
import { applyChange, planStatus } from "../src/changes.js";
import { executeBulkStatus } from "../src/bulk.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };
const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b, headers: { get: () => null } });
// A connection that never answers. (The keep-alive timer stands in for the open socket a real stalled request would hold.)
const stall = (signal) =>
  new Promise((_res, rej) => {
    const keepAlive = setTimeout(() => {}, 5000);
    signal.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      rej(signal.reason);
    });
  });
const token = (u) => (String(u).includes("accounts.snapchat.com") ? json({ access_token: "t", expires_in: 1800 }) : null);

test("every request carries a deadline; a stalled write fails once with OUTCOME UNKNOWN and is not re-sent", async () => {
  let writes = 0;
  const fetchImpl = (url, opts) => {
    const t = token(url);
    if (t) return Promise.resolve(t);
    assert.ok(opts.signal instanceof AbortSignal, "a signal is always passed");
    writes++;
    return stall(opts.signal);
  };
  const client = new SnapClient({ env, fetchImpl, timeoutMs: 30, sleep: async () => {} });
  await assert.rejects(() => client.request("PUT", "/campaigns/c/adsquads", { body: { adsquads: [{}] } }), /timed out after .*OUTCOME UNKNOWN/);
  assert.equal(writes, 1);
});

test("a stalled read is retried and then fails; it never hangs", async () => {
  let reads = 0;
  const fetchImpl = (url, opts) => {
    const t = token(url);
    if (t) return Promise.resolve(t);
    reads++;
    return stall(opts.signal);
  };
  const client = new SnapClient({ env, fetchImpl, timeoutMs: 20, sleep: async () => {} });
  await assert.rejects(() => client.request("GET", "/campaigns/c"));
  assert.equal(reads, 4);
});

test("listChildren follows every page and refuses an incomplete list", async () => {
  const page = (ids, next) => json({ adsquads: ids.map((id) => ({ sub_request_status: "SUCCESS", adsquad: { id } })), ...(next ? { paging: { next_link: `https://adsapi.snapchat.com/v1/campaigns/c/adsquads?cursor=${next}` } } : {}) });
  const seen = [];
  const fetchImpl = async (url) => {
    const t = token(url);
    if (t) return t;
    const cursor = new URL(String(url)).searchParams.get("cursor");
    seen.push(cursor);
    if (!cursor) return page(["a", "b"], "p2");
    if (cursor === "p2") return page(["c"], "p3");
    return page(["d"]);
  };
  const client = new SnapClient({ env, fetchImpl });
  assert.deepEqual((await client.listChildren("campaign", "c", "adsquad")).map((s) => s.id), ["a", "b", "c", "d"]);
  assert.deepEqual(seen, [null, "p2", "p3"]);

  const stuck = new SnapClient({ env, fetchImpl: async (url) => token(url) ?? page(["a"], "same") });
  await assert.rejects(() => stuck.listChildren("campaign", "c", "adsquad"), /cannot be followed|incomplete/);
  const broken = new SnapClient({ env, fetchImpl: async (url) => token(url) ?? json({ adsquads: [], paging: { next_link: "not a url" } }) });
  await assert.rejects(() => broken.listChildren("campaign", "c", "adsquad"), /cannot be followed/);
});

test("upload never sends the bearer token to a host other than the API", async () => {
  const hosts = [];
  const fetchImpl = async (url) => {
    const t = token(url);
    if (t) return t;
    hosts.push(new URL(String(url)).host);
    return json({ request_status: "SUCCESS" });
  };
  const client = new SnapClient({ env, fetchImpl });
  for (const path of [".evil.example/us/v1/x", "@evil.example/x", "//evil.example/x", "https://evil.example/x", undefined]) {
    await assert.rejects(() => client.upload(path, new FormData(), { absolute: true }), /refusing to send credentials/, String(path));
  }
  await client.upload("/us/v1/media/m/multipart-upload-v2?action=ADD", new FormData(), { absolute: true });
  await client.upload("/media/m/upload", new FormData());
  assert.deepEqual(hosts, ["adsapi.snapchat.com", "adsapi.snapchat.com"]);
});

// A fake where the update is accepted but the item keeps its old value.
function stubbornClient() {
  const puts = [];
  return {
    puts,
    getEntity: async (_e, id) => ({ id, name: `Item ${id}`, status: "ACTIVE" }),
    updateEntity: async (_e, obj) => {
      puts.push(obj.id);
      return obj;
    },
  };
}

test("an update Snap accepts but does not show is reported, logged as unverified, and stops a bulk run", async () => {
  const logFile = join(mkdtempSync(join(tmpdir(), "unv-")), "log.jsonl");
  const client = stubbornClient();
  const one = await applyChange({ client, entity: "adsquad", id: "s1", confirm: true, plan: (cur) => planStatus(cur, "PAUSED"), logFile });
  assert.deepEqual([one.applied, one.verified], [true, false]);
  assert.match(one.warnings[0], /does not show the new values/);
  assert.equal(JSON.parse(readFileSync(logFile, "utf8").trim()).verified, false);

  const plan = { toChange: [{ id: "a", name: "A", from: "ACTIVE" }, { id: "b", name: "B", from: "ACTIVE" }, { id: "c", name: "C", from: "ACTIVE" }] };
  await assert.rejects(() => executeBulkStatus({ client, entity: "adsquad", plan, status: "PAUSED", logFile }), (e) => /could not be verified/.test(e.message) && /Not attempted: \["B","C"\]/.test(e.message));
  assert.deepEqual(client.puts, ["s1", "a"], "the run stops after the first unverified item");
});

test("a change-log write failure after an applied change is reported, not thrown", async () => {
  const client = { getEntity: async (_e, id) => ({ id, name: "X", status: client.s }), updateEntity: async (_e, o) => ((client.s = o.status), o), s: "ACTIVE" };
  const r = await applyChange({ client, entity: "adsquad", id: "s1", confirm: true, plan: (cur) => planStatus(cur, "PAUSED"), logFile: join(tmpdir(), "no-such-dir-snap", "log.jsonl") });
  assert.deepEqual([r.applied, r.verified], [true, true]);
  assert.match(r.warnings[0], /could not be written to the change log/);
});
