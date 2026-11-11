import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAmount, checkBid, checkDailyBudget, checkLifetimeBudget, loadPolicy } from "../src/policy.js";
import { planBid, planBudget, planUndo, limits } from "../src/changes.js";
import { buildAdSquad } from "../src/create.js";
import { planCopy, planCopySquad } from "../src/copy.js";
import { plans } from "../src/bulk-edit.js";

test("policy: defaults are safe, complete and frozen", () => {
  const p = loadPolicy({});
  assert.deepEqual(
    { min: p.minDailyBudget, max: p.maxDailyBudget, bid: p.maxBid, inc: p.maxIncreasePct, bidInc: p.maxBidIncreasePct, life: p.maxLifetimeBudget, act: p.maxActivationDailyBudget, ro: p.readOnly, human: p.humanApproval },
    { min: 5, max: 1000, bid: 50, inc: 100, bidInc: 50, life: 30000, act: 5000, ro: false, human: "off" },
  );
  assert.ok(Object.isFrozen(p));
  assert.equal(loadPolicy(p), p, "a policy passes through unchanged");
});

test("policy: every malformed safety setting is rejected instead of disabling the limit (fail closed)", () => {
  const bad = [
    { SNAP_MAX_BUDGET_INCREASE_PCT: "abc" },
    { SNAP_MAX_BUDGET_INCREASE_PCT: "100%" },
    { SNAP_MAX_BUDGET_INCREASE_PCT: "" },
    { SNAP_MAX_BUDGET_INCREASE_PCT: "-5" },
    { SNAP_MAX_BUDGET_INCREASE_PCT: "1e3" },
    { SNAP_MAX_BUDGET_INCREASE_PCT: "Infinity" },
    { SNAP_MAX_BUDGET_INCREASE_PCT: "100000" },
    { SNAP_MAX_BID_INCREASE_PCT: "50%" },
    { SNAP_MAX_BID_INCREASE_PCT: "NaN" },
    { SNAP_MIN_DAILY_BUDGET: "0" },
    { SNAP_MIN_DAILY_BUDGET: "$5" },
    { SNAP_MAX_DAILY_BUDGET: "1,000" },
    { SNAP_MAX_DAILY_BUDGET: "0" },
    { SNAP_MAX_DAILY_BUDGET: "3", SNAP_MIN_DAILY_BUDGET: "5" },
    { SNAP_MAX_BID: "none" },
    { SNAP_MAX_LIFETIME_BUDGET: "lots" },
    { SNAP_MAX_ACTIVATION_DAILY_BUDGET: " " },
    { SNAP_APPROVAL_TTL_SECONDS: "5" },
    { SNAP_APPROVAL_TTL_SECONDS: "60.5" },
    { SNAP_HTTP_TIMEOUT_MS: "0" },
    { SNAP_READ_ONLY: "maybe" },
    { SNAP_HUMAN_APPROVAL: "sometimes" },
    { SNAP_ACCOUNT_CURRENCY: "dollars" },
  ];
  for (const env of bad) assert.throws(() => loadPolicy(env), /Unsafe configuration/, JSON.stringify(env));
  // all problems are reported together, and no secret-looking value is echoed beyond the setting itself
  assert.throws(() => loadPolicy({ SNAP_MAX_BID: "x", SNAP_READ_ONLY: "y" }), (e) => /SNAP_MAX_BID/.test(e.message) && /SNAP_READ_ONLY/.test(e.message));
});

test("policy: valid overrides are accepted", () => {
  const p = loadPolicy({ SNAP_MAX_DAILY_BUDGET: "250.5", SNAP_MAX_BID: "8", SNAP_READ_ONLY: "true", SNAP_HUMAN_APPROVAL: "elicit", SNAP_ACCOUNT_CURRENCY: "USD", SNAP_MAX_BUDGET_INCREASE_PCT: "0" });
  assert.deepEqual([p.maxDailyBudget, p.maxBid, p.readOnly, p.humanApproval, p.currency, p.maxIncreasePct, p.maxLifetimeBudget], [250.5, 8, true, "elicit", "USD", 0, 7515]);
});

test("amounts: non-finite, non-positive, non-numeric and over-precise values are rejected", () => {
  for (const v of [NaN, Infinity, -1, 0, "25", null, undefined, 1e12, 1.23456789]) assert.throws(() => assertAmount("x", v), /x /, String(v));
  assert.equal(assertAmount("x", 25.5), 25.5);
  assert.equal(assertAmount("x", 0.000001), 0.000001);
});

test("daily budget rules: absolute ceiling, minimum, per-step and per-24h", () => {
  const p = loadPolicy({});
  assert.throws(() => checkDailyBudget(p, { value: 1000.01 }), /absolute limit of 1000/);
  assert.throws(() => checkDailyBudget(p, { before: 900, value: 1500 }), /absolute limit/);
  assert.throws(() => checkDailyBudget(p, { value: 4 }), /at least 5/);
  assert.throws(() => checkDailyBudget(p, { before: 10, value: 21 }), /per step/);
  checkDailyBudget(p, { before: 10, value: 20 });
  // the same +100% step is refused when the day already started at 10
  assert.throws(() => checkDailyBudget(p, { before: 20, value: 40, windowStart: 10 }), /per 24h/);
  checkDailyBudget(p, { before: 15, value: 20, windowStart: 10 });
  // decreases are always allowed, even from a value above the ceiling
  checkDailyBudget(p, { before: 5000, value: 3000 });
  // a zero budget cannot be raised relatively
  assert.throws(() => checkDailyBudget(p, { before: 0, value: 10 }), /cannot be checked/);
  // restoring a value the item had inside the window is not a new increase; anything above it still is
  checkDailyBudget(p, { before: 10, value: 800, windowStart: 800, restoring: true });
  assert.throws(() => checkDailyBudget(p, { before: 10, value: 800, windowStart: null, restoring: true }), /per step/);
  assert.throws(() => checkDailyBudget(p, { before: 10, value: 2000, windowStart: 2000, restoring: true }), /absolute limit/);
});

test("bid and lifetime rules", () => {
  const p = loadPolicy({});
  assert.throws(() => checkBid(p, { value: 51 }), /absolute limit of 50/);
  assert.throws(() => checkBid(p, { before: 1, value: 1.6 }), /per step/);
  assert.throws(() => checkBid(p, { before: 1.4, value: 2, windowStart: 1 }), /per 24h/);
  checkBid(p, { before: 1, value: 1.5 });
  assert.throws(() => checkLifetimeBudget(p, 30001), /SNAP_MAX_LIFETIME_BUDGET/);
  checkLifetimeBudget(p, 30000);
});

test("regression F-04: a non-numeric limit no longer lets a 100x budget or bid through", () => {
  const cur = { id: "s", daily_budget_micro: 10e6, bid_micro: 1e6 };
  assert.throws(() => planBudget(cur, 1000, { SNAP_MAX_BUDGET_INCREASE_PCT: "abc" }), /Unsafe configuration/);
  assert.throws(() => planBid(cur, 100, { SNAP_MAX_BID_INCREASE_PCT: "50%" }), /Unsafe configuration/);
  assert.throws(() => limits({ SNAP_MIN_DAILY_BUDGET: "five" }), /Unsafe configuration/);
});

test("regression F-01: cumulative increases are bounded by the value at the start of the last 24 hours", () => {
  const history = (id, field) => (id === "s" && field === "daily_budget_micro" ? 10e6 : id === "s" && field === "bid_micro" ? 1e6 : null);
  assert.throws(() => planBudget({ id: "s", daily_budget_micro: 20e6 }, 40, {}, { history }), /per 24h/);
  assert.equal(planBudget({ id: "s", daily_budget_micro: 15e6 }, 20, {}, { history }).patch.daily_budget_micro, 20e6);
  assert.throws(() => planBid({ id: "s", bid_micro: 1.5e6 }, 2.25, {}, { history }), /per 24h/);
  // the bulk planners use the same rule
  assert.throws(() => plans.budgetScale(2, {}, { history })({ id: "s", daily_budget_micro: 20e6 }), /per 24h/);
  assert.throws(() => plans.budgetSet(40, {}, { history })({ id: "s", daily_budget_micro: 20e6 }), /per 24h/);
  assert.throws(() => plans.budgetScale(NaN, {})({ id: "s", daily_budget_micro: 20e6 }), /positive number/);
});

test("regression F-01: a new ad squad cannot be created above the absolute budget or bid limit", () => {
  const base = { campaignId: "c", name: "big", pixelId: "p", countries: ["us"] };
  assert.throws(() => buildAdSquad({ ...base, dailyBudget: 1e6, bid: 5 }), /absolute limit of 1000/);
  assert.throws(() => buildAdSquad({ ...base, dailyBudget: 50, bid: 5000 }), /absolute limit of 50/);
  assert.throws(() => buildAdSquad({ ...base, dailyBudget: 50, bid: 5, env: { SNAP_MIN_DAILY_BUDGET: "60" } }), /at least 60/);
  assert.throws(() => buildAdSquad({ ...base, dailyBudget: NaN, bid: 5 }), /at least 5/);
  assert.throws(() => buildAdSquad({ ...base, dailyBudget: 50, bid: 5, bidStrategy: "AUTO_BID" }), /not used with AUTO_BID/);
  const ok = buildAdSquad({ ...base, dailyBudget: 1000, bid: 50 });
  assert.deepEqual([ok.daily_budget_micro, ok.bid_micro, ok.status], [1000e6, 50e6, "PAUSED"]);
});

test("regression F-14: copies scale and show lifetime budgets, and stay under the limits", () => {
  const src = { campaign: { name: "a", lifetime_spend_cap_micro: 4000e6 }, squads: [{ id: "s", name: "s", lifetime_budget_micro: 9000e6, bid_micro: 2e6 }], adsBySquad: {}, newName: "b" };
  const half = planCopy({ ...src, budgetScale: 0.5 });
  assert.equal(half.squads[0].obj.lifetime_budget_micro, 4500e6);
  assert.equal(half.campaign.lifetime_spend_cap_micro, 2000e6);
  assert.equal(half.summary.ad_squads[0].lifetime_budget, 4500);
  assert.equal(half.summary.total_lifetime_budget_if_enabled, 6500);
  assert.throws(() => planCopy({ ...src, budgetScale: 2, env: { SNAP_MAX_LIFETIME_BUDGET: "10000" } }), /SNAP_MAX_LIFETIME_BUDGET/);
  assert.throws(() => planCopy({ campaign: { name: "a" }, squads: [{ id: "s", name: "s", daily_budget_micro: 600e6 }], adsBySquad: {}, newName: "b", budgetScale: 2 }), /absolute limit of 1000/);
  assert.throws(() => planCopySquad({ squad: { name: "s", daily_budget_micro: 600e6 }, budgetScale: 2 }), /absolute limit of 1000/);
  assert.throws(() => planCopySquad({ squad: { name: "s", daily_budget_micro: 10e6, bid_micro: 99e6 } }), /SNAP_MAX_BID/);
  assert.equal(planCopySquad({ squad: { name: "s", daily_budget_micro: 10e6, lifetime_budget_micro: 300e6 } }).summary.lifetime_budget, 300);
});

test("regression F-05: undo cannot push a budget or bid past the limits", () => {
  const entry = (field, before, after) => ({ entity: "adsquad", id: "s", change: "x", patch: { [field]: after }, before: { [field]: before }, after: { [field]: after } });
  // a decrease logged long ago: putting 1000 back from 10 is a +9900% step and is refused
  assert.throws(() => planUndo(entry("daily_budget_micro", 1000e6, 10e6), { id: "s", daily_budget_micro: 10e6 }), /per step/);
  // the same decrease made inside the last 24 hours can be undone (the item really had that value today)
  const history = () => 1000e6;
  assert.equal(planUndo(entry("daily_budget_micro", 1000e6, 10e6), { id: "s", daily_budget_micro: 10e6 }, { history }).patch.daily_budget_micro, 1000e6);
  // never above the absolute ceiling, whatever the log says
  assert.throws(() => planUndo(entry("daily_budget_micro", 5000e6, 10e6), { id: "s", daily_budget_micro: 10e6 }, { history: () => 5000e6 }), /absolute limit/);
  assert.throws(() => planUndo(entry("bid_micro", 40e6, 1e6), { id: "s", bid_micro: 1e6 }), /per step/);
  assert.throws(() => planUndo(entry("bid_micro", 90e6, 1e6), { id: "s", bid_micro: 1e6 }, { history: () => 90e6 }), /absolute limit of 50/);
  // an undo that lowers money is always fine
  assert.equal(planUndo(entry("daily_budget_micro", 10e6, 20e6), { id: "s", daily_budget_micro: 20e6 }).patch.daily_budget_micro, 10e6);
  // a broken limit setting stops undo as well
  assert.throws(() => planUndo(entry("daily_budget_micro", 10e6, 20e6), { id: "s", daily_budget_micro: 20e6 }, { env: { SNAP_MAX_DAILY_BUDGET: "x" } }), /Unsafe configuration/);
});
