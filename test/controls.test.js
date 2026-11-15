// Frequency cap, ad schedule, and the other ad squad goals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planAdSchedule, planFrequencyCap } from "../src/controls.js";
import { buildAdSquad } from "../src/create.js";
import { setup } from "./helpers/harness.js";

test("frequency cap: set, change, clear, with Snap's limits", () => {
  const p = planFrequencyCap({}, { count: 4, every: 48, unit: "HOURS" });
  assert.deepEqual(p.patch.cap_and_exclusion_config.frequency_cap_config, [{ frequency_cap_count: 4, frequency_cap_type: "IMPRESSIONS", time_interval: 48, frequency_cap_interval: "HOURS" }]);
  assert.equal(p.summary, "frequency cap none -> 4 impressions per 48 HOURS");
  assert.match(p.note, /multi-format/);
  const cur = { cap_and_exclusion_config: { other_rule: 1, frequency_cap_config: p.patch.cap_and_exclusion_config.frequency_cap_config } };
  assert.throws(() => planFrequencyCap(cur, { count: 4, every: 48, unit: "HOURS" }), /already that value/);
  const changed = planFrequencyCap(cur, { count: 2, every: 1, unit: "DAYS" });
  assert.equal(changed.patch.cap_and_exclusion_config.other_rule, 1, "other settings of the same block are kept");
  assert.match(changed.summary, /4 impressions per 48 HOURS -> 2 impressions per 1 DAYS/);
  assert.deepEqual(planFrequencyCap(cur, { clear: true }).patch.cap_and_exclusion_config, { other_rule: 1, frequency_cap_config: [] });
  assert.throws(() => planFrequencyCap({}, { clear: true }), /no frequency cap/);
  assert.throws(() => planFrequencyCap({}, { count: 0, every: 1 }), /1 to 100/);
  assert.throws(() => planFrequencyCap({}, { count: 3, every: 31, unit: "DAYS" }), /1 to 30/);
  assert.throws(() => planFrequencyCap({}, { count: 3, every: 721, unit: "HOURS" }), /1 to 720/);
  assert.throws(() => planFrequencyCap({}, { count: 3, every: 2, unit: "WEEKS" }), /HOURS or DAYS/);
  // Snap answers with lower-case units in some examples: the same cap is not "changed"
  assert.throws(() => planFrequencyCap({ cap_and_exclusion_config: { frequency_cap_config: [{ frequency_cap_count: 4, time_interval: 48, frequency_cap_interval: "hours" }] } }, { count: 4, every: 48, unit: "HOURS" }), /already/);
});

test("ad schedule: only on lifetime-budget squads, hours validated, always-on, and readable summary", () => {
  const lifetime = { lifetime_budget_micro: 500e6 };
  const p = planAdSchedule(lifetime, { schedule: { friday: [20, 18, 19, 18, 21], monday: [1] } });
  assert.deepEqual(p.patch.ad_scheduling_config, { friday: { hour_of_day: [18, 19, 20, 21] }, monday: { hour_of_day: [1] } });
  assert.match(p.summary, /friday 18:00-22:00; monday 1:00/);
  assert.equal(planAdSchedule(lifetime, { always: true }).patch.ad_scheduling_config.sunday.hour_of_day.length, 24);
  assert.throws(() => planAdSchedule({ daily_budget_micro: 10e6 }, { always: true }), /LIFETIME budget/);
  assert.throws(() => planAdSchedule({ daily_budget_micro: 10e6, lifetime_budget_micro: 500e6 }, { always: true }), /LIFETIME budget/);
  assert.throws(() => planAdSchedule(lifetime, {}), /schedule is required/);
  assert.throws(() => planAdSchedule(lifetime, { always: true, schedule: { monday: [1] } }), /either always or schedule/);
  assert.throws(() => planAdSchedule(lifetime, { schedule: { funday: [1] } }), /Unknown day/);
  assert.throws(() => planAdSchedule(lifetime, { schedule: { monday: [24] } }), /0 to 23/);
  assert.throws(() => planAdSchedule(lifetime, { schedule: { monday: [] } }), /0 to 23/);
  const same = { ad_scheduling_config: p.patch.ad_scheduling_config, lifetime_budget_micro: 500e6 };
  assert.throws(() => planAdSchedule(same, { schedule: { friday: [18, 19, 20, 21], monday: [1] } }), /already that value/);
});

test("ad squad goals: pixel goals need a pixel; traffic, awareness and video goals do not; unknown goals are refused", () => {
  const env = { SNAP_MAX_DAILY_BUDGET: "100", SNAP_MAX_BID: "10" };
  const base = { campaignId: "c", name: "Goal squad", dailyBudget: 20, bid: 2, countries: ["sa"], env };
  const traffic = buildAdSquad({ ...base, optimizationGoal: "SWIPES" });
  assert.deepEqual([traffic.optimization_goal, traffic.pixel_id, traffic.conversion_window, traffic.status], ["SWIPES", undefined, undefined, "PAUSED"]);
  assert.equal(buildAdSquad({ ...base, optimizationGoal: "IMPRESSIONS", pixelId: "px" }).pixel_id, "px", "a pixel is still attached when given");
  assert.equal(buildAdSquad({ ...base, optimizationGoal: "VIDEO_VIEWS_15_SEC" }).optimization_goal, "VIDEO_VIEWS_15_SEC");
  assert.throws(() => buildAdSquad({ ...base, optimizationGoal: "PIXEL_ADD_TO_CART" }), /pixel_id is required for the goal PIXEL_ADD_TO_CART/);
  const sales = buildAdSquad({ ...base, pixelId: "px" });
  assert.deepEqual([sales.optimization_goal, sales.conversion_window], ["PIXEL_PURCHASE", "SWIPE_7DAY"], "the default is unchanged");
  assert.throws(() => buildAdSquad({ ...base, optimizationGoal: "APP_INSTALLS" }), /goal must be one of/);
  assert.throws(() => buildAdSquad({ ...base, optimizationGoal: "SWIPES", productSetId: "ps", dpaMode: "prospecting" }), /pixel goal/);
  assert.throws(() => buildAdSquad({ ...base, optimizationGoal: "SWIPES", dailyBudget: 500 }), /absolute limit/, "money limits apply to every goal");
});

test("through the tools: set a cap, schedule an ad squad, undo the cap, and a traffic squad is created paused", async () => {
  const t = await setup();
  const cap = await t.twoStep("snap_set_frequency_cap", { adsquad_id: "s1", count: 3, every: 2, unit: "DAYS" });
  assert.equal(cap.applied.data.verified, true);
  assert.equal(t.db.adsquads.s1.cap_and_exclusion_config.frequency_cap_config[0].frequency_cap_count, 3);
  await t.twoStep("snap_set_frequency_cap", { adsquad_id: "s1", count: 5, every: 7, unit: "DAYS" });
  assert.equal(t.db.adsquads.s1.cap_and_exclusion_config.frequency_cap_config[0].frequency_cap_count, 5);
  const undo = await t.twoStep("snap_undo", {});
  assert.ok(undo.applied.data, undo.applied.error);
  assert.equal(t.db.adsquads.s1.cap_and_exclusion_config.frequency_cap_config[0].frequency_cap_count, 3, "undo restores the earlier cap");
  assert.match((await t.call("snap_set_ad_schedule", { adsquad_id: "s1", always: true })).error, /LIFETIME budget/, "a daily-budget squad is refused");
  const sq = await t.twoStep("snap_create_adsquad", { campaign_id: "c1", name: "Traffic squad", daily_budget: 10, bid: 1, goal: "SWIPES" });
  const body = t.writes().at(-1).body.adsquads[0];
  assert.deepEqual([body.optimization_goal, body.status], ["SWIPES", "PAUSED"]);
  assert.ok(sq.applied.data.adsquad_id);
  await t.close();
});
