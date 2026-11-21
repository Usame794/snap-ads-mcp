// Regression tests for the findings of the independent security audit of 0.9.6. Each test was first written as a proof of concept
// that passed while the bug existed (see the audit report); here each one asserts the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrokerLogin } from "../src/broker.js";
import { seal } from "../src/hybrid.js";
import { setEnvValue, readEnvFile } from "../src/env.js";

async function forge(value) {
  const login = await startBrokerLogin({ brokerUrl: "https://broker.example", timeoutMs: 2000 });
  const u = new URL(login.url);
  const pk = u.searchParams.get("pk"), nonce = u.searchParams.get("nonce"), port = u.searchParams.get("port");
  const sealed = await seal(pk, value, nonce);
  const cb = new URL(`http://127.0.0.1:${port}/callback`);
  cb.search = new URLSearchParams({ nonce, epk: sealed.epk, salt: sealed.salt, iv: sealed.iv, ct: sealed.ct }).toString();
  const status = (await fetch(cb)).status;
  return { login, status };
}

test("F2: a forged login value with line breaks is refused by the listener, and the login is still waiting", async () => {
  const { login, status } = await forge("x-attacker-token\nSNAP_HUMAN_APPROVAL=off\nSNAP_MAX_ADDED_DAILY_BUDGET_24H=1000000000");
  assert.equal(status, 400);
  login.close();
  await login.done.catch(() => {});
});

test("F2: a value that is not shaped like a token is refused, a real-looking token is accepted", async () => {
  const bad = await forge("has spaces in it 1234567890");
  assert.equal(bad.status, 400);
  bad.login.close();
  await bad.login.done.catch(() => {});
  const good = await forge("eyJhbGciOiJIUzI1NiJ9.abc_DEF-123.sig/part+more=");
  assert.equal(good.status, 200);
  assert.equal(await good.login.done, "eyJhbGciOiJIUzI1NiJ9.abc_DEF-123.sig/part+more=");
});

test("F2: setEnvValue refuses line breaks and control characters in a value, and bad setting names", () => {
  const file = join(mkdtempSync(join(tmpdir(), "env-")), ".env");
  assert.throws(() => setEnvValue("SNAP_REFRESH_TOKEN", "a\nSNAP_HUMAN_APPROVAL=off", file), /line break/);
  assert.throws(() => setEnvValue("SNAP_REFRESH_TOKEN", "a\rb", file), /line break|control/);
  assert.throws(() => setEnvValue("SNAP_REFRESH_TOKEN", "a\u0000b", file), /control/);
  assert.throws(() => setEnvValue("bad key", "x", file), /Not a setting name/);
  assert.throws(() => setEnvValue("SNAP_X\nSNAP_Y", "x", file), /Not a setting name/);
  setEnvValue("SNAP_REFRESH_TOKEN", "fine.token-value_1", file);
  assert.deepEqual(Object.keys(readEnvFile(file)), ["SNAP_REFRESH_TOKEN"]);
});

import { setup, sampleWorld, ACC } from "./helpers/harness.js";

function cboWorld(budget = 50_000, squadBudget = undefined) {
  const w = sampleWorld();
  w.campaigns.cbo = { id: "cbo", name: "CBO", status: "PAUSED", ad_account_id: ACC, daily_budget_micro: budget * 1e6, updated_at: "t0" };
  w.adsquads.q1 = { id: "q1", name: "Q1", status: "ACTIVE", campaign_id: "cbo", targeting: {}, updated_at: "t0", ...(squadBudget ? { daily_budget_micro: squadBudget * 1e6 } : {}) };
  return w;
}

test("F3: enabling a campaign with its own daily budget is counted and limited, not waved through", async () => {
  const h = await setup({ world: cboWorld(), env: { SNAP_MAX_DAILY_BUDGET: "100" } });
  const r = await h.call("snap_set_status", { entity: "campaign", id: "cbo", status: "ACTIVE" });
  assert.match(r.error ?? "", /campaign "CBO" has a daily budget of 50000.*SNAP_MAX_DAILY_BUDGET/);
  assert.equal(h.db.campaigns.cbo.status, "PAUSED");
  assert.equal(h.writes().length, 0);
});

test("F3: a campaign budget within the limits is counted in the amount that starts delivering", async () => {
  const h = await setup({ world: cboWorld(80), env: { SNAP_MAX_DAILY_BUDGET: "100" } });
  const preview = await h.call("snap_set_status", { entity: "campaign", id: "cbo", status: "ACTIVE" });
  assert.equal(preview.data.activation.daily_budget_that_starts_delivering, 80);
  assert.equal(preview.data.spend_impact.adds_daily_budget, 80);
  const squads = await h.call("snap_set_status", { entity: "campaign", id: "c2", status: "ACTIVE" });
  assert.equal(squads.data.activation.daily_budget_that_starts_delivering, 80, "campaigns without their own budget are counted as before");
});

test("F3: when the squads carry the budget, the campaign budget does not count twice", async () => {
  const h = await setup({ world: cboWorld(60, 60), env: { SNAP_MAX_DAILY_BUDGET: "100" } });
  const r = await h.call("snap_set_status", { entity: "campaign", id: "cbo", status: "ACTIVE" });
  assert.equal(r.data.activation.daily_budget_that_starts_delivering, 60, "max of the squads' budgets and the campaign budget, not the sum");
});

test("F3: the first ad squad to deliver under an ACTIVE campaign with its own budget counts that budget", async () => {
  const w = cboWorld(70);
  w.campaigns.cbo.status = "ACTIVE";
  w.adsquads.q1.status = "PAUSED";
  const h = await setup({ world: w, env: { SNAP_MAX_DAILY_BUDGET: "100" } });
  const r = await h.call("snap_set_status", { entity: "adsquad", id: "q1", status: "ACTIVE" });
  assert.equal(r.data.activation.daily_budget_that_starts_delivering, 70);
  const big = cboWorld(5000);
  big.campaigns.cbo.status = "ACTIVE";
  big.adsquads.q1.status = "PAUSED";
  const h2 = await setup({ world: big, env: { SNAP_MAX_DAILY_BUDGET: "100" } });
  assert.match((await h2.call("snap_set_status", { entity: "adsquad", id: "q1", status: "ACTIVE" })).error ?? "", /campaign "CBO" has a daily budget of 5000/);
});

test("F1: a target edited during the human approval question is refused, not overwritten", async () => {
  let h;
  h = await setup({ env: { SNAP_HUMAN_APPROVAL: "elicit" }, elicit: async () => {
    h.db.campaigns.c1 = { ...h.db.campaigns.c1, status: "PAUSED", updated_at: "t-human" }; // paused in Ads Manager while the dialog is open
    return { action: "accept", content: { approve: true } };
  } });
  const { applied } = await h.twoStep("snap_rename", { entity: "campaign", id: "c1", new_name: "Renamed c1" });
  assert.match(applied.error ?? "", /changed while the approval question was open/);
  assert.equal(h.db.campaigns.c1.status, "PAUSED", "the person's pause stands");
  assert.equal(h.db.campaigns.c1.name, "Campaign c1", "the rename was not applied");
  assert.equal(h.writes().length, 0);
});

test("F1: an unchanged item is still applied after the approval question", async () => {
  const h = await setup({ env: { SNAP_HUMAN_APPROVAL: "elicit" }, elicit: async () => ({ action: "accept", content: { approve: true } }) });
  const { applied } = await h.twoStep("snap_rename", { entity: "campaign", id: "c1", new_name: "Renamed c1" });
  assert.ok(!applied.error, applied.error);
  assert.equal(h.db.campaigns.c1.name, "Renamed c1");
});

test("F1: without the approval question, a change made between the preview and the apply is still not overwritten", async () => {
  const h = await setup();
  const preview = await h.call("snap_rename", { entity: "campaign", id: "c1", new_name: "Renamed c1" });
  h.db.campaigns.c1 = { ...h.db.campaigns.c1, status: "PAUSED", updated_at: "t-other" };
  const applied = await h.call("snap_rename", { entity: "campaign", id: "c1", new_name: "Renamed c1", confirm: true, approval_token: preview.data.approval_token });
  assert.ok(applied.error, "refused");
  assert.equal(h.db.campaigns.c1.status, "PAUSED");
});

import { checkReadPath } from "../src/readers.js";

test("F5: encoded dot segments and other tricks are refused in snap_api_get paths", () => {
  for (const bad of ["/adaccounts/%2e%2e/%2e%2e/oauth2/x", "/adaccounts/%2E%2E/x", "/adaccounts/a%2fb", "/adaccounts/x#y", "/adaccounts/a\\b", "/adaccounts/x\n", "/adaccounts/../me"]) assert.throws(() => checkReadPath(bad), /path must start with/, JSON.stringify(bad));
  assert.equal(checkReadPath("/adaccounts/abc-123/campaigns"), "/adaccounts/abc-123/campaigns");
  assert.equal(checkReadPath("/me"), "/me");
});

test("F8: undo with force cannot restore a daily budget above the ceiling, even when the item is on a lifetime budget now", async () => {
  const w = sampleWorld();
  w.adsquads.big = { id: "big", name: "Big", status: "PAUSED", campaign_id: "c1", daily_budget_micro: 2000e6, bid_micro: 2e6, targeting: {}, updated_at: "t0" };
  const h = await setup({ world: w, env: { SNAP_MAX_DAILY_BUDGET: "1000" } });
  assert.ok(!(await h.twoStep("snap_set_daily_budget", { entity: "adsquad", id: "big", daily_budget: 500 })).applied.error);
  h.db.adsquads.big = { ...h.db.adsquads.big, daily_budget_micro: null, lifetime_budget_micro: 9000e6, updated_at: "t-x" };
  const undo = await h.call("snap_undo", { force: true });
  assert.match(undo.error ?? "", /above the absolute limit of 1000/);
  assert.equal(h.db.adsquads.big.daily_budget_micro, null, "the 2000 a day was not put back");
});

test("F9: a dynamic template that does not say which account it belongs to is refused", async () => {
  const w = sampleWorld();
  w.dynamic_templates.dtq = { id: "dtq", name: "No account", layout: "AUTOMATIC" };
  const h = await setup({ world: w });
  const r = await h.call("snap_create_creative", { creative_type: "DYNAMIC_PRODUCT", name: "Dyn", headline: "Hi", dynamic_template_id: "dtq", product_set_id: "ps1" });
  assert.match(r.error ?? "", /cannot be verified/);
  assert.equal(h.writes().length, 0);
});

test("F15: an ad schedule naming only some days is accepted through the tool, as documented", async () => {
  const w = sampleWorld();
  w.adsquads.s1 = { ...w.adsquads.s1, daily_budget_micro: null, lifetime_budget_micro: 100e6 };
  const h = await setup({ world: w });
  const r = await h.call("snap_set_ad_schedule", { adsquad_id: "s1", schedule: { friday: [18, 19] } });
  assert.ok(!r.error, r.error);
  assert.ok(r.data.approval_token, "a preview with an approval token");
  assert.doesNotMatch(JSON.stringify(r.data), /schedule\.monday/);
});

import { mkdtempSync as mk } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SnapClient } from "../src/snap.js";
import { registerTools } from "../src/tools.js";

// A server whose Snap answers the login's list of ad accounts, so snap_connect's account step can run.
async function connectServer({ env = {}, account = "acc-1", elicit } = {}) {
  const dir = mk(join(tmpdir(), "connect-"));
  const file = join(dir, ".env");
  writeFileSync(file, "SNAP_REFRESH_TOKEN=existing-token-1234567890\n");
  const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b, headers: { get: () => null } });
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.hostname.includes("accounts")) return json({ access_token: "t", expires_in: 1800 });
    if (u.pathname.endsWith("/me/organizations")) return json({ organizations: [{ organization: { name: "Org", ad_accounts: [{ id: "acc-1", name: "One", status: "ACTIVE", currency: "USD" }, { id: "acc-2", name: "Two", status: "ACTIVE", currency: "USD" }] } }] });
    return json({}, 404);
  };
  const full = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r", SNAP_LOG_FILE: join(dir, "log.jsonl"), ...(account ? { SNAP_AD_ACCOUNT_ID: account } : {}), ...env };
  const server = new McpServer({ name: "t", version: "1" });
  registerTools(server, new SnapClient({ env: full, fetchImpl, sleep: async () => {} }), full);
  const client = new Client({ name: "c", version: "1" }, elicit ? { capabilities: { elicitation: { form: {} } } } : undefined);
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => elicit(req.params));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (args) => {
    const old = process.env.SNAP_ENV_FILE;
    process.env.SNAP_ENV_FILE = file;
    try {
      const r = await client.callTool({ name: "snap_connect", arguments: args });
      return { error: r.isError ? r.content[0].text : undefined, text: r.content?.[0]?.text, saved: readFileSync(file, "utf8") };
    } finally {
      if (old === undefined) delete process.env.SNAP_ENV_FILE;
      else process.env.SNAP_ENV_FILE = old;
    }
  };
  return { client, call };
}

test("F6: snap_connect is marked destructive", async () => {
  const { client } = await connectServer();
  const tool = (await client.listTools()).tools.find((x) => x.name === "snap_connect");
  assert.equal(tool.annotations.destructiveHint, true);
});

test("F6: read-only mode refuses to switch the ad account once one is set, and writes nothing", async () => {
  const { call } = await connectServer({ env: { SNAP_READ_ONLY: "1" } });
  const r = await call({ ad_account_id: "acc-2" });
  assert.match(r.error ?? "", /SNAP_READ_ONLY is on, so this server will not switch the ad account to Two/);
  assert.doesNotMatch(r.saved, /SNAP_AD_ACCOUNT_ID/);
});

test("F6: the first connection (no ad account set yet) works even in read-only mode, and choosing the current account is not a switch", async () => {
  const fresh = await connectServer({ env: { SNAP_READ_ONLY: "1" }, account: null });
  const r = await fresh.call({ ad_account_id: "acc-2" });
  assert.ok(!r.error, r.error);
  assert.match(r.saved, /SNAP_AD_ACCOUNT_ID=acc-2/);
  const same = await connectServer({ env: { SNAP_READ_ONLY: "1" } });
  const again = await same.call({ ad_account_id: "acc-1" });
  assert.ok(!again.error, again.error);
});

test("F6: with human approval on, switching the account asks the person; a refusal writes nothing, an approval saves it", async () => {
  const asked = [];
  const no = await connectServer({ env: { SNAP_HUMAN_APPROVAL: "elicit" }, elicit: async (p) => { asked.push(p.message); return { action: "decline" }; } });
  const refused = await no.call({ ad_account_id: "acc-2" });
  assert.ok(refused.error);
  assert.match(asked[0], /snap_connect/);
  assert.match(asked[0], /switch the ad account to Two/);
  assert.doesNotMatch(refused.saved, /SNAP_AD_ACCOUNT_ID/);
  const yes = await connectServer({ env: { SNAP_HUMAN_APPROVAL: "elicit" }, elicit: async () => ({ action: "accept", content: { approve: true } }) });
  const ok = await yes.call({ ad_account_id: "acc-2" });
  assert.ok(!ok.error, ok.error);
  assert.match(ok.saved, /SNAP_AD_ACCOUNT_ID=acc-2/);
});
