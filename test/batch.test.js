import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapClient } from "../src/snap.js";
import { bulkEdit, plans } from "../src/bulk-edit.js";
import { checkBatch, runBatch } from "../src/influencer-batch.js";
import { createWithAutoStrip, planCloneCreative } from "../src/creative-tools.js";
import { planUndo, undoableEntries, applyChange, planBudget } from "../src/changes.js";
import { buildPixelAudience } from "../src/readers.js";

const env = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };
const tmp = () => mkdtempSync(join(tmpdir(), "bt-"));
const lf = () => join(tmp(), "l.jsonl");

function squadsApi(initial, failPutFor) {
  const state = { sq: structuredClone(initial), puts: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (u.includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    if (opts.method === "PUT") {
      const o = JSON.parse(opts.body).adsquads[0];
      if (o.id === failPutFor) return json({ request_status: "ERROR", debug_message: "nope" }, 400);
      state.puts.push(o.id);
      state.sq[o.id] = { ...state.sq[o.id], ...o };
      return json({ request_status: "SUCCESS", adsquads: [{ sub_request_status: "SUCCESS", adsquad: state.sq[o.id] }] });
    }
    const m = u.match(/\/adsquads\/(\w+)/);
    return m && state.sq[m[1]] ? json({ adsquads: [{ sub_request_status: "SUCCESS", adsquad: state.sq[m[1]] }] }) : json({}, 404);
  };
  return { state, client: new SnapClient({ env, fetchImpl }) };
}
const sq = (id, budget, targeting = {}) => ({ id, name: "Squad " + id, campaign_id: "c", status: "ACTIVE", daily_budget_micro: budget * 1e6, targeting });

test("bulk edit: preview lists changes and skips, nothing is sent without confirm", async () => {
  const { state, client } = squadsApi({ a: sq("a", 100, { segments: [{ segment_id: ["x"], operation: "EXCLUDE" }] }), b: sq("b", 50) });
  const r = await bulkEdit({ client, entity: "adsquad", ids: ["a", "b", "a"], buildPlan: plans.exclude(["x"]), confirm: false });
  assert.equal(r.dry_run, true);
  assert.deepEqual(r.will_change.map((x) => x.id), ["b"]);
  assert.match(r.skipped[0].reason, /already excluded/);
  assert.equal(state.puts.length, 0);
});

test("bulk budget scale applies per item with guards, then verifies", async () => {
  const { state, client } = squadsApi({ a: sq("a", 100), b: sq("b", 10) });
  const r = await bulkEdit({ client, entity: "adsquad", ids: ["a", "b"], buildPlan: plans.budgetScale(0.5, {}), confirm: true, logFile: lf() });
  assert.deepEqual(r.changed.map((c) => c.verified), [true, true]);
  assert.equal(state.sq.a.daily_budget_micro, 50_000_000);
  assert.equal(state.sq.b.daily_budget_micro, 5_000_000, "0.5x of 10 is 5, exactly the minimum, so it is allowed");
  const small = squadsApi({ c: sq("c", 8) });
  const r2 = await bulkEdit({ client: small.client, entity: "adsquad", ids: ["c"], buildPlan: plans.budgetScale(0.5, {}), confirm: true, logFile: lf() });
  assert.equal(r2.applied, false);
  assert.match(r2.skipped[0].reason, /at least 5/);
});

test("bulk edit stops at the first failure and reports done / failed / not attempted", async () => {
  const { state, client } = squadsApi({ a: sq("a", 100), b: sq("b", 100), c: sq("c", 100) }, "b");
  await assert.rejects(
    () => bulkEdit({ client, entity: "adsquad", ids: ["a", "b", "c"], buildPlan: plans.budgetSet(50, {}), confirm: true, logFile: lf() }),
    (e) => /Changed so far/.test(e.message) && /Failed on: "Squad b"/.test(e.message) && /Not attempted: \["Squad c"\]/.test(e.message) && e.done.length === 1,
  );
  assert.deepEqual(state.puts, ["a"]);
});

test("bulk rename and limits", async () => {
  const { client } = squadsApi({ a: { ...sq("a", 10), name: "OCT - Bags - 7d" } });
  const r = await bulkEdit({ client, entity: "adsquad", ids: ["a"], buildPlan: plans.rename("OCT", "NOV"), confirm: false });
  assert.match(r.will_change[0].change, /NOV - Bags - 7d/);
  const none = await bulkEdit({ client, entity: "adsquad", ids: ["a"], buildPlan: plans.rename("ZZZ", "x"), confirm: false });
  assert.match(none.skipped[0].reason, /does not contain/);
  await assert.rejects(() => bulkEdit({ client, entity: "adsquad", ids: Array.from({ length: 21 }, (_, i) => "x" + i), buildPlan: plans.rename("a", "b"), confirm: false }), /Too many/);
  await assert.rejects(() => bulkEdit({ client, entity: "adsquad", ids: [], buildPlan: plans.rename("a", "b"), confirm: false }), /at least one/);
});

const CODE = (n) => `adcode_${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;

test("influencer batch: validates, rejects duplicates and over 10 items", () => {
  assert.equal(checkBatch([{ ad_code: CODE(1), name: "Paid - a" }])[0].ad_code, CODE(1));
  assert.throws(() => checkBatch([{ ad_code: CODE(1), name: "Paid - a" }, { ad_code: CODE(1), name: "Paid - b" }]), /duplicate/);
  assert.throws(() => checkBatch([{ ad_code: "#abc", name: "Paid - a" }]), /adcode_/);
  assert.throws(() => checkBatch([{ ad_code: CODE(2), name: "" }]), /name/);
  assert.throws(() => checkBatch(Array.from({ length: 11 }, (_, i) => ({ ad_code: CODE(i), name: "Paid - x" }))), /Too many/);
});

function batchApi({ expired = [], breakCreative = null }) {
  let mediaN = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (String(url).includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    if (u.pathname.endsWith("claim_media_by_ad_code")) {
      const code = u.searchParams.get("ad_code");
      if (expired.includes(code)) return json({ request_status: "ERROR", debug_message: "Ad code has expired" }, 400);
      return json({ request_status: "SUCCESS", media_entity_id: "m" + ++mediaN });
    }
    if (u.pathname.includes("/media/")) return json({ media: [{ sub_request_status: "SUCCESS", media: { id: "x", media_status: "READY" } }] });
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.pathname.endsWith("/creatives")) {
      if (breakCreative && body.creatives[0].top_snap_media_id === breakCreative) return json({ request_status: "ERROR", debug_message: "bad creative" }, 400);
      return json({ request_status: "SUCCESS", creatives: [{ sub_request_status: "SUCCESS", creative: { ...body.creatives[0], id: "cr-" + body.creatives[0].top_snap_media_id } }] });
    }
    if (u.pathname.endsWith("/ads")) return json({ request_status: "SUCCESS", ads: [{ sub_request_status: "SUCCESS", ad: { ...body.ads[0], id: "ad-" + body.ads[0].creative_id } }] });
    return json({}, 404);
  };
  return new SnapClient({ env, fetchImpl });
}
const bargs = (client, items) => ({ client, adAccountId: "acc", profileId: "p", adSquadId: "sq", headline: "hello there", url: "https://example.com/shop", items, logFile: lf(), sleep: async () => {} });

test("influencer batch: expired codes are skipped, the rest are created paused", async () => {
  const client = batchApi({ expired: [CODE(2)] });
  const r = await runBatch(bargs(client, [1, 2, 3].map((n) => ({ ad_code: CODE(n), name: "Paid - h" + n, ref: "AR-" + n }))));
  assert.deepEqual([r.created, r.code_unusable, r.failed, r.incomplete], [2, 1, 0, 0]);
  assert.deepEqual(r.results.map((x) => x.result), ["created", "code_unusable", "created"]);
  assert.equal(r.results[0].ad_id, "ad-cr-m1");
});

test("influencer batch: stops when a claimed code ends up incomplete", async () => {
  const client = batchApi({ breakCreative: "m2" });
  const r = await runBatch(bargs(client, [1, 2, 3].map((n) => ({ ad_code: CODE(n), name: "Paid - h" + n }))));
  assert.deepEqual(r.results.map((x) => x.result), ["created", "claimed_but_incomplete"]);
  assert.equal(r.stopped_early, true);
  assert.equal(r.results[1].media_id, "m2");
});

test("clone creative: strips read-only fields, applies overrides, keeps media", () => {
  const src = { id: "c1", ad_account_id: "acc", created_at: "x", packaging_status: "SUCCESS", review_status: "APPROVED", semantic_id: "9", name: "Old", type: "WEB_VIEW", headline: "Old headline", call_to_action: "ORDER_NOW", top_snap_media_id: "m", web_view_properties: { url: "https://a.com", block_preload: false } };
  const p = planCloneCreative(src, { name: "New one", headline: "New headline", url: "https://b.com/x" });
  for (const k of ["id", "created_at", "packaging_status", "review_status", "semantic_id", "ad_account_id"]) assert.equal(k in p.obj, false);
  assert.equal(p.obj.top_snap_media_id, "m");
  assert.deepEqual(p.obj.web_view_properties, { url: "https://b.com/x", block_preload: false });
  assert.equal(src.headline, "Old headline");
  assert.throws(() => planCloneCreative(src, { name: "ab" }), /3 characters/);
  assert.throws(() => planCloneCreative(src, { name: "New one", headline: "x".repeat(35) }), /34/);
  assert.throws(() => planCloneCreative(src, { name: "New one", url: "http://b.com" }), /https/);
  assert.throws(() => planCloneCreative({ ...src, web_view_properties: undefined }, { name: "New one", url: "https://b.com" }), /no web view/);
});

test("create with auto-strip removes fields Snap names and retries", async () => {
  let calls = 0;
  const fetchImpl = async (url, opts = {}) => {
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (String(url).includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    const o = JSON.parse(opts.body).creatives[0];
    calls++;
    if ("bad_one" in o) return json({ request_status: "SUCCESS", creatives: [{ sub_request_status: "ERROR", sub_request_error_reason: "Error code: E2002, message: Property value is not allowed : [bad_one]" }] });
    if (o.nested && "bad_two" in o.nested) return json({ request_status: "SUCCESS", creatives: [{ sub_request_status: "ERROR", sub_request_error_reason: "Error code: E2002, message: Property value is not allowed : [bad_two]" }] });
    return json({ request_status: "SUCCESS", creatives: [{ sub_request_status: "SUCCESS", creative: { ...o, id: "new" } }] });
  };
  const client = new SnapClient({ env, fetchImpl });
  const { created, stripped } = await createWithAutoStrip(client, "creative", { ad_account_id: "a", name: "n", bad_one: 1, nested: { bad_two: 2, keep: 3 } });
  assert.equal(created.id, "new");
  assert.deepEqual(stripped, ["bad_one", "bad_two"]);
  assert.equal(calls, 3);
});

test("undo: reverts only when nothing changed since, needs recorded before values", async () => {
  const entry = { entity: "adsquad", id: "a", change: "daily budget 100 -> 50", patch: { daily_budget_micro: 50_000_000 }, before: { daily_budget_micro: 100_000_000 }, verified: true };
  assert.deepEqual(planUndo(entry, { daily_budget_micro: 50_000_000 }).patch, { daily_budget_micro: 100_000_000 });
  assert.throws(() => planUndo(entry, { daily_budget_micro: 80_000_000 }), /changed again/);
  // targeting-style (object) edits: a later ADDITION must be detected using the after-snapshot
  const tEntry = { entity: "adsquad", id: "a", change: "targeting x", patch: { targeting: { geos: [{ country_code: "sa" }] } }, before: { targeting: { geos: [{ country_code: "sa" }, { country_code: "ae" }] } }, after: { targeting: { geos: [{ country_code: "sa" }], extra: 1 } }, verified: true };
  assert.deepEqual(planUndo(tEntry, { targeting: { extra: 1, geos: [{ country_code: "sa" }] } }).patch.targeting.geos.length, 2, "same state, different key order, still undoable");
  assert.throws(() => planUndo(tEntry, { targeting: { geos: [{ country_code: "sa" }, { country_code: "kw" }], extra: 1 } }), /changed again/);
  assert.throws(() => planUndo({ ...tEntry, after: undefined }, { targeting: { geos: [{ country_code: "sa" }] } }), /cannot be checked/, "old entry without snapshot, object field: refuse unless forced");
  assert.deepEqual(planUndo(entry, { daily_budget_micro: 80_000_000 }, { force: true }).patch, { daily_budget_micro: 100_000_000 });
  assert.throws(() => planUndo({ ...entry, before: { daily_budget_micro: null } }, { daily_budget_micro: 50_000_000 }), /did not exist/);
  // end to end: an applied change writes `before`, and undoableEntries sees it
  const { state, client } = squadsApi({ a: sq("a", 100) });
  const file = lf();
  await applyChange({ client, entity: "adsquad", id: "a", confirm: true, plan: (c) => planBudget(c, 50, {}), logFile: file });
  const entries = undoableEntries(file);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].before, { daily_budget_micro: 100_000_000 });
  assert.deepEqual(entries[0].after, { daily_budget_micro: 50_000_000 });
  const undo = await applyChange({ client, entity: "adsquad", id: "a", confirm: true, plan: (c) => planUndo(entries[0], c), logFile: file, logExtra: { undoes: entries[0].at } });
  assert.equal(undo.verified, true);
  assert.equal(state.sq.a.daily_budget_micro, 100_000_000);
  assert.equal(undoableEntries(file).length, 0, "an undone change is no longer offered, and the undo itself is not undoable");
});

test("pixel audience builder matches the shape Snap stores and validates", () => {
  const a = buildPixelAudience({ adAccountId: "acc", pixelId: "px", name: "ATC 14d", events: ["ADD_CART", "VIEW_CONTENT"], retentionDays: 14 });
  assert.equal(a.source_type, "PIXEL");
  assert.equal(a.pixel_id, "px");
  assert.deepEqual(JSON.parse(a.pixel_spec), { or: { event: [{ eq: "ADD_CART" }, { eq: "VIEW_CONTENT" }] } });
  assert.throws(() => buildPixelAudience({ adAccountId: "a", pixelId: "p", name: "abc", events: ["BUY"] }), /Unknown event/);
  assert.throws(() => buildPixelAudience({ adAccountId: "a", pixelId: "p", name: "abc", events: [] }), /at least one/);
  assert.throws(() => buildPixelAudience({ adAccountId: "a", pixelId: "", name: "abc", events: ["PURCHASE"] }), /pixel_id/);
  assert.throws(() => buildPixelAudience({ adAccountId: "a", pixelId: "p", name: "abc", events: ["PURCHASE"], retentionDays: 400 }), /1 to 180/);
});
