import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapClient } from "../src/snap.js";

const env = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };
const res = (status, body = {}, headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[k] }, json: async () => body });

function client(script) {
  const calls = [];
  const delays = [];
  let i = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes("access_token")) return res(200, { access_token: "t", expires_in: 1800 });
    calls.push((opts.method ?? "GET") + " " + new URL(String(url)).pathname);
    const step = script[Math.min(i++, script.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return { calls, delays, client: new SnapClient({ env, fetchImpl, sleep: async (ms) => delays.push(ms) }) };
}

test("GET retries on 503 with growing waits, then succeeds", async () => {
  const { calls, delays, client: c } = client([res(503), res(503), res(200, { ok: 1 })]);
  assert.deepEqual(await c.request("GET", "/me"), { ok: 1 });
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [500, 1000]);
});

test("GET honours Retry-After on 429", async () => {
  const { delays, client: c } = client([res(429, {}, { "retry-after": "3" }), res(200, { ok: 1 })]);
  await c.request("GET", "/me");
  assert.deepEqual(delays, [3000]);
});

test("GET gives up after 4 attempts and reports the last error", async () => {
  const { calls, client: c } = client([res(503, { debug_message: "down" })]);
  await assert.rejects(() => c.request("GET", "/me"), /503.*down/);
  assert.equal(calls.length, 4);
});

test("GET retries network errors; 4xx other than 429 is never retried", async () => {
  const a = client([new Error("socket hang up"), res(200, { ok: 1 })]);
  assert.deepEqual(await a.client.request("GET", "/me"), { ok: 1 });
  assert.equal(a.calls.length, 2);
  const b = client([res(400, { debug_message: "bad" })]);
  await assert.rejects(() => b.client.request("GET", "/me"), /400/);
  assert.equal(b.calls.length, 1);
});

test("writes are NOT retried on 5xx or network errors (no duplicate creates)", async () => {
  const a = client([res(500, { debug_message: "x" }), res(200, {})]);
  await assert.rejects(() => a.client.request("POST", "/adaccounts/a/campaigns", { body: { campaigns: [{}] } }), /500/);
  assert.equal(a.calls.length, 1);
  const b = client([new Error("socket hang up"), res(200, {})]);
  await assert.rejects(() => b.client.request("PUT", "/x", { body: {} }), /socket hang up/);
  assert.equal(b.calls.length, 1);
});

test("writes DO retry on 429 (rejected before processing)", async () => {
  const { calls, client: c } = client([res(429), res(200, { request_status: "SUCCESS" })]);
  await c.request("POST", "/adaccounts/a/campaigns", { body: { campaigns: [{}] } });
  assert.equal(calls.length, 2);
});
