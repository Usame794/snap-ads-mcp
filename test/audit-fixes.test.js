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
