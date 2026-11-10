import { test } from "node:test";
import assert from "node:assert/strict";
import { containsDeep, planBid, planRename, planSchedule, planTargeting } from "../src/changes.js";
import { planCopySquad } from "../src/copy.js";
import { planCloneAd } from "../src/clone-ad.js";
import { summarizeRow } from "../src/report.js";

test("rename: needs a real, different name", () => {
  assert.throws(() => planRename({ name: "A name" }, " x "), /3 characters/);
  assert.throws(() => planRename({ name: "Same name" }, "Same name"), /already/);
  assert.deepEqual(planRename({ name: "Old name" }, " New name ").patch, { name: "New name" });
});

test("bid: caps increases, refuses auto-bid, allows decreases", () => {
  const sq = { bid_micro: 2_000_000 };
  assert.deepEqual(planBid(sq, 2.5, {}).patch, { bid_micro: 2_500_000 });
  assert.deepEqual(planBid(sq, 1, {}).patch, { bid_micro: 1_000_000 });
  assert.throws(() => planBid(sq, 4, {}), /Refusing/);
  assert.throws(() => planBid(sq, 2, {}), /already/);
  assert.throws(() => planBid({}, 2, {}), /auto-bid/);
  assert.throws(() => planBid(sq, 0, {}), /greater than 0/);
});

test("copy squad: paused, scaled, ads paused, original untouched", () => {
  const squad = { id: "s", name: "Orig", status: "ACTIVE", daily_budget_micro: 80_000_000, start_time: "2026-01-01T00:00:00Z", end_time: "2026-02-01T00:00:00Z" };
  const p = planCopySquad({ squad, ads: [{ id: "a", status: "ACTIVE" }], newName: "Copy", budgetScale: 0.5, now: "2026-10-26T12:00:00.000Z" });
  assert.equal(p.obj.status, "PAUSED");
  assert.equal(p.obj.daily_budget_micro, 40_000_000);
  assert.equal(p.obj.end_time, undefined);
  assert.equal(p.ads[0].status, "PAUSED");
  assert.equal(squad.status, "ACTIVE");
  assert.throws(() => planCopySquad({ squad, budgetScale: 3 }), /budget_scale/);
});

test("clone pre-check skips squads with a different product set", () => {
  const src = { id: "a1", name: "Hero", ad_squad_id: "s1", creative_id: "cr1", type: "COLLECTION", render_type: "DYNAMIC" };
  const sourceSquad = { id: "s1", product_properties: { product_set_id: "SET_W" } };
  const t = (id, set) => ({ squad: { id, name: id, product_properties: { product_set_id: set } }, existingAds: [] });
  const p = planCloneAd({ sourceAd: src, sourceSquad, targets: [t("men", "SET_M"), t("women2", "SET_W")] });
  assert.deepEqual(p.toCreate.map((x) => x.squadId), ["women2"]);
  assert.match(p.skipped[0].reason, /different product set/);
});

test("report row math: ROAS, CPA, swipe rate", () => {
  const r = summarizeRow("c", "1", { spend: 100_000_000, conversion_purchases: 10, conversion_purchases_value: 500_000_000, impressions: 10_000, swipes: 250, frequency: 2.345 });
  assert.deepEqual([r.spend, r.purchases, r.roas, r.cpa, r.swipe_rate_pct, r.frequency], [100, 10, 5, 10, 2.5, 2.35]);
  const empty = summarizeRow("c", "2", {});
  assert.deepEqual([empty.roas, empty.cpa, empty.swipe_rate_pct], [null, null, null]);
});

test("verification compares only what changed, ignoring reordering and extra fields", () => {
  const patch = { segments: [{ segment_id: ["a", "b"], operation: "EXCLUDE" }] };
  const after = { geos: [1], segments: [{ operation: "EXCLUDE", extra: true, segment_id: ["b", "a", "c"] }, { segment_id: ["z"] }] };
  assert.equal(containsDeep(after, patch), true);
  assert.equal(containsDeep({ segments: [{ segment_id: ["a"], operation: "EXCLUDE" }] }, patch), false);
  assert.equal(containsDeep({ segments: [] }, patch), false);
  assert.equal(containsDeep(10_000_000, 10_000_000), true);
  assert.equal(containsDeep("PAUSED", "ACTIVE"), false);
  assert.equal(containsDeep({ a: 1 }, { a: 1, b: 2 }), false);
});

test("targeting: changes only countries/age/gender and keeps everything else", () => {
  const cur = { targeting: { regulated_content: false, geos: [{ country_code: "sa" }], demographics: [{ min_age: "20", gender: "FEMALE", operation: "INCLUDE" }], segments: [{ segment_id: ["x"], operation: "EXCLUDE" }] } };
  const a = planTargeting(cur, { countries: ["SA", "ae"] });
  assert.deepEqual(a.patch.targeting.geos, [{ country_code: "sa" }, { country_code: "ae" }]);
  assert.deepEqual(a.patch.targeting.segments, cur.targeting.segments);
  assert.deepEqual(a.patch.targeting.demographics, cur.targeting.demographics);
  const b = planTargeting(cur, { minAge: 25, maxAge: 40, gender: "MALE" });
  assert.deepEqual(b.patch.targeting.demographics[0], { min_age: "25", gender: "MALE", operation: "INCLUDE", max_age: "40" });
  assert.equal(cur.targeting.demographics[0].min_age, "20");
  assert.throws(() => planTargeting(cur, {}), /at least one/);
  assert.throws(() => planTargeting(cur, { countries: ["saudi"] }), /2-letter/);
  assert.throws(() => planTargeting(cur, { minAge: 10 }), /between 13 and 50/);
  assert.throws(() => planTargeting(cur, { minAge: 30, maxAge: 20 }), /max_age/);
  assert.throws(() => planTargeting(cur, { gender: "ALL" }), /gender/);
});

test("schedule: validates order and that the end is in the future", () => {
  const now = new Date("2026-10-26T00:00:00Z");
  const cur = { start_time: "2026-10-20T00:00:00.000Z" };
  assert.equal(planSchedule(cur, { endTime: "2026-11-30T00:00:00Z" }, now).patch.end_time, "2026-11-30T00:00:00.000Z");
  assert.throws(() => planSchedule(cur, { endTime: "2026-10-01T00:00:00Z" }, now), /future/);
  assert.throws(() => planSchedule(cur, { startTime: "2026-12-01T00:00:00Z", endTime: "2026-11-30T00:00:00Z" }, now), /after start/);
  assert.throws(() => planSchedule(cur, {}, now), /start_time and\/or end_time/);
  assert.throws(() => planSchedule(cur, { endTime: "nonsense" }, now), /ISO/);
});
