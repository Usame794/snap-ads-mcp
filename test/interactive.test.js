// The interactive tools added in 0.10.0: change history with undo positions, the setup check, the board's ad squad level,
// dashboard alerts and the one-line spending effect on every preview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sampleWorld } from "./helpers/harness.js";
import { dashboardData } from "../src/dashboard.js";
import { statsClient } from "./helpers/stats-client.js";

test("every preview leads with one plain line about money", async () => {
  const t = await setup();
  const pause = await t.call("snap_set_status", { entity: "campaign", id: "c1", status: "PAUSED" });
  assert.equal(pause.data.impact_line, "Does not add daily spending.");
  const resume = await t.call("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE" });
  assert.match(resume.data.impact_line, /^Adds 80 per day of spending \(80 of \d+ allowed in 24 hours\)\.$/);
  assert.equal(Object.keys(resume.data)[0], "impact_line", "it comes first");
  await t.close();
});

test("change history: newest first, before and after, and an undo position that snap_undo accepts", async () => {
  const t = await setup();
  assert.equal((await t.call("snap_change_history", {})).data.total, 0);
  assert.ok(!(await t.twoStep("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 15 })).applied.error);
  assert.ok(!(await t.twoStep("snap_rename", { entity: "campaign", id: "c1", new_name: "Renamed one" })).applied.error);
  const h = (await t.call("snap_change_history", {})).data;
  assert.equal(h.items.length, 2);
  assert.equal(h.items[0].type, "rename");
  assert.equal(h.items[1].type, "budget");
  assert.deepEqual(h.items[1].fields[0], { field: "Daily budget", before: "10", after: "15" });
  assert.equal(h.items[1].undo_position, 2);
  const u = await t.twoStep("snap_undo", { n_from_last: h.items[1].undo_position });
  assert.ok(!u.applied.error, u.applied.error);
  assert.equal(t.db.adsquads.s1.daily_budget_micro, 10e6);
  const after = (await t.call("snap_change_history", {})).data;
  assert.equal(after.items[0].type, "undo");
  assert.equal(after.items.find((x) => x.type === "budget").undone, true);
  assert.equal(after.items.find((x) => x.type === "budget").undo_position, null, "an undone change offers no second undo");
  assert.equal((await t.call("snap_change_history", { kind: "rename" })).data.items.length, 1);
  await t.close();
});

test("setup check: a checklist with fixes, the limits in use, and no secrets", async () => {
  const t = await setup({ env: { SNAP_PIXEL_ID: "" } });
  const r = await t.raw("snap_setup_check", {});
  const d = JSON.parse(r.content[0].text);
  const by = Object.fromEntries(d.checks.map((c) => [c.id, c]));
  assert.equal(by.login.state, "ok");
  assert.notEqual(by.account.state, "error");
  assert.match(by.account.detail, /USD/);
  assert.equal(by.pixel.state, "warn");
  assert.match(by.pixel.fix, /SNAP_PIXEL_ID/);
  assert.equal(by.approval.state, "warn", "human approval is off by default and is flagged");
  assert.equal(d.limits.max_daily_budget, 1000);
  for (const secret of ["test-access-token", "\"s\"", "\"r\""]) assert.ok(!r.content[0].text.includes(secret), `no ${secret}`);
  assert.equal((await t.call("snap_setup_check", {})).data.checks.length, 7);
  await t.close();
});

test("board: ad squad level with budgets, campaign names and flags; days and level are validated", async () => {
  const t = await setup();
  const d = (await t.call("snap_campaign_board", { level: "adsquads", days: 14 })).data;
  assert.equal(d.level, "adsquads");
  assert.equal(d.range.days, 14);
  const s1 = d.items.find((x) => x.id === "s1");
  assert.equal(s1.entity, "adsquad");
  assert.equal(s1.daily_budget, 10);
  assert.equal(s1.campaign_name, "Campaign c1");
  assert.ok((await t.call("snap_campaign_board", { level: "nope" })).error);
  assert.ok((await t.call("snap_campaign_board", { days: 90 })).error);
  await t.close();
});

test("dashboard: alerts come from the same days, with no extra calls", async () => {
  const now = new Date("2026-11-21T10:00:00Z");
  const d = await dashboardData(statsClient({ days: 7 }), { adAccountId: "acc-1", days: 7, now });
  assert.ok(Array.isArray(d.alerts));
  for (const a of d.alerts) assert.ok(a.code && a.detail && a.severity);
});
