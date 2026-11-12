// List tools: every page is read, filters apply before the limit, and anything left out is said out loud.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACC, sampleWorld, setup } from "./helpers/harness.js";

const manyCampaigns = (n, activeEvery = 0) => {
  const w = sampleWorld();
  w.campaigns = {};
  for (let i = 1; i <= n; i++) w.campaigns[`c${i}`] = { id: `c${i}`, name: `Campaign ${i}`, status: activeEvery && i % activeEvery === 0 ? "ACTIVE" : "PAUSED", ad_account_id: ACC, updated_at: "t0" };
  return w;
};
const noteOf = (r) => r.content.slice(1).map((c) => c.text).join(" ");

test("a campaign beyond the first page is found, and the status filter sees every campaign (the bug that hid active campaigns)", async () => {
  const t = await setup({ world: manyCampaigns(230, 100) }); // active: c100, c200 — both beyond the first 100
  t.hooks.pageSize = 100;
  const active = await t.raw("snap_list_campaigns", { status: "ACTIVE" });
  assert.deepEqual(JSON.parse(active.content[0].text).map((c) => c.id), ["c100", "c200"]);
  assert.equal(active.content.length, 1, "complete list, nothing to warn about");
  const all = await t.raw("snap_list_campaigns", { limit: 500 });
  assert.equal(JSON.parse(all.content[0].text).length, 230);
  assert.equal(t.calls.filter((c) => c.path.endsWith("/campaigns")).length, 3 + 3, "3 pages each, nothing re-read from cache");
  await t.close();
});

test("when more rows match than the limit, the result is still an array and a note says how many are left out", async () => {
  const t = await setup({ world: manyCampaigns(230) });
  const r = await t.raw("snap_list_campaigns", { limit: 100 });
  assert.equal(r.isError, undefined);
  assert.equal(JSON.parse(r.content[0].text).length, 100, "same array shape as before");
  assert.match(noteOf(r), /230 items match; showing the first 100/);
  const exact = await t.raw("snap_list_campaigns", { limit: 230 });
  assert.equal(exact.content.length, 1, "no note when everything is shown");
  await t.close();
});

test("a list that cannot be read in full says it is INCOMPLETE instead of looking complete", async () => {
  const w = manyCampaigns(30);
  for (let i = 1; i <= 25; i++) w.adsquads[`m${i}`] = { id: `m${i}`, name: `M${i}`, status: "ACTIVE", campaign_id: "c1", daily_budget_micro: 10e6, updated_at: "t0" };
  const t = await setup({ world: w });
  t.hooks.pageSize = 10;
  t.hooks.brokenPaging = true; // Snap's next-page link is unusable
  const r = await t.raw("snap_list_campaigns", {});
  assert.equal(JSON.parse(r.content[0].text).length, 10, "what was read is returned");
  assert.match(noteOf(r), /INCOMPLETE \(a next page could not be followed\)/);
  // the safety checks that need the whole list refuse instead of guessing
  const gate = await t.call("snap_set_status", { entity: "campaign", id: "c1", status: "ACTIVE" });
  assert.match(gate.error, /refusing to work on an incomplete list/);
  assert.equal(t.writes().length, 0);
  await t.close();
});

test("ad squads and ads of a campaign are read page by page, with the filter applied before the limit", async () => {
  const w = sampleWorld();
  for (let i = 1; i <= 120; i++) w.adsquads[`q${i}`] = { id: `q${i}`, name: `Q${i}`, status: i === 119 ? "ACTIVE" : "PAUSED", campaign_id: "c1", daily_budget_micro: 10e6, updated_at: "t0" };
  for (let i = 1; i <= 120; i++) w.ads[`z${i}`] = { id: `z${i}`, name: `Z${i}`, status: "PAUSED", ad_squad_id: "s1", creative_id: "cr1", updated_at: "t0" };
  const t = await setup({ world: w });
  t.hooks.pageSize = 50;
  const squads = JSON.parse((await t.raw("snap_list_adsquads", { campaign_id: "c1", status: "ACTIVE" })).content[0].text);
  assert.deepEqual(squads.map((s) => s.id).sort(), ["q119", "s1"]);
  const account = JSON.parse((await t.raw("snap_list_adsquads", { limit: 500 })).content[0].text);
  assert.ok(account.length >= 120);
  const ads = JSON.parse((await t.raw("snap_list_ads", { adsquad_id: "s1" })).content[0].text);
  assert.equal(ads.length, 121);
  await t.close();
});

test("creatives are listed from every page too", async () => {
  const w = sampleWorld();
  for (let i = 1; i <= 75; i++) w.creatives[`k${i}`] = { id: `k${i}`, name: `K${i}`, type: "WEB_VIEW", ad_account_id: ACC, updated_at: "t0" };
  const t = await setup({ world: w });
  const r = await t.raw("snap_list_creatives", { limit: 500 });
  assert.equal(JSON.parse(r.content[0].text).length, 76);
  const cut = await t.raw("snap_list_creatives", { limit: 50 });
  assert.equal(JSON.parse(cut.content[0].text).length, 50);
  assert.match(noteOf(cut), /76 creatives found; showing the first 50/);
  await t.close();
});

test("name_contains finds one item among thousands, before the limit is applied", async () => {
  const w = manyCampaigns(1200);
  w.campaigns.c1200.name = "ZY - SC - TEST - Empty Campaign - OCT26";
  w.campaigns.c3.name = "zy - sc - test - empty campaign - OCT26 (copy)";
  const t = await setup({ world: w });
  t.hooks.pageSize = 500;
  const r = await t.raw("snap_list_campaigns", { name_contains: "TEST - Empty Campaign", limit: 100 });
  assert.deepEqual(JSON.parse(r.content[0].text).map((c) => c.id).sort(), ["c1200", "c3"], "found past the 500-row mark, case-insensitive");
  assert.equal(r.content.length, 1, "complete and under the limit: no note");
  assert.deepEqual(JSON.parse((await t.raw("snap_list_campaigns", { name_contains: "no such name" })).content[0].text), []);
  const both = JSON.parse((await t.raw("snap_list_campaigns", { name_contains: "test", status: "PAUSED" })).content[0].text);
  assert.equal(both.length, 2);
  assert.equal((await t.raw("snap_list_campaigns", { name_contains: "" })).isError, true, "an empty filter is refused");
  await t.close();
});

test("name_contains works on ad squads and creatives as well", async () => {
  const t = await setup();
  assert.deepEqual(JSON.parse((await t.raw("snap_list_adsquads", { campaign_id: "c1", name_contains: "s2" })).content[0].text).map((s) => s.id), ["s2"]);
  assert.deepEqual(JSON.parse((await t.raw("snap_list_creatives", { name_contains: "ONE" })).content[0].text).map((c) => c.id), ["cr1"]);
  assert.deepEqual(JSON.parse((await t.raw("snap_list_creatives", { name_contains: "zzz" })).content[0].text), []);
  await t.close();
});
