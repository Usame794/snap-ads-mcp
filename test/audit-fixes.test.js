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
