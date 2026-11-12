// Independent verification pass: attempts to get around the money limits, the approvals and the account boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { ACC, sampleWorld, setup } from "./helpers/harness.js";
import { loadPolicy } from "../src/policy.js";
import { planBudget, planUndo } from "../src/changes.js";
import { countedDaily, scheduleOpensDelivery } from "../src/activation.js";
import { addedDailyBudgetInWindow } from "../src/audit-log.js";

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const squad = (id, campaign_id, budget, o = {}) => ({ id, name: `Squad ${id}`, status: "ACTIVE", campaign_id, daily_budget_micro: budget * 1e6, bid_micro: 2e6, targeting: {}, updated_at: "t0", ...o });
const logEntry = (o) => JSON.stringify({ at: new Date().toISOString(), verified: true, name: "x", change: "x", ...o }) + "\n";
const puts = (t) => t.writes().filter((c) => c.method === "PUT").length;

function scheduleWorld() {
  const w = sampleWorld();
  w.adsquads.f1 = squad("f1", "c1", 100, { start_time: FUTURE }); // ACTIVE, starts in the future
  w.adsquads.e1 = squad("e1", "c1", 60, { start_time: PAST, end_time: "2021-01-01T00:00:00.000Z" }); // ACTIVE, ended
  w.adsquads.p1 = squad("p1", "c1", 500, { status: "PAUSED", start_time: FUTURE });
  w.adsquads.r1 = squad("r1", "c1", 40, { start_time: PAST, end_time: "2090-01-01T00:00:00.000Z" }); // running
  w.campaigns.c3 = { id: "c3", name: "Campaign c3", status: "ACTIVE", ad_account_id: ACC, start_time: FUTURE, updated_at: "t0" };
  w.adsquads.g1 = squad("g1", "c3", 70);
  w.adsquads.g2 = squad("g2", "c3", 90);
  return w;
}

test("schedule: which edits let an ACTIVE item deliver sooner", () => {
  const now = Date.parse("2026-06-01T00:00:00Z");
  const a = (o) => ({ status: "ACTIVE", ...o });
  assert.equal(scheduleOpensDelivery(a({ start_time: FUTURE }), { start_time: PAST }, now), true, "future start pulled into the past");
  assert.equal(scheduleOpensDelivery(a({ start_time: FUTURE }), { start_time: "2098-01-01T00:00:00Z" }, now), true, "future start pulled earlier");
  assert.equal(scheduleOpensDelivery(a({ start_time: FUTURE }), { start_time: "2099-06-01T00:00:00Z" }, now), false, "pushed later");
  assert.equal(scheduleOpensDelivery(a({ start_time: PAST, end_time: "2021-01-01T00:00:00Z" }), { end_time: FUTURE }, now), true, "ended item revived");
  assert.equal(scheduleOpensDelivery(a({ start_time: PAST, end_time: "2090-01-01T00:00:00Z" }), { end_time: FUTURE }, now), false, "running item extended");
  assert.equal(scheduleOpensDelivery({ status: "PAUSED", start_time: FUTURE }, { start_time: PAST }, now), false, "paused items start nothing");
  assert.equal(scheduleOpensDelivery(a({ start_time: PAST }), { start_time: "2019-01-01T00:00:00Z" }, now), false, "already running");
});

test("bypass closed: a schedule edit that starts delivery is checked and limited like enabling", async () => {
  const t = await setup({ world: scheduleWorld() });
  const p = (await t.call("snap_set_schedule", { entity: "adsquad", id: "f1", start_time: "2026-01-01T00:00:00+03:00" })).data;
  assert.equal(p.activation.daily_budget_that_starts_delivering, 100);
  assert.match(p.activation.reason, /checked like enabling/);
  assert.equal(p.spend_impact.adds_daily_budget, 100);
  // reviving an ended squad
  assert.equal((await t.call("snap_set_schedule", { entity: "adsquad", id: "e1", end_time: "2099-01-01T00:00:00+03:00" })).data.activation.daily_budget_that_starts_delivering, 60);
  // a campaign whose future start is pulled in starts its ACTIVE squads
  assert.equal((await t.call("snap_set_schedule", { entity: "campaign", id: "c3", start_time: "2026-01-01T00:00:00+03:00" })).data.activation.daily_budget_that_starts_delivering, 160);
  // not activations: a paused squad, and a running squad whose end is moved
  assert.equal((await t.call("snap_set_schedule", { entity: "adsquad", id: "p1", start_time: "2026-01-01T00:00:00+03:00" })).data.activation, undefined);
  assert.equal((await t.call("snap_set_schedule", { entity: "adsquad", id: "r1", end_time: "2099-01-01T00:00:00+03:00" })).data.activation, undefined);
  // bulk counts all of them together
  const bulk = (await t.call("snap_bulk_set_schedule", { entity: "adsquad", ids: ["f1", "r1"], start_time: "2026-01-01T00:00:00+03:00" })).data;
  assert.equal(bulk.activation.daily_budget_that_starts_delivering, 100);
  await t.close();

  const capped = await setup({ world: scheduleWorld(), env: { SNAP_MAX_ACTIVATION_DAILY_BUDGET: "90", SNAP_MAX_ADDED_DAILY_BUDGET_24H: "1000" } });
  for (const [name, args] of [
    ["snap_set_schedule", { entity: "adsquad", id: "f1", start_time: "2026-01-01T00:00:00+03:00" }],
    ["snap_set_schedule", { entity: "campaign", id: "c3", start_time: "2026-01-01T00:00:00+03:00" }],
    ["snap_bulk_set_schedule", { entity: "adsquad", ids: ["f1"], start_time: "2026-01-01T00:00:00+03:00" }],
  ]) assert.match((await capped.call(name, args)).error ?? "", /SNAP_MAX_ACTIVATION_DAILY_BUDGET/, name);
  // and through undo: a log entry that would put an early start back
  writeFileSync(capped.logFile, logEntry({ entity: "adsquad", id: "f1", patch: { start_time: FUTURE }, before: { start_time: PAST }, after: { start_time: FUTURE } }));
  assert.match((await capped.call("snap_undo", {})).error, /SNAP_MAX_ACTIVATION_DAILY_BUDGET/);
  assert.equal(capped.writes().length, 0);
  await capped.close();
});

test("bypass closed: many small enables and raises cannot exceed the 24-hour account limit, even if the log is deleted", async () => {
  const t = await setup({ env: { SNAP_MAX_ADDED_DAILY_BUDGET_24H: "120" } });
  // enable s2 (100/day under an ACTIVE campaign)
  const first = await t.twoStep("snap_set_status", { entity: "adsquad", id: "s2", status: "ACTIVE" });
  assert.equal(first.applied.data.applied, true);
  assert.equal(first.preview.data.spend_impact.adds_daily_budget, 100);
  assert.equal(t.log().find((e) => e.phase === "intent").added_daily_budget, 100);
  assert.equal(addedDailyBudgetInWindow(t.logFile), 100);
  // enabling campaign c2 would start another 80: over the 24h limit, through every route
  assert.match((await t.call("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE" })).error, /already added through this server in the last 24 hours/);
  assert.match((await t.call("snap_set_status_bulk", { entity: "campaign", ids: ["c2"], status: "ACTIVE" })).error, /SNAP_MAX_ADDED_DAILY_BUDGET_24H/);
  // a raise of 10 still fits (110), the next raise does not
  assert.equal((await t.twoStep("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 20 })).applied.data.applied, true);
  assert.match((await t.call("snap_set_daily_budget", { entity: "adsquad", id: "s3", daily_budget: 45 })).error, /SNAP_MAX_ADDED_DAILY_BUDGET_24H/);
  assert.match(JSON.stringify((await t.call("snap_bulk_set_budget", { adsquad_ids: ["s3", "s4"], mode: "scale", value: 1.5 })).error), /SNAP_MAX_ADDED_DAILY_BUDGET_24H/);
  // lowering and pausing are never blocked
  assert.equal((await t.twoStep("snap_set_daily_budget", { entity: "adsquad", id: "s3", daily_budget: 20 })).applied.data.applied, true);
  assert.equal((await t.twoStep("snap_set_status", { entity: "adsquad", id: "s2", status: "PAUSED" })).applied.data.applied, true);

  // deleting the log while the server runs resets nothing
  rmSync(t.logFile);
  assert.equal(addedDailyBudgetInWindow(t.logFile), 110);
  assert.match((await t.call("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE" })).error, /SNAP_MAX_ADDED_DAILY_BUDGET_24H/);
  assert.match((await t.call("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 40 })).error, /per 24h/, "the per-item 24h rule survives too");
  await t.close();
});

test("concurrency: one token, or two approvals of the same change, never apply twice", async () => {
  const t = await setup();
  const args = { entity: "adsquad", id: "s1", daily_budget: 15 };
  const p = (await t.call("snap_set_daily_budget", args)).data;
  const same = await Promise.all([1, 2, 3].map(() => t.call("snap_set_daily_budget", { ...args, confirm: true, approval_token: p.approval_token })));
  assert.equal(same.filter((r) => r.data?.applied).length, 1);
  assert.equal(same.filter((r) => /already used/.test(r.error ?? "")).length, 2);
  assert.equal(puts(t), 1);

  // two separate previews of the same change, confirmed at the same time
  const a2 = { entity: "adsquad", id: "s3", daily_budget: 40 };
  const [x, y] = [(await t.call("snap_set_daily_budget", a2)).data, (await t.call("snap_set_daily_budget", a2)).data];
  assert.notEqual(x.approval_token, y.approval_token);
  const both = await Promise.all([x, y].map((v) => t.call("snap_set_daily_budget", { ...a2, confirm: true, approval_token: v.approval_token })));
  assert.ok(both.filter((r) => r.data?.applied).length >= 1);
  assert.equal(t.db.adsquads.s3.daily_budget_micro, 40e6);
  // whatever the interleaving, the squad ends at the approved value and the ledger counts each accepted intent
  assert.ok(addedDailyBudgetInWindow(t.logFile) <= 5 + 10 * both.filter((r) => r.data?.applied).length);
  await t.close();

  // two different activations racing for a limit that only fits one
  const race = await setup({ env: { SNAP_MAX_ADDED_DAILY_BUDGET_24H: "120" } });
  const e1 = (await race.call("snap_set_status", { entity: "adsquad", id: "s2", status: "ACTIVE" })).data;
  const e2 = (await race.call("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE" })).data;
  const out = await Promise.all([
    race.call("snap_set_status", { entity: "adsquad", id: "s2", status: "ACTIVE", confirm: true, approval_token: e1.approval_token }),
    race.call("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE", confirm: true, approval_token: e2.approval_token }),
  ]);
  assert.equal(out.filter((r) => r.data?.applied).length, 1, JSON.stringify(out).slice(0, 400));
  assert.match(out.find((r) => r.error).error, /SNAP_MAX_ADDED_DAILY_BUDGET_24H/);
  assert.equal(puts(race), 1);
  await race.close();
});

test("undo cannot be steered by a doctored log entry", async () => {
  const cur = { id: "s1", status: "PAUSED", daily_budget_micro: 10e6, name: "Squad s1" };
  const e = (patch, before) => ({ entity: "adsquad", id: "s1", change: "x", patch, before, after: patch });
  assert.throws(() => planUndo(e({ lifetime_budget_micro: 1 }, { lifetime_budget_micro: 9e12 }), cur, { force: true }), /never edits/);
  assert.throws(() => planUndo(e({ bid_strategy: "x" }, { bid_strategy: "AUTO_BID" }), cur, { force: true }), /never edits/);
  assert.throws(() => planUndo(e({ status: "PAUSED" }, { status: "DELETED" }), cur, { force: true }), /other than ACTIVE or PAUSED/);
  assert.throws(() => planUndo(e({ daily_budget_micro: 10e6 }, { daily_budget_micro: "9000000000" }), cur, { force: true }), /no valid earlier daily_budget_micro/);
  assert.throws(() => planUndo(e({ daily_budget_micro: 10e6 }, { daily_budget_micro: -5 }), cur, { force: true }), /no valid earlier/);
  assert.throws(() => planUndo(e({ name: "Squad s1" }, { name: "" }), cur, { force: true }), /no valid earlier name/);
  assert.throws(() => planUndo({ entity: "adsquad", id: "s1", patch: {}, before: {} }, cur), /nothing that can be undone/);
  // a forged entry inside the window still cannot pass the absolute ceiling
  assert.throws(() => planUndo(e({ daily_budget_micro: 10e6 }, { daily_budget_micro: 5000e6 }), cur, { force: true, history: () => 5000e6 }), /absolute limit of 1000/);

  // through the tool: forged entries for another account, and for a field the server never edits
  const t = await setup();
  writeFileSync(t.logFile, logEntry({ entity: "adsquad", id: "sx", patch: { name: "Squad sx" }, before: { name: "Old name" }, after: { name: "Squad sx" } }));
  assert.match((await t.call("snap_undo", {})).error, /another ad account/);
  appendFileSync(t.logFile, logEntry({ entity: "adsquad", id: "s1", patch: { lifetime_budget_micro: 1 }, before: { lifetime_budget_micro: 9e12 }, after: { lifetime_budget_micro: 1 } }));
  assert.match((await t.call("snap_undo", { force: true })).error, /never edits/);
  appendFileSync(t.logFile, logEntry({ entity: "segment", id: "111", patch: { name: "Buyers" }, before: { name: "Other" }, after: { name: "Buyers" } }));
  assert.match((await t.call("snap_undo", {})).error, /cannot be undone/);
  assert.equal(t.writes().length, 0);
  await t.close();
});

test("lifetime-only ad squads are counted at their daily pace when enabled", async () => {
  const now = Date.parse("2026-06-01T00:00:00Z");
  assert.equal(countedDaily({ daily_budget_micro: 50e6, lifetime_budget_micro: 9000e6 }, now), 50);
  assert.equal(countedDaily({ lifetime_budget_micro: 9000e6, end_time: "2026-06-04T00:00:00Z" }, now), 3000);
  assert.equal(countedDaily({ lifetime_budget_micro: 9000e6 }, now), 9000, "no end date: all of it could be spent at once");
  assert.equal(countedDaily({ lifetime_budget_micro: 9000e6, end_time: "2020-01-01T00:00:00Z" }, now), 9000);
  assert.equal(countedDaily({}, now), 0);

  const w = sampleWorld();
  const inThreeDays = new Date(Date.now() + 3 * 86_400_000 - 60_000).toISOString();
  w.adsquads.l1 = squad("l1", "c1", 0, { status: "PAUSED", daily_budget_micro: null, lifetime_budget_micro: 9000e6, end_time: inThreeDays });
  w.adsquads.l2 = squad("l2", "c1", 0, { status: "PAUSED", daily_budget_micro: null, lifetime_budget_micro: 9000e6 });
  const t = await setup({ world: w });
  const paced = (await t.call("snap_set_status", { entity: "adsquad", id: "l1", status: "ACTIVE" })).data;
  assert.equal(paced.activation.daily_budget_that_starts_delivering, 3000);
  assert.equal(paced.activation.ad_squads_that_start_delivering[0].counted_per_day, 3000);
  assert.match((await t.call("snap_set_status", { entity: "adsquad", id: "l2", status: "ACTIVE" })).error, /would start 9000 of daily budget/);
  await t.close();
});

test("configuration cannot be loosened from inside: fake policy objects, late env edits, unknown values", async () => {
  // an object that merely claims to be a policy is parsed as ordinary settings (defaults apply)
  const fake = { __policy: true, maxDailyBudget: Infinity, maxIncreasePct: Infinity, minDailyBudget: 0 };
  assert.throws(() => planBudget({ id: "s", daily_budget_micro: 10e6 }, 5000, fake), /per step|absolute limit/);
  assert.equal(loadPolicy(fake).maxDailyBudget, 1000);
  assert.throws(() => loadPolicy({ SNAP_MAX_ADDED_DAILY_BUDGET_24H: "unlimited" }), /Unsafe configuration/);
  assert.equal(loadPolicy({ SNAP_MAX_ACTIVATION_DAILY_BUDGET: "300" }).maxAddedDailyBudget24h, 600);

  // editing the environment after the server started changes nothing
  const t = await setup({ env: { SNAP_MAX_DAILY_BUDGET: "15" } });
  t.env.SNAP_MAX_DAILY_BUDGET = "100000";
  t.env.SNAP_MAX_BUDGET_INCREASE_PCT = "100000";
  t.env.SNAP_AD_ACCOUNT_ID = "acc-OTHER";
  t.env.SNAP_READ_ONLY = "0";
  assert.match((await t.call("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 20 })).error, /absolute limit of 15/);
  assert.match((await t.call("snap_set_status", { entity: "adsquad", id: "sx", status: "PAUSED" })).error, /another ad account/);
  assert.equal((await t.call("snap_ping", {})).data.safety_limits.maxDailyBudget, 15);
  await t.close();
});

test("cross-account: every remaining write path refuses foreign items", async () => {
  const w = sampleWorld();
  w.creatives.crx = { id: "crx", name: "Foreign creative", type: "WEB_VIEW", ad_account_id: "acc-OTHER", web_view_properties: { url: "https://example.com/" } };
  w.segments[999] = { id: "999", name: "Foreign buyers", ad_account_id: "acc-OTHER", source_type: "FIRST_PARTY" };
  w.ads.ax = { id: "ax", name: "Foreign ad", status: "PAUSED", ad_squad_id: "sx", creative_id: "crx", type: "REMOTE_WEBPAGE" };
  const t = await setup({ world: w });
  const code = "adcode_12345678-1234-1234-1234-123456789abc";
  for (const [name, args] of [
    ["snap_clone_creative", { creative_id: "crx", name: "Stolen copy" }],
    ["snap_create_lookalike", { seed_segment_id: "999", name: "Lookalike of foreign" }],
    ["snap_delete", { entity: "segment", id: "999" }],
    ["snap_clone_ad", { ad_id: "a1", target_adsquad_ids: ["sx"] }],
    ["snap_clone_ad", { ad_id: "ax", target_adsquad_ids: ["s1"] }],
    ["snap_influencer_ad", { ad_code: code, adsquad_id: "sx", name: "Paid - x", headline: "Hi", url: "https://example.com/" }],
    ["snap_influencer_batch", { adsquad_id: "sx", items: [{ ad_code: code, name: "Paid - x" }], headline: "Hi", url: "https://example.com/" }],
    ["snap_set_targeting", { adsquad_id: "sx", countries: ["ae"] }],
    ["snap_set_schedule", { entity: "campaign", id: "cx", end_time: "2099-01-01T00:00:00+03:00" }],
    ["snap_set_bid", { adsquad_id: "sx", bid: 2.5 }],
    ["snap_exclude_segments", { adsquad_id: "sx", segment_ids: ["111"] }],
    ["snap_bulk_rename", { entity: "campaign", ids: ["c1", "cx"], find: "Campaign", replace: "Camp" }],
    ["snap_copy_campaign", { campaign_id: "cx", new_name: "Copy of foreign" }],
    ["snap_copy_campaign", { campaign_id: "c1", new_name: "Copy into foreign", resume_campaign_id: "cx" }],
  ]) {
    const r = await t.call(name, args);
    assert.match(r.error ?? "", /another ad account|must be a PAUSED campaign/, `${name} ${JSON.stringify(args)} -> ${JSON.stringify(r.data ?? r.error).slice(0, 160)}`);
  }
  assert.equal(t.writes().length, 0);
  await t.close();
});

test("human approval: the code is shown only to the person, never to the model, and a wrong or missing code is refused", async () => {
  const enable = { entity: "adsquad", id: "s2", status: "ACTIVE" };
  const codeOf = (m) => m.match(/type this code: (\d{4})/)?.[1];

  const blind = await setup({ env: { SNAP_HUMAN_APPROVAL: "elicit" }, elicit: async () => ({ action: "accept", content: { approve: true } }) });
  assert.match((await blind.twoStep("snap_set_status", enable)).applied.error, /confirmation code did not match/);
  assert.equal(blind.writes().length, 0);
  await blind.close();

  const wrong = await setup({ env: { SNAP_HUMAN_APPROVAL: "elicit" }, elicit: async () => ({ action: "accept", content: { approve: true, confirmation_code: "0000" } }) });
  assert.match((await wrong.twoStep("snap_set_status", enable)).applied.error, /confirmation code did not match/);
  await wrong.close();

  let shown;
  const ok = await setup({
    env: { SNAP_HUMAN_APPROVAL: "elicit" },
    elicit: async (params) => {
      const code = codeOf(params.message);
      if (code) shown = code;
      return { action: "accept", content: code ? { approve: true, confirmation_code: code } : { approve: true } };
    },
  });
  const r = await ok.twoStep("snap_set_status", enable);
  assert.equal(r.applied.data.applied, true);
  assert.match(shown, /^\d{4}$/);
  assert.match(ok.asked[0], /THIS ADDS 100 PER DAY/);
  // nothing the model can read contains the code: not the preview, not the result, not the audit log
  const modelVisible = JSON.stringify([r.preview, r.applied, ok.log()]);
  assert.ok(!/type this code|confirmation_code/.test(modelVisible));
  // pausing and renaming need a tick only
  const plain = await ok.twoStep("snap_rename", { entity: "adsquad", id: "s1", new_name: "Squad one renamed" });
  assert.equal(plain.applied.data?.applied, true, plain.applied.error);
  assert.ok(!/type this code/.test(ok.asked[1]));
  // deleting always needs the code
  const del = await ok.call("snap_delete", { entity: "ad", id: "a2" });
  await ok.call("snap_delete", { entity: "ad", id: "a2", confirm_name: "Ad a2", confirm: true, approval_token: del.data.approval_token });
  assert.match(ok.asked[2], /snap_delete[\s\S]*type this code/);
  await ok.close();
});

test("audit log integrity: one parseable line per record, private file, spend recorded, nothing sensitive", async () => {
  const t = await setup();
  await t.twoStep("snap_rename", { entity: "adsquad", id: "s1", new_name: "Line one\nline two {\"kind\":\"audit\"}" });
  await t.twoStep("snap_set_status", { entity: "adsquad", id: "s2", status: "ACTIVE" });
  const log = t.log();
  assert.equal(log.filter((e) => e.kind === "audit").length, 4, "two intents and two results, no injected record");
  assert.deepEqual(log.filter((e) => e.phase === "intent").map((e) => e.added_daily_budget ?? 0), [0, 100]);
  assert.ok(log.every((e) => !Number.isNaN(Date.parse(e.at))));
  const raw = JSON.stringify(log);
  assert.ok(!raw.includes("test-access-token") && !/apr_[A-Za-z0-9_-]{10,}/.test(raw) && !raw.includes("\"SNAP_CLIENT_SECRET\""));
  await t.close();
});

test("enabling a campaign and its ad squad in two separate steps still counts the budget once it can deliver", async () => {
  // c2 is PAUSED with ACTIVE squads s3 (30) and s4 (50) and a PAUSED squad s5 (70)
  const squadFirst = await setup({ env: { SNAP_MAX_ADDED_DAILY_BUDGET_24H: "1000" } });
  const a = await squadFirst.twoStep("snap_set_status", { entity: "adsquad", id: "s5", status: "ACTIVE" });
  assert.equal(a.preview.data.activation.starts_later[0].daily_budget, 70, "the preview says what starts later");
  assert.equal(a.preview.data.spend_impact, undefined, "nothing can deliver yet, nothing is counted yet");
  assert.equal(addedDailyBudgetInWindow(squadFirst.logFile), 0);
  const b = await squadFirst.twoStep("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE" });
  assert.equal(b.preview.data.activation.daily_budget_that_starts_delivering, 150, "30 + 50 + the squad enabled in step one");
  assert.equal(addedDailyBudgetInWindow(squadFirst.logFile), 150, "counted when it becomes able to deliver");
  await squadFirst.close();

  // the other order: the campaign first (its squads are paused or counted), then the squad under a live campaign
  const campaignFirst = await setup({ env: { SNAP_MAX_ADDED_DAILY_BUDGET_24H: "200" } });
  await campaignFirst.twoStep("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE" });
  assert.equal(addedDailyBudgetInWindow(campaignFirst.logFile), 80);
  const c = await campaignFirst.call("snap_set_status", { entity: "adsquad", id: "s5", status: "ACTIVE" });
  assert.equal(c.data.activation.daily_budget_that_starts_delivering, 70);
  assert.equal(c.data.spend_impact.already_added_last_24h, 80);
  // 80 + 70 fits under 200; a limit of 120 would refuse the second step
  await campaignFirst.close();
  const tight = await setup({ env: { SNAP_MAX_ADDED_DAILY_BUDGET_24H: "120" } });
  await tight.twoStep("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE" });
  assert.match((await tight.call("snap_set_status", { entity: "adsquad", id: "s5", status: "ACTIVE" })).error, /SNAP_MAX_ADDED_DAILY_BUDGET_24H/);
  assert.equal(tight.db.adsquads.s5.status, "PAUSED");
  await tight.close();
});
