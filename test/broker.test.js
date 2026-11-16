// The login service: it must hand each person's token only to their own computer, store nothing, and refuse misuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import worker, { readState, signState } from "../broker/worker.js";
import { generateKeyPair, open } from "../src/hybrid.js";
import { webcrypto as nodeCrypto } from "node:crypto";

// Node 18 has no global `crypto` (Cloudflare Workers and Node 20+ do); the Worker code expects it.
globalThis.crypto ??= nodeCrypto;

const ENV = { SNAP_CLIENT_ID: "app-id", SNAP_CLIENT_SECRET: "APP-SECRET-VALUE", STATE_KEY: "k".repeat(40), PUBLIC_URL: "https://login.example" };
const NONCE = "n".repeat(24);

// Snap, faked: records what it was sent.
function fakeSnap({ refresh = "REFRESH-TOKEN-FOR-ALICE-" + "x".repeat(400), accept = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = Object.fromEntries(new URLSearchParams(String(opts.body)));
    calls.push({ url: String(url), body });
    if (!accept) return { ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: "Invalid authorization code" }) };
    return body.grant_type === "authorization_code"
      ? { ok: true, status: 200, json: async () => ({ access_token: "ACCESS-1", refresh_token: refresh, expires_in: 1800 }) }
      : { ok: true, status: 200, json: async () => ({ access_token: "ACCESS-2", expires_in: 1800 }) };
  };
  return { fetchImpl, calls };
}
const call = (path, { method = "GET", headers = {}, body, env = ENV, fetchImpl } = {}) => worker.fetch(new Request(`https://login.example${path}`, { method, headers, body }), env, undefined, fetchImpl);

async function startLogin(over = {}) {
  const keys = await generateKeyPair(webcrypto);
  const q = new URLSearchParams({ port: "53123", pk: keys.publicKey, nonce: NONCE, ...over });
  const res = await call(`/login?${q}`);
  return { keys, res };
}

test("login: sends the person to Snapchat with a signed state and a cookie bound to this browser", async () => {
  const { res } = await startLogin();
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("Location"));
  assert.equal(to.origin + to.pathname, "https://accounts.snapchat.com/login/oauth2/authorize");
  assert.deepEqual([to.searchParams.get("client_id"), to.searchParams.get("redirect_uri"), to.searchParams.get("scope"), to.searchParams.get("response_type")], ["app-id", "https://login.example/callback", "snapchat-marketing-api", "code"]);
  const cookie = res.headers.get("Set-Cookie");
  assert.match(cookie, new RegExp(`^ads_mcp_login=${NONCE}; Path=/callback; Max-Age=600; HttpOnly; Secure; SameSite=None$`));
  const state = await readState(ENV, to.searchParams.get("state"));
  assert.deepEqual([state.p, state.n], [53123, NONCE]);
  assert.ok(!res.headers.get("Location").includes("APP-SECRET-VALUE"), "the secret is never in a link");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("login: refuses anything that could send a token somewhere else or is malformed", async () => {
  const bad = [{ port: "80" }, { port: "70000" }, { port: "abc" }, { port: "53123/../x" }, { pk: "AAAA" }, { nonce: "short" }, { nonce: "has space has space!!" }];
  for (const over of bad) assert.equal((await startLogin(over)).res.status, 400, JSON.stringify(over));
  assert.equal((await call("/login")).status, 400);
  assert.equal((await call("/login?port=53123", { method: "POST" })).status, 404, "only GET");
});

test("callback: exchanges the code, seals the token to the person's key, redirects to THEIR computer, stores nothing", async () => {
  const { keys, res } = await startLogin();
  const state = new URL(res.headers.get("Location")).searchParams.get("state");
  const snap = fakeSnap();
  const back = await call(`/callback?code=GOOD-CODE&state=${state}`, { headers: { Cookie: `ads_mcp_login=${NONCE}` }, fetchImpl: snap.fetchImpl });
  assert.equal(back.status, 302);
  const to = new URL(back.headers.get("Location"));
  assert.deepEqual([to.protocol, to.hostname, to.port, to.pathname], ["http:", "127.0.0.1", "53123", "/callback"], "only the loopback address of the person's own machine");
  assert.deepEqual(snap.calls.map((c) => [c.url, c.body.grant_type, c.body.code, c.body.client_secret, c.body.redirect_uri]), [["https://accounts.snapchat.com/login/oauth2/access_token", "authorization_code", "GOOD-CODE", "APP-SECRET-VALUE", "https://login.example/callback"]]);
  const text = back.headers.get("Location");
  assert.ok(!text.includes("REFRESH-TOKEN") && !text.includes("ACCESS-1") && !text.includes("APP-SECRET"), "no plaintext token or secret in the redirect");
  const sealed = { v: 1, epk: to.searchParams.get("epk"), salt: to.searchParams.get("salt"), iv: to.searchParams.get("iv"), ct: to.searchParams.get("ct") };
  assert.match(await open(keys.privateKey, sealed, to.searchParams.get("nonce"), webcrypto), /^REFRESH-TOKEN-FOR-ALICE-x{400}$/, "the person's computer can open it");
  const stranger = await generateKeyPair(webcrypto);
  await assert.rejects(open(stranger.privateKey, sealed, NONCE, webcrypto), /could not open/, "nobody else can");
  assert.match(back.headers.get("Set-Cookie"), /Max-Age=0/, "the cookie is cleared");
});

test("callback: a state that was changed, expired, signed by another key, or used in another browser is refused", async () => {
  const { res } = await startLogin();
  const state = new URL(res.headers.get("Location")).searchParams.get("state");
  const snap = fakeSnap();
  const go = (s, cookie = `ads_mcp_login=${NONCE}`) => call(`/callback?code=C&state=${s}`, { headers: cookie ? { Cookie: cookie } : {}, fetchImpl: snap.fetchImpl });
  const [body, sig] = state.split(".");
  const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), p: 6666 })).toString("base64url");
  assert.equal((await go(`${evil}.${sig}`)).status, 400, "changing the port (to steal the token) breaks the signature");
  assert.equal((await go(`${body}.${sig.slice(0, -2)}AA`)).status, 400);
  assert.equal((await go("garbage")).status, 400);
  assert.equal((await go(`${state}.extra`)).status, 400);
  const expired = await signState(ENV, { p: 53123, k: "x", n: NONCE, e: Date.now() - 1000 });
  assert.equal((await go(expired)).status, 400, "expired");
  const otherKey = await signState({ ...ENV, STATE_KEY: "z".repeat(40) }, { p: 53123, k: "x", n: NONCE, e: Date.now() + 60000 });
  assert.equal((await go(otherKey)).status, 400, "signed by a different key");
  const noCookie = await go(state, null);
  assert.equal(noCookie.status, 400, "no cookie: a login started in another browser cannot be completed here");
  assert.match(await noCookie.text(), /did not start the login/, "the page says what is wrong, so it can be fixed");
  assert.equal((await go(state, "ads_mcp_login=another-nonce-another-nonce")).status, 400, "wrong cookie");
  assert.equal(snap.calls.length, 0, "Snapchat was never contacted for any of these");
});

test("callback: Snapchat saying no, an error, or a missing code ends with a page, never a redirect or a token", async () => {
  const { res } = await startLogin();
  const state = new URL(res.headers.get("Location")).searchParams.get("state");
  const h = { Cookie: `ads_mcp_login=${NONCE}` };
  const refused = await call(`/callback?code=BAD&state=${state}`, { headers: h, fetchImpl: fakeSnap({ accept: false }).fetchImpl });
  assert.equal(refused.status, 502);
  assert.equal(refused.headers.get("Location"), null);
  assert.ok(!(await refused.text()).includes("invalid_grant"), "Snap's raw answer is not echoed");
  const cancelled = await call(`/callback?error=access_denied&state=${state}`, { headers: h, fetchImpl: fakeSnap().fetchImpl });
  assert.equal(cancelled.status, 400);
  assert.equal((await call(`/callback?state=${state}`, { headers: h, fetchImpl: fakeSnap().fetchImpl })).status, 400);
});

test("refresh: swaps a refresh token for an access token using the secret, returns nothing else, and rejects misuse", async () => {
  const snap = fakeSnap();
  const post = (body, headers = { "Content-Type": "application/json" }) => call("/v1/refresh", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body), fetchImpl: snap.fetchImpl });
  const ok = await post({ refresh_token: "A-REFRESH-TOKEN-123" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { access_token: "ACCESS-2", expires_in: 1800 });
  assert.deepEqual(snap.calls[0].body, { grant_type: "refresh_token", refresh_token: "A-REFRESH-TOKEN-123", client_id: "app-id", client_secret: "APP-SECRET-VALUE" });
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), null, "no CORS: a web page cannot call it");
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  assert.equal((await call("/v1/refresh", { method: "GET" })).status, 405);
  assert.equal((await post({ refresh_token: "A-REFRESH-TOKEN-123" }, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ refresh_token: "short" })).status, 400);
  assert.equal((await post({ refresh_token: "has a space in it" })).status, 400);
  assert.equal((await post({ refresh_token: "x".repeat(5000) })).status, 400, "a token longer than any real one");
  assert.equal((await post({ refresh_token: "x".repeat(9000) })).status, 413, "a body over 8 KB is not even read further");
  assert.equal(snap.calls.length, 1, "bad requests never reach Snapchat");
  const refused = await call("/v1/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: "A-REFRESH-TOKEN-123" }), fetchImpl: fakeSnap({ accept: false }).fetchImpl });
  assert.equal(refused.status, 401);
  const out = JSON.stringify(await refused.json());
  assert.ok(!out.includes("APP-SECRET") && !out.includes("A-REFRESH-TOKEN"), "an error never echoes the secret or the token");
});

test("a rotated refresh token is passed back; an unchanged one is not repeated", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ access_token: "A", expires_in: 100, refresh_token: "NEW-REFRESH-TOKEN-1" }) });
  const r = await call("/v1/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: "OLD-REFRESH-TOKEN-1" }), fetchImpl });
  assert.equal((await r.json()).refresh_token, "NEW-REFRESH-TOKEN-1");
});

test("the service stores and logs nothing: no console output, no storage bindings used", async () => {
  const logged = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => logged.push(a);
  try {
    const { res } = await startLogin();
    const state = new URL(res.headers.get("Location")).searchParams.get("state");
    const snap = fakeSnap();
    await call(`/callback?code=C&state=${state}`, { headers: { Cookie: `ads_mcp_login=${NONCE}` }, fetchImpl: snap.fetchImpl });
    await call("/v1/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: "A-REFRESH-TOKEN-123" }), fetchImpl: snap.fetchImpl });
    await call("/callback?state=bad");
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(logged, []);
  const code = (await import("node:fs")).readFileSync(new URL("../broker/worker.js", import.meta.url), "utf8");
  assert.ok(!/env\.(KV|DB|BUCKET|STORE)|caches\.|localStorage|console\./.test(code), "the Worker uses no storage and does not log");
});

test("pages: home and privacy exist; unknown paths 404; a missing setting gives a safe 503 that names no value", async () => {
  assert.match(await (await call("/")).text(), /stores nothing/);
  const privacy = await call("/privacy");
  assert.match(await privacy.text(), /does <strong>not store<\/strong> tokens/);
  assert.match(privacy.headers.get("Content-Security-Policy"), /default-src 'none'/);
  assert.equal((await call("/admin")).status, 404);
  const broken = await call(`/login?port=53123&pk=x&nonce=${NONCE}`, { env: { ...ENV, STATE_KEY: undefined } });
  assert.equal(broken.status, 503);
  const text = await broken.text();
  assert.match(text, /Missing setting: <code>STATE_KEY<\/code>/);
  assert.ok(!text.includes("APP-SECRET"));
  const keys = await generateKeyPair(webcrypto);
  const short = await call(`/login?port=53123&pk=${keys.publicKey}&nonce=${NONCE}`, { env: { ...ENV, STATE_KEY: "short" } });
  assert.equal(short.status, 503);
});
