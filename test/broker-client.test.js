// The computer's side of the shared login, run end to end against the real login service code and a fake Snapchat.
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import worker from "../broker/worker.js";
import { brokerUrlFrom, refreshViaBroker, startBrokerLogin } from "../src/broker.js";
import { SnapClient } from "../src/snap.js";

const ENV = { SNAP_CLIENT_ID: "app-id", SNAP_CLIENT_SECRET: "APP-SECRET-VALUE", STATE_KEY: "k".repeat(40), PUBLIC_URL: "https://login.example" };
const REFRESH = "REFRESH-TOKEN-FOR-ALICE-" + "x".repeat(300);

const fakeSnap = () => {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, opts) => {
      const body = Object.fromEntries(new URLSearchParams(String(opts.body)));
      calls.push(body);
      return body.grant_type === "authorization_code" ? { ok: true, status: 200, json: async () => ({ refresh_token: REFRESH, access_token: "A1", expires_in: 1800 }) } : { ok: true, status: 200, json: async () => ({ access_token: "ACCESS-FROM-REFRESH", expires_in: 1800 }) };
    },
  };
};

// What a browser would do: follow the login link through the service and Snapchat, then land on the loopback address.
async function browser(loginUrl, snap, { tamper } = {}) {
  const first = await worker.fetch(new Request(loginUrl), ENV);
  const cookie = first.headers.get("Set-Cookie").split(";")[0];
  const state = new URL(first.headers.get("Location")).searchParams.get("state");
  const back = await worker.fetch(new Request(`https://login.example/callback?code=CODE&state=${state}`, { headers: { Cookie: cookie } }), ENV, undefined, snap.fetchImpl);
  let target = back.headers.get("Location");
  if (tamper) target = tamper(target);
  return fetch(target);
}

test("broker address: https only (or loopback for testing), just an address, a package default, and none when unset", () => {
  assert.equal(brokerUrlFrom({}, ""), null);
  assert.equal(brokerUrlFrom({ SNAP_BROKER_URL: "https://login.example.com" }, ""), "https://login.example.com");
  assert.equal(brokerUrlFrom({ SNAP_BROKER_URL: "https://login.example.com/" }, ""), "https://login.example.com");
  assert.equal(brokerUrlFrom({}, "https://default.example"), "https://default.example", "the package default");
  assert.equal(brokerUrlFrom({ SNAP_BROKER_URL: "https://mine.example" }, "https://default.example"), "https://mine.example", "the setting wins");
  assert.equal(brokerUrlFrom({ SNAP_BROKER_URL: "http://127.0.0.1:8787" }, ""), "http://127.0.0.1:8787");
  for (const bad of ["http://login.example.com", "ftp://x.example", "https://u:p@login.example.com", "https://login.example.com/path", "https://login.example.com/?x=1", "not a url"]) assert.throws(() => brokerUrlFrom({ SNAP_BROKER_URL: bad }, ""), /SNAP_BROKER_URL/, bad);
});

test("a full login: the person's computer gets its own refresh token, and the app's secret never reaches it", async () => {
  const snap = fakeSnap();
  const login = await startBrokerLogin({ brokerUrl: "https://login.example" });
  const u = new URL(login.url);
  assert.deepEqual([u.origin, u.pathname, u.searchParams.get("port")], ["https://login.example", "/login", String(login.port)]);
  const page = await browser(login.url, snap);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Connected/);
  assert.equal(await login.done, REFRESH);
  assert.ok(!login.url.includes("APP-SECRET"));
  await assert.rejects(fetch(`http://127.0.0.1:${login.port}/callback`), "the listener closed after the login");
});

test("the listener ignores everything but this login's own, correctly sealed callback", async () => {
  const snap = fakeSnap();
  const login = await startBrokerLogin({ brokerUrl: "https://login.example", timeoutMs: 20_000 });
  const base = `http://127.0.0.1:${login.port}`;
  assert.equal((await fetch(`${base}/other`)).status, 404);
  assert.equal((await fetch(`${base}/callback`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/callback?nonce=wrong&epk=a&salt=b&iv=c&ct=d`)).status, 400);
  // A web page that reaches this listener through a name pointing at 127.0.0.1 (DNS rebinding) sends another Host: refused even with the right nonce.
  const nonce = new URL(login.url).searchParams.get("nonce");
  const viaOtherHost = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: login.port, path: `/callback?nonce=${nonce}&epk=a&salt=b&iv=c&ct=d`, headers: { Host: `evil.example:${login.port}` } }, (r) => (r.resume(), resolve(r.statusCode)));
    req.on("error", reject);
    req.end();
  });
  assert.equal(viaOtherHost, 404, "a request addressed to another host name is refused");
  // a callback sealed for ANOTHER login (a different key) is refused, and the real one still works afterwards
  const other = await startBrokerLogin({ brokerUrl: "https://login.example", timeoutMs: 20_000 });
  const foreign = await browser(other.url, snap);
  assert.equal(foreign.status, 200);
  const stolen = new URL(login.url);
  stolen.searchParams.set("port", String(login.port));
  const wrongTarget = await browser(other.url, snap, { tamper: (t) => t.replace(`:${other.port}/`, `:${login.port}/`) });
  assert.equal(wrongTarget.status, 400, "a callback made for another login cannot complete this one");
  const real = await browser(login.url, snap);
  assert.equal(real.status, 200);
  assert.equal(await login.done, REFRESH);
  other.close();
  await other.done.catch(() => {});
});

test("an abandoned login times out, and cancelling closes the listener", async () => {
  const slow = await startBrokerLogin({ brokerUrl: "https://login.example", timeoutMs: 50 });
  await assert.rejects(slow.done, /not completed in time/);
  const c = await startBrokerLogin({ brokerUrl: "https://login.example" });
  c.close();
  await assert.rejects(c.done, /cancelled/);
  await assert.rejects(fetch(`http://127.0.0.1:${c.port}/callback`));
  await assert.rejects(startBrokerLogin({}), /No login service address/);
});

test("SnapClient with a refresh token and no app secret renews through the service, caches, and needs no client id", async () => {
  const snap = fakeSnap();
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push(String(url));
    const u = new URL(String(url));
    if (u.pathname === "/v1/refresh") return worker.fetch(new Request(String(url), opts), ENV, undefined, snap.fetchImpl);
    return { ok: true, status: 200, json: async () => ({ adaccounts: [] }), headers: { get: () => null } };
  };
  const client = new SnapClient({ env: { SNAP_REFRESH_TOKEN: REFRESH, SNAP_BROKER_URL: "https://login.example" }, fetchImpl, sleep: async () => {} });
  assert.equal(await client.accessToken(), "ACCESS-FROM-REFRESH");
  assert.equal(await client.accessToken(), "ACCESS-FROM-REFRESH", "cached");
  assert.deepEqual(seen, ["https://login.example/v1/refresh"], "one call, to the login service only");
  assert.deepEqual(snap.calls[0], { grant_type: "refresh_token", refresh_token: REFRESH, client_id: "app-id", client_secret: "APP-SECRET-VALUE" }, "the secret is added by the service, not by the computer");
  await client.request("GET", "/me");
  assert.ok(seen.some((u) => u.startsWith("https://adsapi.snapchat.com/v1/me")));
  // own app credentials still work exactly as before, and win over the service
  const own = new SnapClient({ env: { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r", SNAP_BROKER_URL: "https://login.example" }, fetchImpl: async (url) => (assert.match(String(url), /accounts\.snapchat\.com/), { ok: true, status: 200, json: async () => ({ access_token: "OWN", expires_in: 100 }) }), sleep: async () => {} });
  assert.equal(await own.accessToken(), "OWN");
  // nothing configured: a helpful message
  await assert.rejects(new SnapClient({ env: {}, fetchImpl }).accessToken(), /Run `npx -y ads-mcp-for-snapchat setup`/);
  await assert.rejects(new SnapClient({ env: { SNAP_REFRESH_TOKEN: "r" }, fetchImpl }).accessToken(), /Missing SNAP_CLIENT_ID/, "no service address and no secret");
});

test("a refused refresh says to run setup again and never echoes the token", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: "snapchat_refused", reason: "invalid_grant" }) });
  await assert.rejects(refreshViaBroker("https://login.example", REFRESH, fetchImpl), (e) => /run setup again/.test(e.message) && !e.message.includes(REFRESH));
});
