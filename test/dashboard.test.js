import test from "node:test";
import assert from "node:assert/strict";
import { boardData, dashboardData } from "../src/dashboard.js";
import { statsClient } from "./helpers/stats-client.js";

const NOW = new Date("2026-11-21T10:00:00Z");

test("dashboard: totals, daily rows and pacing come from the account's numbers", async () => {
  const d = await dashboardData(statsClient(), { adAccountId: "acc", days: 7, currency: "USD", now: NOW });
  assert.equal(d.totals.spend, 280, "10+20+...+70");
  assert.equal(d.totals.purchases, 28);
  assert.equal(d.totals.roas, 3, "value is 3x spend");
  assert.equal(d.totals.cpa, 10);
  assert.equal(d.daily.length, 7);
  assert.deepEqual(d.daily[0], { date: "2026-11-14", spend: 10, purchases: 1, roas: 3 });
  assert.equal(d.range.days, 7);
  assert.equal(d.pacing.active_squads, 1);
  assert.equal(d.pacing.active_daily_budgets_total, 25);
  assert.match(d.summary, /spend 280 USD, 28 purchases, ROAS 3/);
  assert.equal(d.warnings, undefined);
});

test("dashboard: the period must be 1 to 30 whole days", async () => {
  for (const bad of [0, 31, 1.5, "7"]) await assert.rejects(dashboardData(statsClient(), { adAccountId: "acc", days: bad, now: NOW }), /days must be/);
});

test("dashboard: when pacing cannot be read the rest is still shown, with a warning", async () => {
  const c = statsClient();
  const base = c.request.bind(c);
  c.request = async (m, p, o) => {
    if (o?.query?.breakdown === "adsquad") throw new Error("boom");
    return base(m, p, o);
  };
  const d = await dashboardData(c, { adAccountId: "acc", days: 7, now: NOW });
  assert.equal(d.pacing, null);
  assert.match(d.warnings[0], /Pacing could not be read/);
  assert.equal(d.totals.spend, 280);
});

test("board: campaigns with 7-day spend, ROAS and active budgets, active ones first", async () => {
  const d = await boardData(statsClient(), { adAccountId: "acc", currency: "USD", now: NOW });
  assert.equal(d.total_campaigns, 2);
  assert.deepEqual(d.campaigns.map((c) => [c.id, c.status, c.spend_7d, c.roas_7d, c.active_daily_budget]), [["c1", "ACTIVE", 70, 3, 25], ["c2", "PAUSED", 0, null, null]]);
  assert.match(d.summary, /2 campaigns \(1 active\)/);
  const only = await boardData(statsClient(), { adAccountId: "acc", status: "PAUSED", now: NOW });
  assert.deepEqual(only.campaigns.map((c) => c.id), ["c2"]);
  const cut = await boardData(statsClient(), { adAccountId: "acc", limit: 1, now: NOW });
  assert.equal(cut.has_more, true);
  assert.equal(cut.campaigns.length, 1);
});

test("board: a failed spend query leaves the list usable, with a warning", async () => {
  const c = statsClient();
  const base = c.request.bind(c);
  c.request = async (m, p, o) => {
    if (o?.query?.breakdown === "campaign") throw new Error("nope");
    return base(m, p, o);
  };
  const d = await boardData(c, { adAccountId: "acc", now: NOW });
  assert.equal(d.campaigns.length, 2);
  assert.match(d.warnings[0], /Spend could not be read/);
});
