import test from "node:test";
import assert from "node:assert/strict";
import { judgeBudget, budgetWarning } from "../src/budget-warning.js";
import { loadPolicy } from "../src/policy.js";

test("no warning for a normal amount, a warning for one far above what the account runs", () => {
  const squads = [50, 80, 100];
  assert.equal(judgeBudget({ added: 120, squadBudgets: squads, maxDailyBudget: 1000 }), null, "within twice the largest running ad squad");
  const w = judgeBudget({ added: 500, squadBudgets: squads, maxDailyBudget: 1000, currency: "USD" });
  assert.equal(w.level, "HIGHER_THAN_NORMAL");
  assert.match(w.message, /500 USD/);
  assert.match(w.message, /twice your largest running ad squad/);
  assert.equal(w.largest_running_daily_budget, 100);
  assert.equal(w.typical_running_daily_budget, 80);
});

test("nothing added means no warning", () => {
  assert.equal(judgeBudget({ added: 0, squadBudgets: [10], maxDailyBudget: 1000 }), null);
  assert.equal(judgeBudget({ added: -5, squadBudgets: [10], maxDailyBudget: 1000 }), null);
});

test("with no running ad squad to compare with, more than half the limit warns", () => {
  assert.equal(judgeBudget({ added: 400, squadBudgets: [], maxDailyBudget: 1000 }), null);
  assert.match(judgeBudget({ added: 600, squadBudgets: [], maxDailyBudget: 1000 }).message, /half of your limit/);
});

test("your own warning level (SNAP_WARN_DAILY_BUDGET) warns even on an account with big budgets", () => {
  const w = judgeBudget({ added: 150, squadBudgets: [200, 300], maxDailyBudget: 1000, warnAbove: 100 });
  assert.match(w.message, /warning level of 100/);
  assert.equal(judgeBudget({ added: 90, squadBudgets: [200, 300], maxDailyBudget: 1000, warnAbove: 100 }), null);
});

test("SNAP_WARN_DAILY_BUDGET is validated and optional", () => {
  assert.equal(loadPolicy({}).warnDailyBudget, null);
  assert.equal(loadPolicy({ SNAP_WARN_DAILY_BUDGET: "75" }).warnDailyBudget, 75);
  for (const bad of ["abc", "-3", "0"]) assert.throws(() => loadPolicy({ SNAP_WARN_DAILY_BUDGET: bad }), /SNAP_WARN_DAILY_BUDGET/, bad);
});

test("a warning never blocks a preview: if the ad squads cannot be read there is simply no warning", async () => {
  const client = { listPaged: async () => { throw new Error("boom"); } };
  const policy = loadPolicy({ SNAP_MAX_DAILY_BUDGET: "1000" });
  assert.equal(await budgetWarning(client, "acc", { added: 100, policy }), null, "100 is below half the limit");
  assert.equal((await budgetWarning(client, "acc", { added: 900, policy })).level, "HIGHER_THAN_NORMAL", "no comparison available, so the half-of-limit rule applies");
});

test("only running ad squads with a daily budget count as normal", async () => {
  const client = { listPaged: async () => ({ items: [
    { status: "ACTIVE", daily_budget_micro: 100e6 },
    { status: "PAUSED", daily_budget_micro: 9000e6 },
    { status: "ACTIVE", lifetime_budget_micro: 500e6 },
  ] }) };
  const policy = loadPolicy({});
  const w = await budgetWarning(client, "acc", { added: 250, policy });
  assert.equal(w.largest_running_daily_budget, 100, "the paused ad squad is ignored");
});

import { setup } from "./helpers/harness.js";

test("in a real preview: a raise far above the running ad squads shows a budget_warning and can still be approved", async () => {
  const t = await setup({ env: { SNAP_MAX_BUDGET_INCREASE_PCT: "1000", SNAP_MAX_ADDED_DAILY_BUDGET_24H: "5000", SNAP_MAX_ACTIVATION_DAILY_BUDGET: "5000" } });
  const big = await t.call("snap_set_daily_budget", { entity: "adsquad", id: "s3", daily_budget: 300 });
  assert.equal(big.data.budget_warning.level, "HIGHER_THAN_NORMAL");
  assert.match(big.data.budget_warning.message, /adds 270/);
  assert.ok(big.data.approval_token, "it is a warning, not a block: the preview can still be approved");
  const small = await t.call("snap_set_daily_budget", { entity: "adsquad", id: "s3", daily_budget: 40 });
  assert.equal(small.data.budget_warning, undefined, "a normal raise shows no warning");
});
