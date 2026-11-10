import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapClient } from "../src/snap.js";
import { applyChange, planBudget, planExcludeSegments, planStatus } from "../src/changes.js";

const env = { SNAP_CLIENT_ID: "id", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };

// Fake Snap API holding one ad squad in memory.
function fakeSnap(initial) {
  const state = { squad: structuredClone(initial), puts: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (u.includes("access_token")) return json({ access_token: "tok", expires_in: 1800 });
    if (opts.method === "PUT") {
      const sent = JSON.parse(opts.body).adsquads[0];
      state.puts.push({ url: u, sent });
      state.squad = { ...state.squad, ...sent };
      return json({ request_status: "SUCCESS", adsquads: [{ sub_request_status: "SUCCESS", adsquad: state.squad }] });
    }
    return json({ request_status: "SUCCESS", adsquads: [{ sub_request_status: "SUCCESS", adsquad: state.squad }] });
  };
  return { state, client: new SnapClient({ env, fetchImpl }) };
}

const squad = {
  id: "sq1", name: "WW13", campaign_id: "c1", status: "ACTIVE", daily_budget_micro: 100_000_000,
  created_at: "x", updated_at: "y", delivery_status: ["VALID"], targeting: { geos: [{ country_code: "sa" }] },
};
const logFile = () => join(mkdtempSync(join(tmpdir(), "snap-")), "log.jsonl");

test("dry run sends nothing", async () => {
  const { client, state } = fakeSnap(squad);
  const r = await applyChange({ client, entity: "adsquad", id: "sq1", confirm: false, plan: (c) => planStatus(c, "PAUSED"), logFile: logFile() });
  assert.equal(r.dry_run, true);
  assert.equal(state.puts.length, 0);
});

test("confirmed pause sends sanitized body to the campaign adsquads endpoint and verifies", async () => {
  const { client, state } = fakeSnap(squad);
  const lf = logFile();
  const r = await applyChange({ client, entity: "adsquad", id: "sq1", confirm: true, plan: (c) => planStatus(c, "PAUSED"), logFile: lf });
  assert.equal(r.applied, true);
  assert.equal(r.verified, true);
  assert.match(state.puts[0].url, /\/campaigns\/c1\/adsquads$/);
  for (const f of ["created_at", "updated_at", "delivery_status"]) assert.equal(f in state.puts[0].sent, false);
  assert.equal(state.puts[0].sent.status, "PAUSED");
  assert.equal(JSON.parse(readFileSync(lf, "utf8").trim()).change, "status ACTIVE -> PAUSED");
});

test("budget guard blocks big jumps and tiny budgets, allows normal steps", () => {
  assert.throws(() => planBudget(squad, 250, {}), /Refusing/);
  assert.throws(() => planBudget(squad, 2, {}), /at least/);
  assert.throws(() => planBudget(squad, 100, {}), /already/);
  const p = planBudget(squad, 120, {});
  assert.equal(p.patch.daily_budget_micro, 120_000_000);
  assert.throws(() => planBudget({ ...squad, daily_budget_micro: undefined }, 50, {}), /no daily_budget_micro/);
});

test("status plan rejects delete-like values and no-ops", () => {
  assert.throws(() => planStatus(squad, "DELETED"), /ACTIVE or PAUSED/);
  assert.throws(() => planStatus(squad, "ACTIVE"), /Already/);
});

test("exclude segments keeps existing targeting and skips duplicates", () => {
  const p = planExcludeSegments(squad, ["a", "b"]);
  assert.deepEqual(p.patch.targeting.geos, squad.targeting.geos);
  assert.deepEqual(p.patch.targeting.segments, [{ segment_id: ["a", "b"], operation: "EXCLUDE" }]);
  const withEx = { ...squad, targeting: { ...squad.targeting, segments: p.patch.targeting.segments } };
  assert.throws(() => planExcludeSegments(withEx, ["a"]), /already excluded/);
  assert.deepEqual(planExcludeSegments(withEx, ["a", "c"]).patch.targeting.segments.at(-1).segment_id, ["c"]);
});

test("missing credentials give a clear error", async () => {
  const client = new SnapClient({ env: {}, fetchImpl: async () => ({}) });
  await assert.rejects(() => client.accessToken(), /Missing SNAP_CLIENT_ID/);
});
