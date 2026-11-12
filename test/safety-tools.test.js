// End-to-end safety tests: the real MCP tools over an in-memory transport against a fake Snap API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "../src/env.js";
import { ACC, sampleWorld, setup } from "./helpers/harness.js";

const AD_CODE = "adcode_12345678-1234-1234-1234-123456789abc";
const puts = (t) => t.writes().filter((c) => c.method === "PUT").length;

test("execution needs a previewed approval: confirm=true alone changes nothing", async () => {
  const t = await setup();
  const r = await t.call("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 15, confirm: true });
  assert.match(r.error, /needs the approval_token/);
  const forged = await t.call("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 15, confirm: true, approval_token: "apr_forged" });
  assert.match(forged.error, /Unknown approval_token/);
  assert.equal(t.writes().length, 0);
  assert.equal(t.log().length, 0);
  await t.close();
});

test("preview then confirm applies exactly once, and writes a full audit trail", async () => {
  const t = await setup();
  const { preview, applied } = await t.twoStep("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 15 });
  assert.equal(preview.data.dry_run, true);
  assert.equal(preview.data.ad_account, ACC);
  assert.match(preview.data.change, /10 -> 15/);
  assert.equal(applied.data.applied, true);
  assert.equal(applied.data.verified, true);
  assert.equal(t.db.adsquads.s1.daily_budget_micro, 15e6);
  assert.equal(puts(t), 1);

  const log = t.log();
  const [intent, changeEntry, result] = log;
  assert.deepEqual([intent.kind, intent.phase, intent.tool, intent.account, intent.target_ids], ["audit", "intent", "snap_set_daily_budget", ACC, ["s1"]]);
  assert.equal(intent.params.daily_budget, 15);
  assert.deepEqual([changeEntry.before.daily_budget_micro, changeEntry.after.daily_budget_micro, changeEntry.verified], [10e6, 15e6, true]);
  assert.deepEqual([result.phase, result.status, result.event_id], ["result", "ok", intent.event_id]);
  assert.equal(applied.data.audit_event_id, intent.event_id);
  assert.ok(!JSON.stringify(log).includes(preview.data.approval_token), "tokens are not written to the log");

  // the same token cannot run it again (retry / repeated tool call)
  const again = await t.call("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 15, confirm: true, approval_token: preview.data.approval_token });
  assert.match(again.error, /already used/);
  assert.equal(puts(t), 1);
  await t.close();
});

test("an approval is bound to the exact arguments, tool and target state", async () => {
  const t = await setup();
  const args = { entity: "adsquad", id: "s1", daily_budget: 15 };
  // different amount
  let p = (await t.call("snap_set_daily_budget", args)).data;
  assert.match((await t.call("snap_set_daily_budget", { ...args, daily_budget: 20, confirm: true, approval_token: p.approval_token })).error, /changed since the preview/);
  // different target
  p = (await t.call("snap_set_daily_budget", args)).data;
  assert.match((await t.call("snap_set_daily_budget", { ...args, id: "s3", confirm: true, approval_token: p.approval_token })).error, /changed since the preview/);
  // different tool
  p = (await t.call("snap_set_daily_budget", args)).data;
  assert.match((await t.call("snap_set_bid", { adsquad_id: "s1", bid: 2.5, confirm: true, approval_token: p.approval_token })).error, /different tool/);
  // the item was edited elsewhere after the preview (stale)
  p = (await t.call("snap_set_daily_budget", args)).data;
  t.db.adsquads.s1 = { ...t.db.adsquads.s1, name: "Renamed in Ads Manager", updated_at: "t-elsewhere" };
  assert.match((await t.call("snap_set_daily_budget", { ...args, confirm: true, approval_token: p.approval_token })).error, /changed since the preview/);
  assert.equal(t.writes().length, 0);
  assert.equal(t.db.adsquads.s1.daily_budget_micro, 10e6);
  await t.close();
});

test("cumulative increases cannot be chained past the 24h limit, through any tool", async () => {
  const t = await setup();
  const first = await t.twoStep("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 20 });
  assert.equal(first.applied.data.applied, true);
  // 20 -> 40 is +100% per step, but the day started at 10
  assert.match((await t.call("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 40 })).error, /per 24h/);
  const scaled = await t.call("snap_bulk_set_budget", { adsquad_ids: ["s1"], mode: "scale", value: 2 });
  assert.match(JSON.stringify(scaled.data.skipped), /per 24h/);
  assert.equal(scaled.data.approval_token, undefined, "nothing to approve when every item is refused");
  const set = await t.call("snap_bulk_set_budget", { adsquad_ids: ["s1"], mode: "set", value: 40, confirm: true });
  assert.match(set.error, /approval_token/);
  assert.equal(t.db.adsquads.s1.daily_budget_micro, 20e6);
  assert.equal(puts(t), 1);
  // same for bids: 2 -> 3 (+50%) once, then no more today
  assert.equal((await t.twoStep("snap_set_bid", { adsquad_id: "s1", bid: 3 })).applied.data.applied, true);
  assert.match((await t.call("snap_set_bid", { adsquad_id: "s1", bid: 4 })).error, /per 24h/);
  await t.close();
});

test("absolute limits hold on update, create, copy and bulk", async () => {
  const t = await setup({ env: { SNAP_MAX_DAILY_BUDGET: "15", SNAP_MAX_BID: "3" } });
  assert.match((await t.call("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 20 })).error, /absolute limit of 15/);
  assert.match((await t.call("snap_set_bid", { adsquad_id: "s1", bid: 3.5 })).error, /absolute limit of 3/);
  assert.match((await t.call("snap_create_adsquad", { campaign_id: "c1", name: "New squad", daily_budget: 20, bid: 1 })).error, /absolute limit of 15/);
  assert.match((await t.call("snap_create_adsquad", { campaign_id: "c1", name: "New squad", daily_budget: 10, bid: 9 })).error, /absolute limit of 3/);
  assert.match((await t.call("snap_create_adsquad", { campaign_id: "c1", name: "New squad", daily_budget: 2, bid: 1 })).error, /at least 5/);
  assert.match((await t.call("snap_copy_adsquad", { adsquad_id: "s1", target_campaign_id: "c1", budget_scale: 2 })).error, /absolute limit of 15/);
  assert.match((await t.call("snap_copy_campaign", { campaign_id: "c1", new_name: "Copy of c1", budget_scale: 2 })).error, /absolute limit of 15/);
  const bulk = await t.call("snap_bulk_set_budget", { adsquad_ids: ["s1", "s2"], mode: "scale", value: 1.8 });
  assert.equal(bulk.data.will_change.length, 0);
  assert.equal(bulk.data.approval_token, undefined);
  assert.equal(t.writes().length, 0);
  // inside the limits the same tools still work
  const ok = await t.twoStep("snap_create_adsquad", { campaign_id: "c1", name: "New squad", daily_budget: 10, bid: 1 });
  assert.equal(ok.applied.data.status, "PAUSED");
  assert.equal(Object.values(t.db.adsquads).find((s) => s.name === "New squad").status, "PAUSED");
  await t.close();
});

test("enabling a campaign shows and limits the budgets of its ACTIVE ad squads", async () => {
  const t = await setup();
  const single = (await t.call("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE" })).data;
  assert.equal(single.activation.daily_budget_that_starts_delivering, 80, "30 + 50; the paused 70 squad is not counted");
  assert.deepEqual(single.activation.ad_squads_that_start_delivering.map((s) => s.adsquad_id).sort(), ["s3", "s4"]);
  const bulk = (await t.call("snap_set_status_bulk", { entity: "campaign", ids: ["c2"], status: "ACTIVE" })).data;
  assert.equal(bulk.preview.daily_budget_that_would_start_delivering, 80);
  // a squad under a paused campaign starts later, and says so
  const later = (await t.call("snap_set_status", { entity: "adsquad", id: "s5", status: "ACTIVE" })).data;
  assert.equal(later.activation.daily_budget_that_starts_delivering, 0);
  assert.equal(later.activation.starts_later[0].daily_budget, 70);
  // a squad under an ACTIVE campaign starts now
  assert.equal((await t.call("snap_set_status", { entity: "adsquad", id: "s2", status: "ACTIVE" })).data.activation.daily_budget_that_starts_delivering, 100);
  // an ad that would be the first ACTIVE ad of a live squad starts that squad's budget
  t.db.adsquads.s2.status = "ACTIVE";
  assert.equal((await t.call("snap_set_status", { entity: "ad", id: "a2", status: "ACTIVE" })).data.activation.daily_budget_that_starts_delivering, 100);
  // pausing needs no activation block
  assert.equal((await t.call("snap_set_status", { entity: "adsquad", id: "s1", status: "PAUSED" })).data.activation, undefined);
  await t.close();

  const capped = await setup({ env: { SNAP_MAX_ACTIVATION_DAILY_BUDGET: "60" } });
  assert.match((await capped.call("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE" })).error, /would start 80 of daily budget/);
  assert.match((await capped.call("snap_set_status_bulk", { entity: "campaign", ids: ["c2"], status: "ACTIVE" })).error, /SNAP_MAX_ACTIVATION_DAILY_BUDGET/);
  assert.equal(capped.writes().length, 0);
  await capped.close();

  const perSquad = await setup({ env: { SNAP_MAX_DAILY_BUDGET: "40" } });
  assert.match((await perSquad.call("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE" })).error, /"Squad s4" has a daily budget of 50/);
  await perSquad.close();
});

test("a child budget changed after the preview makes the activation approval stale", async () => {
  const t = await setup();
  const p = (await t.call("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE" })).data;
  t.db.adsquads.s3.daily_budget_micro = 900e6;
  const r = await t.call("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE", confirm: true, approval_token: p.approval_token });
  assert.match(r.error, /changed since the preview/);
  assert.equal(t.db.campaigns.c2.status, "PAUSED");
  await t.close();
});

test("undo goes through the same limits and approvals", async () => {
  const t = await setup();
  // lower 10 -> 5, then undo: allowed, the squad really had 10 today
  await t.twoStep("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 5 });
  const undo = await t.twoStep("snap_undo", {});
  assert.equal(undo.applied.data.applied, true);
  assert.equal(t.db.adsquads.s1.daily_budget_micro, 10e6);
  // undo without a token is refused like any other write
  assert.match((await t.call("snap_undo", { confirm: true })).error, /approval_token/);
  await t.close();

  // a decrease logged days ago cannot be used to jump the budget back up in one move
  const old = await setup({ world: sampleWorld() });
  const at = new Date(Date.now() - 3 * 86_400_000).toISOString();
  writeFileSync(old.logFile, JSON.stringify({ at, entity: "adsquad", id: "s1", name: "Squad s1", change: "daily budget 900 -> 10", verified: true, patch: { daily_budget_micro: 10e6 }, before: { daily_budget_micro: 900e6 }, after: { daily_budget_micro: 10e6 } }) + "\n");
  assert.match((await old.call("snap_undo", {})).error, /per step/);
  assert.match((await old.call("snap_undo", { force: true })).error, /per step/, "force does not lift the limits");
  assert.equal(old.writes().length, 0);
  await old.close();

  // undoing a pause is a re-activation: it shows what starts and respects the activation limit
  const re = await setup({ env: { SNAP_MAX_ACTIVATION_DAILY_BUDGET: "60" } });
  writeFileSync(re.logFile, JSON.stringify({ at: new Date().toISOString(), entity: "campaign", id: "c2", name: "Campaign c2", change: "status ACTIVE -> PAUSED", verified: true, patch: { status: "PAUSED" }, before: { status: "ACTIVE" }, after: { status: "PAUSED" } }) + "\n");
  assert.match((await re.call("snap_undo", {})).error, /SNAP_MAX_ACTIVATION_DAILY_BUDGET/);
  await re.close();
  const reOk = await setup();
  writeFileSync(reOk.logFile, JSON.stringify({ at: new Date().toISOString(), entity: "campaign", id: "c2", name: "Campaign c2", change: "status ACTIVE -> PAUSED", verified: true, patch: { status: "PAUSED" }, before: { status: "ACTIVE" }, after: { status: "PAUSED" } }) + "\n");
  const prev = (await reOk.call("snap_undo", {})).data;
  assert.equal(prev.activation.daily_budget_that_starts_delivering, 80);
  assert.equal(prev.reverting.change, "status ACTIVE -> PAUSED");
  // a newer change logged between preview and confirm must not shift which entry gets undone
  appendFileSync(reOk.logFile, JSON.stringify({ at: new Date().toISOString(), entity: "adsquad", id: "s1", name: "Squad s1", change: "rename", verified: true, patch: { name: "Squad s1" }, before: { name: "Old" }, after: { name: "Squad s1" } }) + "\n");
  assert.match((await reOk.call("snap_undo", { confirm: true, approval_token: prev.approval_token })).error, /changed since the preview/);
  assert.equal(reOk.writes().length, 0);
  await reOk.close();
});

test("writes are refused for items of another ad account, and for ids that are not ids", async () => {
  const t = await setup();
  for (const [name, args] of [
    ["snap_set_status", { entity: "adsquad", id: "sx", status: "PAUSED" }],
    ["snap_set_status", { entity: "campaign", id: "cx", status: "PAUSED" }],
    ["snap_set_daily_budget", { entity: "adsquad", id: "sx", daily_budget: 12 }],
    ["snap_set_status_bulk", { entity: "adsquad", ids: ["s1", "sx"], status: "PAUSED" }],
    ["snap_bulk_set_budget", { adsquad_ids: ["sx"], mode: "set", value: 12 }],
    ["snap_delete", { entity: "adsquad", id: "sx" }],
    ["snap_create_adsquad", { campaign_id: "cx", name: "Intruder", daily_budget: 10, bid: 1 }],
    ["snap_copy_adsquad", { adsquad_id: "s1", target_campaign_id: "cx" }],
    ["snap_create_ad", { creative_id: "cr1", adsquad_id: "sx", name: "Intruder ad" }],
  ]) {
    const r = await t.call(name, args);
    assert.match(r.error ?? "", /another ad account/, `${name} ${JSON.stringify(args)} -> ${JSON.stringify(r.data ?? r.error).slice(0, 200)}`);
  }
  // an item whose account cannot be established is refused too
  t.db.campaigns.c1 = { ...t.db.campaigns.c1, ad_account_id: undefined };
  assert.match((await t.call("snap_rename", { entity: "campaign", id: "c1", new_name: "New name" })).error, /Cannot verify which ad account/);
  const before = t.calls.length;
  for (const bad of ["s1/../../adaccounts/x", "s1?x=1", "../c1", "s 1", "a".repeat(65)]) {
    const r = await t.raw("snap_set_status", { entity: "adsquad", id: bad, status: "PAUSED" });
    assert.equal(r.isError, true, bad);
    const g = await t.raw("snap_get_entity", { entity: "adsquad", id: bad });
    assert.equal(g.isError, true, bad);
  }
  assert.equal(t.calls.length, before, "malformed ids never reach the API");
  // unknown arguments are rejected instead of silently dropped
  const extra = await t.raw("snap_create_campaign", { name: "Somewhere else", ad_account_id: "acc-OTHER" });
  assert.equal(extra.isError, true);
  assert.equal(t.writes().length, 0);
  await t.close();
});

test("read-only mode: previews and reads work, nothing can be applied", async () => {
  const t = await setup({ env: { SNAP_READ_ONLY: "1" } });
  const p = (await t.call("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 15 })).data;
  assert.match(p.read_only, /cannot be applied/);
  assert.match((await t.call("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 15, confirm: true, approval_token: p.approval_token })).error, /read-only mode/);
  assert.match((await t.call("snap_create_campaign", { name: "Blocked", confirm: true })).error, /read-only mode/);
  assert.equal((await t.call("snap_list_campaigns", {})).data.length, 2);
  assert.equal(t.writes().length, 0);
  await t.close();
});

test("human approval through the client (SNAP_HUMAN_APPROVAL=elicit) fails closed", async () => {
  const args = { entity: "adsquad", id: "s1", daily_budget: 15 };
  const none = await setup({ env: { SNAP_HUMAN_APPROVAL: "elicit" } });
  assert.match((await none.twoStep("snap_set_daily_budget", args)).applied.error, /could not ask for one/);
  assert.equal(none.writes().length, 0);
  await none.close();

  const no = await setup({ env: { SNAP_HUMAN_APPROVAL: "elicit" }, elicit: async () => ({ action: "decline" }) });
  assert.match((await no.twoStep("snap_set_daily_budget", args)).applied.error, /did not approve/);
  assert.equal(no.writes().length, 0);
  await no.close();

  const unticked = await setup({ env: { SNAP_HUMAN_APPROVAL: "elicit" }, elicit: async () => ({ action: "accept", content: { approve: false } }) });
  assert.match((await unticked.twoStep("snap_set_daily_budget", args)).applied.error, /did not approve/);
  await unticked.close();

  // a budget increase is money-sensitive: the person must also type the code the server shows them
  const typed = (params) => ({ action: "accept", content: { approve: true, confirmation_code: params.message.match(/type this code: (\d{4})/)?.[1] } });
  const yes = await setup({ env: { SNAP_HUMAN_APPROVAL: "elicit" }, elicit: async (params) => typed(params) });
  const r = await yes.twoStep("snap_set_daily_budget", args);
  assert.equal(r.applied.data.applied, true);
  assert.equal(yes.asked.length, 1);
  assert.match(yes.asked[0], /snap_set_daily_budget on ad account acc-1[\s\S]*THIS ADDS 5 PER DAY[\s\S]*10 -> 15/);
  assert.equal((await yes.call("snap_list_campaigns", {})).data.length, 2, "reads never ask");
  assert.equal(yes.asked.length, 1);
  await yes.close();
});

test("a declared account currency must match the account before any write", async () => {
  const wrong = await setup({ world: sampleWorld({ currency: "SAR" }), env: { SNAP_ACCOUNT_CURRENCY: "USD" } });
  assert.match((await wrong.call("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 15 })).error, /currency is SAR but SNAP_ACCOUNT_CURRENCY is USD/);
  assert.equal((await wrong.call("snap_list_adsquads", { campaign_id: "c1" })).data.length, 2, "reads are not affected");
  await wrong.close();
  const right = await setup({ env: { SNAP_ACCOUNT_CURRENCY: "USD" } });
  assert.equal((await right.twoStep("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 15 })).applied.data.applied, true);
  await right.close();
});

test("identical create-type requests are not executed twice", async () => {
  const t = await setup();
  const first = await t.twoStep("snap_create_campaign", { name: "Launch NOV" });
  assert.equal(first.applied.data.status, "PAUSED");
  const second = await t.twoStep("snap_create_campaign", { name: "Launch NOV" });
  assert.match(second.preview.data.duplicate_warning, /identical request was executed/);
  assert.match(second.applied.error, /already executed/);
  assert.equal(t.writes().filter((c) => c.method === "POST").length, 1);
  // a deliberately different one is fine
  assert.equal((await t.twoStep("snap_create_campaign", { name: "Launch NOV 2" })).applied.data.status, "PAUSED");

  // a single-use ad code is claimed once, and never appears in the log in full
  const claim = await t.twoStep("snap_claim_ad_code", { ad_code: AD_CODE });
  assert.match(claim.applied.data.media_id, /^media-/);
  assert.match((await t.twoStep("snap_claim_ad_code", { ad_code: AD_CODE })).applied.error, /already executed/);
  assert.equal(t.writes().filter((c) => c.path.endsWith("claim_media_by_ad_code")).length, 1);
  const logText = JSON.stringify(t.log());
  assert.ok(!logText.includes(AD_CODE));
  assert.ok(logText.includes("adcode_…9abc"));
  await t.close();
});

// One valid call per mutating tool. Used to prove that none of them can change anything without an approval.
const WRITE_CALLS = (csv, img) => ({
  snap_set_status: { entity: "adsquad", id: "s1", status: "PAUSED" },
  snap_set_status_bulk: { entity: "adsquad", ids: ["s1"], status: "PAUSED" },
  snap_set_daily_budget: { entity: "adsquad", id: "s1", daily_budget: 12 },
  snap_set_bid: { adsquad_id: "s1", bid: 2.5 },
  snap_set_targeting: { adsquad_id: "s1", countries: ["ae"] },
  snap_set_schedule: { entity: "adsquad", id: "s1", end_time: "2099-01-01T00:00:00+03:00" },
  snap_exclude_segments: { adsquad_id: "s1", segment_ids: ["111"] },
  snap_rename: { entity: "adsquad", id: "s1", new_name: "Squad renamed" },
  snap_bulk_exclude_segments: { adsquad_ids: ["s1"], segment_ids: ["111"] },
  snap_bulk_set_budget: { adsquad_ids: ["s1"], mode: "set", value: 12 },
  snap_bulk_set_schedule: { entity: "adsquad", ids: ["s1"], end_time: "2099-01-01T00:00:00+03:00" },
  snap_bulk_rename: { entity: "adsquad", ids: ["s1"], find: "Squad", replace: "Group" },
  snap_copy_campaign: { campaign_id: "c1", new_name: "Copy of c1" },
  snap_copy_adsquad: { adsquad_id: "s1", target_campaign_id: "c1", new_name: "Copy of s1" },
  snap_clone_ad: { ad_id: "a1", target_adsquad_ids: ["s3"] },
  snap_clone_creative: { creative_id: "cr1", name: "Creative copy" },
  snap_create_campaign: { name: "Brand new" },
  snap_create_adsquad: { campaign_id: "c1", name: "Brand new squad", daily_budget: 10, bid: 1 },
  snap_create_ad: { creative_id: "cr1", adsquad_id: "s1", name: "Brand new ad" },
  snap_create_creative: { media_id: "m1", name: "Brand new creative", headline: "Hello", url: "https://example.com/" },
  snap_create_lookalike: { seed_segment_id: "111", name: "Lookalike buyers" },
  snap_create_pixel_audience: { name: "Cart 30d", events: ["ADD_CART"] },
  snap_claim_ad_code: { ad_code: AD_CODE },
  snap_influencer_ad: { ad_code: AD_CODE, adsquad_id: "s2", name: "Paid - x", headline: "Hello", url: "https://example.com/" },
  snap_influencer_batch: { adsquad_id: "s2", items: [{ ad_code: AD_CODE, name: "Paid - x" }], headline: "Hello", url: "https://example.com/" },
  snap_upload_media: { file_path: img },
  snap_upload_customer_list: { file_path: csv, kind: "email", name: "Customers" },
  snap_delete: { entity: "adsquad", id: "s2", confirm_name: "Squad s2" },
  snap_undo: {},
});

test("every mutating tool previews with an approval token, refuses confirm=true without it, and is audited when applied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "files-"));
  const csv = join(dir, "c.csv");
  const img = join(dir, "p.png");
  writeFileSync(csv, "email\nA@Example.com\nb@example.com\n");
  writeFileSync(img, Buffer.alloc(64));
  const calls = WRITE_CALLS(csv, img);

  const listing = await setup();
  const { tools } = await listing.client.listTools();
  const writeTools = tools.filter((x) => x.annotations?.readOnlyHint === false && x.inputSchema.properties.confirm).map((x) => x.name).sort();
  assert.deepEqual(writeTools, Object.keys(calls).sort(), "the table above covers every mutating tool");
  assert.equal(tools.length, 55);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects unknown arguments`);
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} is annotated`);
    if (tool.inputSchema.properties.confirm) assert.ok(tool.inputSchema.properties.approval_token, `${tool.name} takes an approval_token`);
  }
  assert.equal(tools.find((x) => x.name === "snap_delete").annotations.destructiveHint, true);
  assert.equal(tools.find((x) => x.name === "snap_create_campaign").annotations.destructiveHint, false);
  assert.deepEqual(tools.filter((x) => x.annotations.readOnlyHint === false && !x.inputSchema.properties.confirm).map((x) => x.name), ["snap_report_async_download"]);
  await listing.close();

  for (const [name, args] of Object.entries(calls)) {
    // 1) confirm=true without a token: nothing is sent, nothing is logged
    const t = await setup();
    if (name === "snap_undo") writeFileSync(t.logFile, JSON.stringify({ at: new Date().toISOString(), entity: "adsquad", id: "s1", name: "Squad s1", change: "rename", verified: true, patch: { name: "Squad s1" }, before: { name: "Old name" }, after: { name: "Squad s1" } }) + "\n");
    const logBefore = t.log().length;
    const denied = await t.call(name, { ...args, confirm: true });
    assert.match(denied.error ?? "", /approval_token/, `${name}: ${JSON.stringify(denied.data ?? denied.error).slice(0, 200)}`);
    assert.equal(t.writes().length, 0, `${name} sent a write without approval`);
    assert.equal(t.log().length, logBefore);

    // 2) preview -> confirm: applied, with an intent and a result record naming the tool and the account
    const { preview, applied } = await t.twoStep(name, args);
    assert.ok(preview.data?.approval_token, `${name} preview: ${JSON.stringify(preview).slice(0, 300)}`);
    assert.ok(applied.data, `${name} apply: ${applied.error}`);
    assert.ok(t.writes().length >= 1, `${name} wrote nothing`);
    const events = t.log().filter((e) => e.kind === "audit" && e.tool === name);
    assert.deepEqual(events.map((e) => e.phase), ["intent", "result"], name);
    assert.deepEqual([events[0].account, events[1].status, events[1].event_id], [ACC, "ok", events[0].event_id], name);
    assert.equal(applied.data.audit_event_id, events[0].event_id, name);
    assert.ok(!JSON.stringify(t.log()).includes(AD_CODE), `${name} logged a full ad code`);
    await t.close();
  }
});

test("an unwritable audit log stops the operation before anything is sent", async () => {
  const t = await setup({ env: { SNAP_LOG_FILE: join(tmpdir(), "no-such-dir-snap-audit", "x", "log.jsonl") } });
  const r = await t.twoStep("snap_set_status", { entity: "adsquad", id: "s1", status: "PAUSED" });
  assert.match(r.applied.error, /Audit log is not writable.*Nothing was sent/);
  assert.equal(t.writes().length, 0);
  assert.equal(t.db.adsquads.s1.status, "ACTIVE");
  await t.close();
});

test("a failed execution is recorded as failed, and an unverifiable one is reported as applied with a warning", async () => {
  const t = await setup();
  const p = (await t.call("snap_set_status", { entity: "adsquad", id: "s1", status: "PAUSED" })).data;
  t.hooks.failNextWrite = new TypeError("fetch failed");
  const failed = await t.call("snap_set_status", { entity: "adsquad", id: "s1", status: "PAUSED", confirm: true, approval_token: p.approval_token });
  assert.match(failed.error, /OUTCOME UNKNOWN/);
  assert.equal(t.writes().length, 1, "a write that failed in transit is not re-sent");
  assert.deepEqual(t.log().filter((e) => e.kind === "audit").map((e) => [e.phase, e.status]), [["intent", undefined], ["result", "failed"]]);
  assert.match((await t.call("snap_set_status", { entity: "adsquad", id: "s1", status: "PAUSED", confirm: true, approval_token: p.approval_token })).error, /already used/);
  await t.close();

  const u = await setup();
  const q = (await u.call("snap_set_status", { entity: "adsquad", id: "s1", status: "PAUSED" })).data;
  u.hooks.failGetAfterPut = true;
  const r = await u.call("snap_set_status", { entity: "adsquad", id: "s1", status: "PAUSED", confirm: true, approval_token: q.approval_token });
  assert.equal(r.data.applied, true);
  assert.equal(r.data.verified, false);
  assert.match(r.data.warnings[0], /Treat it as APPLIED/);
  const change = u.log().find((e) => e.patch);
  assert.deepEqual([change.verified, change.before.status, typeof change.verify_error], [false, "ACTIVE", "string"]);
  assert.equal(u.db.adsquads.s1.status, "PAUSED");
  await u.close();
});

test("read-only tools still work and are unaffected by the write gate", async () => {
  const t = await setup();
  const ping = (await t.call("snap_ping", {})).data;
  assert.deepEqual([ping.ok, ping.me.display_name, ping.ad_account, ping.safety_limits.maxDailyBudget, ping.safety_limits.maxAddedDailyBudget24h], [true, "Tester", "acc-1", 1000, 10000]);
  assert.deepEqual((await t.call("snap_list_campaigns", {})).data.map((c) => c.id), ["c1", "c2"]);
  assert.deepEqual((await t.call("snap_list_campaigns", { status: "PAUSED" })).data.map((c) => c.id), ["c2"]);
  assert.deepEqual((await t.call("snap_list_adsquads", { campaign_id: "c2" })).data.map((s) => [s.id, s.daily_budget]), [["s3", 30], ["s4", 50], ["s5", 70]]);
  assert.deepEqual((await t.call("snap_list_ads", { adsquad_id: "s1" })).data.map((a) => a.id), ["a1"]);
  assert.equal((await t.call("snap_get_entity", { entity: "adsquad", id: "s1" })).data.name, "Squad s1");
  assert.equal((await t.call("snap_get_media", { media_id: "m1" })).data.media_status, "READY");
  assert.equal((await t.call("snap_api_get", { path: "/adsquads/s1" })).data.adsquads[0].adsquad.id, "s1");
  assert.match((await t.call("snap_api_get", { path: "/../etc" })).error, /path/);
  assert.deepEqual((await t.call("snap_change_log", {})).data, []);
  assert.equal(t.writes().length, 0);
  await t.close();
});

test("the server refuses to start with an unsafe configuration, and starts with a safe one", () => {
  const run = (extra) => spawnSync(process.execPath, ["src/index.js"], { cwd: ROOT, input: "", encoding: "utf8", timeout: 20000, env: { PATH: process.env.PATH, SNAP_ENV_FILE: "/nonexistent/snap-test.env", ...extra } });
  const bad = run({ SNAP_MAX_BUDGET_INCREASE_PCT: "100%" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unsafe configuration[\s\S]*SNAP_MAX_BUDGET_INCREASE_PCT/);
  assert.equal(bad.stdout, "", "nothing is written to the protocol stream");
  const bad2 = run({ SNAP_MAX_DAILY_BUDGET: "unlimited" });
  assert.equal(bad2.status, 1);
  const ok = run({ SNAP_MAX_DAILY_BUDGET: "200" });
  assert.equal(ok.status, 0, ok.stderr);
});

test("a stale approval says which field of the target changed (by name), and a changed argument says so", async () => {
  const t = await setup();
  const args = { entity: "adsquad", id: "s1", daily_budget: 15 };
  let p = (await t.call("snap_set_daily_budget", args)).data;
  t.db.adsquads.s1 = { ...t.db.adsquads.s1, name: "Edited elsewhere", updated_at: "t-elsewhere", brand_new_field: "x" };
  const stale = await t.call("snap_set_daily_budget", { ...args, confirm: true, approval_token: p.approval_token });
  assert.match(stale.error, /Reason: the target changed in 3 place\(s\): current\.(name|updated_at|brand_new_field)/);
  assert.ok(!/Edited elsewhere|t-elsewhere/.test(stale.error), "values are not echoed");
  p = (await t.call("snap_set_daily_budget", args)).data;
  const other = await t.call("snap_set_daily_budget", { ...args, daily_budget: 20, confirm: true, approval_token: p.approval_token });
  assert.match(other.error, /Reason: the arguments of this call are not the same/);
  assert.equal(t.writes().length, 0);
  await t.close();
});

test("regression: fields Snap computes itself, and the order of its lists, do not make an approval stale", async () => {
  // delivery_status came back in another order on the second read of an untouched campaign (seen on a real account)
  const t = await setup();
  t.db.campaigns.c1.delivery_status = ["NOT_EFFECTIVE_ACTIVE", "CAMPAIGN_HAS_NO_ACTIVE_AD_SQUAD", "NOT_ACTIVE"];
  const args = { entity: "campaign", id: "c1", new_name: "Campaign one renamed" };
  const p = (await t.call("snap_rename", args)).data;
  t.db.campaigns.c1.delivery_status = ["NOT_EFFECTIVE_ACTIVE", "NOT_ACTIVE", "CAMPAIGN_HAS_NO_ACTIVE_AD_SQUAD"];
  t.db.campaigns.c1.review_status = "PENDING";
  const done = await t.call("snap_rename", { ...args, confirm: true, approval_token: p.approval_token });
  assert.equal(done.data?.applied, true, done.error);
  assert.equal(t.db.campaigns.c1.name, "Campaign one renamed");
  assert.equal(puts(t), 1);
  // the PUT never sends the computed fields back
  const sent = t.writes().find((c) => c.method === "PUT").body.campaigns[0];
  assert.ok(!("delivery_status" in sent) && !("review_status" in sent));

  // a real edit by someone else is still caught
  const q = (await t.call("snap_rename", { entity: "campaign", id: "c2", new_name: "Campaign two renamed" })).data;
  t.db.campaigns.c2 = { ...t.db.campaigns.c2, name: "Changed in Ads Manager", updated_at: "t-elsewhere" };
  const stale = await t.call("snap_rename", { entity: "campaign", id: "c2", new_name: "Campaign two renamed", confirm: true, approval_token: q.approval_token });
  assert.match(stale.error, /changed in 2 place\(s\): current\.(name|updated_at), current\.(name|updated_at)/);
  await t.close();
});

test("the order in which Snap lists children does not make an enabling approval stale; a changed budget still does", async () => {
  const t = await setup();
  const args = { entity: "campaign", id: "c2", status: "ACTIVE" };
  const p = (await t.call("snap_set_status", args)).data;
  assert.equal(p.activation.daily_budget_that_starts_delivering, 80);
  t.hooks.reverseLists = true; // same children, other order
  const done = await t.call("snap_set_status", { ...args, confirm: true, approval_token: p.approval_token });
  assert.equal(done.data?.applied, true, done.error);
  assert.equal(t.db.campaigns.c2.status, "ACTIVE");
  t.hooks.reverseLists = false;

  const u = await setup();
  const q = (await u.call("snap_set_status", args)).data;
  u.hooks.reverseLists = true;
  u.db.adsquads.s3.daily_budget_micro = 400e6; // a child budget really changed
  const stale = await u.call("snap_set_status", { ...args, confirm: true, approval_token: q.approval_token });
  assert.match(stale.error, /changed since the preview/);
  assert.equal(u.db.campaigns.c2.status, "PAUSED");
  await t.close();
  await u.close();
});
