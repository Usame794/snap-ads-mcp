import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapClient } from "../src/snap.js";
import { executeBulkStatus, loadBulkItems, planBulkStatus } from "../src/bulk.js";

const camp = { id: "c1", name: "Camp", status: "PAUSED", ad_account_id: "acc" };
const sq = (id, status, budget) => ({ id, name: "S" + id, campaign_id: "c1", status, daily_budget_micro: budget * 1e6 });

test("plan: skips no-ops, warns about paused parent, sums budget that would start", () => {
  const items = [{ obj: sq("1", "PAUSED", 40), parent: camp }, { obj: sq("2", "ACTIVE", 25), parent: camp }, { obj: sq("3", "PAUSED", 10), parent: { ...camp, status: "ACTIVE" } }];
  const p = planBulkStatus({ entity: "adsquad", items, status: "ACTIVE" });
  assert.deepEqual(p.toChange.map((x) => x.id), ["1", "3"]);
  assert.deepEqual(p.skipped.map((x) => x.name), ["S2"]);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /will not deliver/);
  assert.equal(p.summary.daily_budget_that_would_start_delivering, 10);
});

test("plan: pausing has no budget line; bad status refused", () => {
  const p = planBulkStatus({ entity: "adsquad", items: [{ obj: sq("1", "ACTIVE", 40), parent: camp }], status: "PAUSED" });
  assert.equal(p.summary.daily_budget_that_would_start_delivering, undefined);
  assert.throws(() => planBulkStatus({ entity: "adsquad", items: [], status: "DELETED" }), /ACTIVE or PAUSED/);
});

function fakeApi(squads, failId) {
  const state = { squads: Object.fromEntries(squads.map((s) => [s.id, { ...s }])), puts: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (u.includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    if (opts.method === "PUT") {
      const o = JSON.parse(opts.body).adsquads[0];
      if (o.id === failId) return json({ request_status: "ERROR", debug_message: "rejected" }, 400);
      state.puts.push(o.id);
      state.squads[o.id] = { ...state.squads[o.id], ...o };
      return json({ request_status: "SUCCESS", adsquads: [{ sub_request_status: "SUCCESS", adsquad: state.squads[o.id] }] });
    }
    let m = u.match(/\/adsquads\/(\w+)$/);
    if (m) return json({ adsquads: [{ sub_request_status: "SUCCESS", adsquad: state.squads[m[1]] }] });
    if (u.endsWith("/campaigns/c1")) return json({ campaigns: [{ sub_request_status: "SUCCESS", campaign: camp }] });
    return json({}, 404);
  };
  return { state, client: new SnapClient({ env: { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" }, fetchImpl }) };
}
const lf = () => join(mkdtempSync(join(tmpdir(), "b-")), "l.jsonl");

test("execute: pauses each squad and verifies", async () => {
  const { state, client } = fakeApi([sq("1", "ACTIVE", 40), sq("2", "ACTIVE", 25)]);
  const items = await loadBulkItems(client, "adsquad", ["1", "2", "1"]);
  assert.equal(items.length, 2);
  const plan = planBulkStatus({ entity: "adsquad", items, status: "PAUSED" });
  const done = await executeBulkStatus({ client, entity: "adsquad", plan, status: "PAUSED", logFile: lf() });
  assert.deepEqual(done.map((d) => d.verified), [true, true]);
  assert.deepEqual(state.puts, ["1", "2"]);
});

test("execute: stops at first failure and says what changed and what was not attempted", async () => {
  const { state, client } = fakeApi([sq("1", "ACTIVE", 40), sq("2", "ACTIVE", 25), sq("3", "ACTIVE", 10)], "2");
  const items = await loadBulkItems(client, "adsquad", ["1", "2", "3"]);
  const plan = planBulkStatus({ entity: "adsquad", items, status: "PAUSED" });
  await assert.rejects(
    () => executeBulkStatus({ client, entity: "adsquad", plan, status: "PAUSED", logFile: lf() }),
    (e) => /Changed so far/.test(e.message) && /Failed on: "S2"/.test(e.message) && /Not attempted: \["S3"\]/.test(e.message) && e.done.length === 1,
  );
  assert.deepEqual(state.puts, ["1"]);
});

test("limits: more than 20 ids refused, empty refused", async () => {
  const { client } = fakeApi([]);
  await assert.rejects(() => loadBulkItems(client, "adsquad", Array.from({ length: 21 }, (_, i) => "x" + i)), /Too many/);
  await assert.rejects(() => loadBulkItems(client, "adsquad", []), /at least one/);
});
