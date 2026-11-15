// The shared login through the setup wizard and the in-chat connect tool, against the real login service code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker from "../broker/worker.js";
import { runSetup } from "../src/setup.js";
import { SnapClient } from "../src/snap.js";
import { registerTools } from "../src/tools.js";
import { webcrypto as nodeCrypto } from "node:crypto";

// Node 18 has no global `crypto` (Cloudflare Workers and Node 20+ do); the Worker code expects it.
globalThis.crypto ??= nodeCrypto;

const SVC = { SNAP_CLIENT_ID: "app-id", SNAP_CLIENT_SECRET: "APP-SECRET-VALUE", STATE_KEY: "k".repeat(40), PUBLIC_URL: "https://login.example" };
const REFRESH = "REFRESH-TOKEN-FOR-ALICE-" + "x".repeat(200);
const ACC = "aaaaaaaa-0000-0000-0000-000000000001";

// One fake internet: the login service (real code), Snapchat's token endpoint and the Marketing API.
function internet() {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    seen.push(`${opts.method ?? "GET"} ${u.hostname}${u.pathname}`);
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b, headers: { get: () => null } });
    if (u.hostname === "login.example") return worker.fetch(new Request(String(url), opts), SVC, undefined, snapToken);
    if (u.hostname.includes("accounts")) return snapToken(url, opts);
    if (u.pathname === "/v1/me") return json({ me: { display_name: "Alice" } });
    if (u.pathname === "/v1/me/organizations") return json({ organizations: [{ organization: { name: "Org", ad_accounts: [{ id: ACC, name: "Shop", status: "ACTIVE", currency: "USD" }] } }] });
    return json({}, 404);
  };
  const snapToken = async (url, opts) => {
    const body = Object.fromEntries(new URLSearchParams(String(opts.body)));
    return body.grant_type === "authorization_code" ? { ok: true, status: 200, json: async () => ({ refresh_token: REFRESH, access_token: "A1" }) } : { ok: true, status: 200, json: async () => ({ access_token: "ACCESS", expires_in: 1800 }) };
  };
  return { fetchImpl, seen };
}

// The browser: login link -> service -> (Snapchat) -> service -> the person's own loopback listener.
async function browse(loginUrl) {
  const first = await worker.fetch(new Request(loginUrl), SVC);
  const cookie = first.headers.get("Set-Cookie").split(";")[0];
  const state = new URL(first.headers.get("Location")).searchParams.get("state");
  const net = internet();
  const back = await worker.fetch(new Request(`https://login.example/callback?code=CODE&state=${state}`, { headers: { Cookie: cookie } }), SVC, undefined, net.fetchImpl);
  return fetch(back.headers.get("Location"));
}

const scripted = (answers) => {
  const printed = [];
  const q = [...answers];
  const next = (prompt) => {
    printed.push(prompt);
    if (!q.length) throw new Error(`no answer for: ${prompt}`);
    return q.shift();
  };
  return { printed, io: { print: (s = "") => printed.push(s), ask: async (p) => next(p), askSecret: async (p) => next(p) } };
};

test("setup wizard, shared login: no Client ID or secret is asked for; only the refresh token and the service address are saved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-"));
  const file = join(dir, ".env");
  const net = internet();
  let openedUrl = null;
  const { io, printed } = scriptedIO([ "1", "1", "500", "SA", "", "snap-test" ]);
  // the wizard "opens a browser": here, the simulated browser finishes the login in the background
  const open = (url) => ((openedUrl = url), browse(url), true);
  const r = await runSetup({ io, file, fetchImpl: net.fetchImpl, open, exec: () => {}, claudeAvailable: () => false, root: "/work/ads-mcp-for-snapchat", broker: "https://login.example" });
  const saved = readFileSync(file, "utf8").split("\n");
  assert.ok(saved.includes(`SNAP_REFRESH_TOKEN=${REFRESH}`) && saved.includes("SNAP_BROKER_URL=https://login.example"));
  assert.ok(saved.includes(`SNAP_AD_ACCOUNT_ID=${ACC}`));
  assert.ok(saved.every((l) => !/^SNAP_CLIENT_SECRET=.+/.test(l)), "no app secret on this computer");
  assert.equal(r.account.name, "Shop");
  const out = printed.join("\n");
  assert.ok(!out.includes(REFRESH) && !out.includes("APP-SECRET"), "nothing secret is printed");
  assert.match(out, /Shared login \(easiest\)/);
  assert.match(openedUrl, /^https:\/\/login\.example\/login\?port=\d+&pk=/);
  assert.ok(net.seen.some((s) => s === "POST login.example/v1/refresh"), "the account list was read through the service's token renewal");
  assert.ok(!net.seen.some((s) => s.includes("accounts.snapchat.com")), "the computer never talked to Snapchat's login itself");
});

function scriptedIO(answers) {
  return scripted(answers);
}

test("setup wizard: choosing your own app (2) keeps the old flow; an existing own-app file is never offered the shared login", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-"));
  const file = join(dir, ".env");
  const net = internet();
  const first = scriptedIO(["2", "not-an-id"]);
  await assert.rejects(runSetup({ io: first.io, file, fetchImpl: net.fetchImpl, open: () => true, exec: () => {}, claudeAvailable: () => false, root: "/x", broker: "https://login.example" }), /no answer|Too many/, "it asked for a Client ID, the own-app flow");
  assert.match(first.printed.join("\n"), /Client ID/);
  const ownFile = join(dir, ".env.own");
  writeFileSync(ownFile, "SNAP_CLIENT_ID=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\nSNAP_CLIENT_SECRET=S3cretValue_abcdefghijklmnop\n");
  const second = scriptedIO(["", ""]);
  await assert.rejects(runSetup({ io: second.io, file: ownFile, fetchImpl: net.fetchImpl, open: () => true, exec: () => {}, claudeAvailable: () => false, root: "/x", broker: "https://login.example" }), /no answer/);
  assert.ok(!second.printed.join("\n").includes("Shared login (easiest)"), "own app credentials are never replaced by offering the shared login");
});

test("setup wizard: without a login service address nothing about the shared login appears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-"));
  const { io, printed } = scriptedIO(["not-an-id"]);
  await assert.rejects(runSetup({ io, file: join(dir, ".env"), fetchImpl: internet().fetchImpl, open: () => true, exec: () => {}, claudeAvailable: () => false, root: "/x", broker: null }), /no answer|Too many/);
  assert.ok(!printed.join("\n").includes("Shared login"));
});

async function chatTool(env) {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  const file = join(dir, ".env");
  const saved = process.env.SNAP_ENV_FILE;
  process.env.SNAP_ENV_FILE = file;
  const net = internet();
  const server = new McpServer({ name: "t", version: "1" });
  registerTools(server, new SnapClient({ env, fetchImpl: net.fetchImpl, sleep: async () => {} }), { ...env, SNAP_LOG_FILE: join(dir, "log.jsonl"), SNAP_READ_ONLY: "1" });
  const client = new Client({ name: "c", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (args = {}) => {
    const r = await client.callTool({ name: "snap_connect", arguments: args });
    return { error: r.isError, text: r.content[0].text, data: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  return { call, file, close: async () => { await client.close(); if (saved === undefined) delete process.env.SNAP_ENV_FILE; else process.env.SNAP_ENV_FILE = saved; } };
}

test("snap_connect with the shared login: a link, the browser finishes it, no address is pasted, the token is saved and never shown", async () => {
  const env = { SNAP_BROKER_URL: "https://login.example" };
  const t = await chatTool(env);
  try {
    const s1 = await t.call();
    assert.equal(s1.data.step, 1);
    assert.match(s1.data.link, /^https:\/\/login\.example\/login\?port=\d+&pk=/);
    const again = await t.call();
    assert.equal(again.data.waiting, true, "calling again before the browser finishes says it is still waiting");
    assert.equal(again.data.link, s1.data.link);
    assert.ok((await t.call({ redirected_url: "https://x/?code=1" })).error, "pasting an address is not part of this flow");
    const page = await browse(s1.data.link);
    assert.equal(page.status, 200);
    await new Promise((r) => setTimeout(r, 30));
    const s2 = await t.call();
    assert.equal(s2.data.connected, true);
    assert.deepEqual(s2.data.ad_accounts.map((a) => a.name), ["Shop"]);
    assert.ok(!s2.text.includes(REFRESH), "the refresh token is never returned to the chat");
    assert.ok(readFileSync(t.file, "utf8").includes(`SNAP_REFRESH_TOKEN=${REFRESH}`));
    const s3 = await t.call({ ad_account_id: ACC });
    assert.match(s3.data.next, /reopen/);
    assert.ok(readFileSync(t.file, "utf8").split("\n").includes(`SNAP_AD_ACCOUNT_ID=${ACC}`));
  } finally {
    await t.close();
  }
});

test("snap_connect with no service address and no app credentials still explains where to enter them", async () => {
  const t = await chatTool({});
  try {
    assert.match((await t.call()).text, /extension's settings/);
  } finally {
    await t.close();
  }
});
