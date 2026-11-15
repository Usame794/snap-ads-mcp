// Bid strategy switching, placement control and the portfolio summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planBidStrategy } from "../src/changes.js";
import { planPlacement } from "../src/controls.js";
import { parsePortfolioFiles, portfolioSummary } from "../src/portfolio.js";
import { setup } from "./helpers/harness.js";

const env = { SNAP_MAX_BID: "10", SNAP_MAX_BID_INCREASE_PCT: "50", SNAP_MAX_DAILY_BUDGET: "100" };

test("bid strategy: max bid <-> target cost with limits; auto-bid is never the target; auto-bid can be given a cap", () => {
  const maxBid = { id: "s", bid_strategy: "LOWEST_COST_WITH_MAX_BID", bid_micro: 2e6, auto_bid: false, target_bid: false };
  const p = planBidStrategy(maxBid, { strategy: "TARGET_COST", bid: 2.5 }, env);
  assert.deepEqual(p.patch, { bid_strategy: "TARGET_COST", bid_micro: 2.5e6, auto_bid: false, target_bid: true });
  assert.match(p.summary, /LOWEST_COST_WITH_MAX_BID \(2\) -> TARGET_COST \(2\.5\)/);
  assert.match(p.note, /daily budget limit still applies/);
  assert.throws(() => planBidStrategy(maxBid, { strategy: "AUTO_BID", bid: 2 }, env), /removes the bid cap/);
  assert.throws(() => planBidStrategy(maxBid, { strategy: "TARGET_COST", bid: 4 }, env), /Refusing a 100% increase/, "the +50% per step rule applies");
  assert.throws(() => planBidStrategy({ ...maxBid, bid_micro: 8e6 }, { strategy: "TARGET_COST", bid: 11 }, env), /absolute limit of 10/);
  assert.throws(() => planBidStrategy(maxBid, { strategy: "LOWEST_COST_WITH_MAX_BID", bid: 2 }, env), /already those values/);
  assert.throws(() => planBidStrategy(maxBid, { strategy: "TARGET_COST" }, env), /bid is required/);
  // from auto-bid there is no earlier bid: only the absolute limit applies, and a cap is added
  const auto = { id: "s", bid_strategy: "AUTO_BID", auto_bid: true };
  const added = planBidStrategy(auto, { strategy: "LOWEST_COST_WITH_MAX_BID", bid: 3 }, env);
  assert.deepEqual([added.patch.bid_micro, added.patch.auto_bid], [3e6, false]);
  assert.throws(() => planBidStrategy(auto, { strategy: "LOWEST_COST_WITH_MAX_BID", bid: 30 }, env), /absolute limit of 10/);
  assert.equal("target_bid" in planBidStrategy({ id: "s", bid_strategy: "AUTO_BID" }, { strategy: "TARGET_COST", bid: 3 }, env).patch, false, "older fields are only set when the ad squad has them");
});

test("placement: automatic or custom positions, Snap's CHAT_FEED rule, lists kept safe", () => {
  const p = planPlacement({ placement_v2: { config: "AUTOMATIC" } }, { mode: "custom", positions: ["FEED", "CAMERA", "FEED"] });
  assert.deepEqual(p.patch.placement_v2, { config: "CUSTOM", platforms: ["SNAPCHAT"], snapchat_positions: ["CAMERA", "FEED"] });
  assert.match(p.summary, /automatic \(everywhere\) -> custom: CAMERA, FEED/);
  assert.deepEqual(planPlacement({ placement_v2: p.patch.placement_v2 }, { mode: "automatic" }).patch.placement_v2, { config: "AUTOMATIC" });
  assert.throws(() => planPlacement({ placement_v2: { config: "AUTOMATIC" } }, { mode: "automatic" }), /already that value/);
  assert.throws(() => planPlacement({}, { mode: "custom", positions: ["CHAT_FEED"] }), /CHAT_FEED must be combined/);
  planPlacement({}, { mode: "custom", positions: ["CHAT_FEED", "INTERSTITIAL_USER"] });
  assert.throws(() => planPlacement({}, { mode: "custom", positions: ["INSTREAM"] }), /Unknown or unsupported position INSTREAM/);
  assert.throws(() => planPlacement({}, { mode: "custom" }), /positions is required/);
  assert.throws(() => planPlacement({}, { mode: "automatic", positions: ["FEED"] }), /Do not give positions/);
  assert.throws(() => planPlacement({}, { mode: "everywhere" }), /automatic or custom/);
  assert.throws(() => planPlacement({ placement_v2: { config: "CUSTOM", snapchat_positions: ["INSTREAM"], inclusion: { premium_content_bundle_ids: ["b"] } } }, { mode: "automatic" }), /inclusion or exclusion/);
});

test("through the tools: switch strategy, set a placement, and undo each; a strategy switch cannot be undone into auto-bid", async () => {
  const t = await setup();
  t.db.adsquads.s1 = { ...t.db.adsquads.s1, bid_strategy: "LOWEST_COST_WITH_MAX_BID", bid_micro: 2e6, placement_v2: { config: "AUTOMATIC" } };
  const sw = await t.twoStep("snap_set_bid_strategy", { adsquad_id: "s1", strategy: "TARGET_COST", bid: 2.5 });
  assert.equal(sw.applied.data.verified, true);
  assert.deepEqual([t.db.adsquads.s1.bid_strategy, t.db.adsquads.s1.bid_micro], ["TARGET_COST", 2.5e6]);
  const pl = await t.twoStep("snap_set_placement", { adsquad_id: "s1", mode: "custom", positions: ["FEED", "CAMERA"] });
  assert.deepEqual(t.db.adsquads.s1.placement_v2.snapchat_positions, ["CAMERA", "FEED"]);
  assert.ok(pl.applied.data.verified);
  const undoPlacement = await t.twoStep("snap_undo", {});
  assert.ok(undoPlacement.applied.data, undoPlacement.applied.error);
  assert.deepEqual(t.db.adsquads.s1.placement_v2, { config: "AUTOMATIC" });
  const undoStrategy = await t.twoStep("snap_undo", {});
  assert.ok(undoStrategy.applied.data, undoStrategy.applied.error);
  assert.deepEqual([t.db.adsquads.s1.bid_strategy, t.db.adsquads.s1.bid_micro], ["LOWEST_COST_WITH_MAX_BID", 2e6]);
  assert.match((await t.call("snap_set_bid_strategy", { adsquad_id: "s1", strategy: "AUTO_BID", bid: 2 })).error, /(Invalid option|removes the bid cap|expected one of)/i, "auto-bid is not even an allowed value");
  await t.close();
});

test("portfolio: the owner lists absolute files; each account is read with its own credentials; currencies are never mixed; secrets never appear", async () => {
  assert.deepEqual(parsePortfolioFiles(""), []);
  assert.deepEqual(parsePortfolioFiles(" /a/.env , /b/.env,/a/.env"), ["/a/.env", "/b/.env"]);
  assert.throws(() => parsePortfolioFiles("relative/.env"), /absolute paths/);
  assert.throws(() => parsePortfolioFiles(Array.from({ length: 11 }, (_, i) => `/f${i}`).join(",")), /more than 10/);
  const settings = {
    "/a/.env": { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "SECRET-A", SNAP_REFRESH_TOKEN: "TOKEN-A", SNAP_AD_ACCOUNT_ID: "acc-a", SNAP_REPORT_UTC_OFFSET: "+03:00" },
    "/b/.env": { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "SECRET-B", SNAP_REFRESH_TOKEN: "TOKEN-B", SNAP_AD_ACCOUNT_ID: "acc-b", SNAP_READ_ONLY: "1" },
    "/c/.env": { SNAP_CLIENT_ID: "i", SNAP_AD_ACCOUNT_ID: "acc-c" },
  };
  const names = { "acc-a": { name: "Shop A", status: "ACTIVE", currency: "USD" }, "acc-b": { name: "Shop B", status: "ACTIVE", currency: "SAR" } };
  const asked = [];
  const day = (date, spend, purchases, value) => ({ date, spend, purchases, purchase_value: value, roas: spend ? Math.round((value / spend) * 100) / 100 : null });
  const rows = (spend, purchases, value) => Array.from({ length: 9 }, (_, i) => day(`2026-11-0${i + 1}`, spend, purchases, value));
  const makeClient = (e) => ({ request: async (m, p) => ((asked.push([e.SNAP_REFRESH_TOKEN, m, p]), { adaccounts: [{ adaccount: names[e.SNAP_AD_ACCOUNT_ID] }] })) });
  const report = async (c, a) => ({ rows: a.id === "acc-a" ? [...rows(100, 5, 400).slice(0, 8), day("2026-11-09", 100, 0, 0)] : rows(50, 2, 90) });
  const r = await portfolioSummary({ files: Object.keys(settings), defaultOffset: "+00:00", now: new Date("2026-11-10T09:00:00Z"), makeClient, report, exists: () => true, readFile: (f) => settings[f] });
  assert.deepEqual(r.accounts.map((a) => a.account ?? a.settings_file), ["Shop A", "Shop B", ".env"]);
  assert.match(r.accounts[2].error, /missing SNAP_CLIENT_SECRET, SNAP_REFRESH_TOKEN/, "one bad file does not stop the others");
  assert.deepEqual(r.accounts[0].last_7_days, { spend: 700, purchases: 30, purchase_value: 2400, roas: 3.43, cpa: 23.33 });
  assert.equal(r.accounts[0].yesterday.purchases, 0);
  assert.equal(r.accounts[0].attention.verdict, "ATTENTION");
  assert.equal(r.accounts[1].attention, null);
  assert.equal(r.accounts[1].read_only_server_setting, true);
  assert.deepEqual(Object.keys(r.last_7_days_totals_by_currency).sort(), ["SAR", "USD"], "USD and SAR are not added together");
  assert.deepEqual(r.needs_attention, ["Shop A", ".env"]);
  for (const secret of ["SECRET-A", "TOKEN-A", "SECRET-B", "TOKEN-B"]) assert.ok(!JSON.stringify(r).includes(secret), `${secret} must not appear in the answer`);
  assert.deepEqual(asked.map((a) => a[0]), ["TOKEN-A", "TOKEN-B"], "each account was read with its own credentials");
  assert.ok(asked.every((a) => a[1] === "GET"));
});

test("portfolio tool: says how to configure it when no files are set, and reads only the owner's files", async () => {
  const t = await setup();
  const none = await t.call("snap_portfolio_summary", {});
  assert.equal(none.data.configured, false);
  assert.match(none.data.how_to, /SNAP_PORTFOLIO_FILES/);
  const bad = await setup({ env: { SNAP_PORTFOLIO_FILES: "relative.env" } });
  assert.match((await bad.call("snap_portfolio_summary", {})).error, /absolute paths/);
  const props = (await t.client.listTools()).tools.find((x) => x.name === "snap_portfolio_summary").inputSchema.properties;
  assert.deepEqual(Object.keys(props), [], "the tool takes no arguments, so the AI cannot choose a file");
  await t.close();
  await bad.close();
});
