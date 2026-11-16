// The guided setup, run end to end with scripted answers and a fake Snap: no terminal, browser or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, launchCommand } from "../src/setup.js";

// The package default login service must not leak into tests that expect no service.
process.env.SNAP_BROKER_URL = "off";
import { authorizeUrl, extractCode, listAdAccounts } from "../src/oauth.js";

const CLIENT_ID = "d792daec-e585-467a-ad90-ea68ad3851bc".replace(/./g, (c) => (c === "-" ? "-" : "a"));
const SECRET = "S3cretValue_abcdefghijklmnop";
const ACC_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ACC_B = "bbbbbbbb-0000-0000-0000-000000000002";

function fakeSnap({ refuseCode = 0 } = {}) {
  const calls = [];
  let refusals = refuseCode;
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, headers: { get: () => null } });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    const body = opts.body ? Object.fromEntries(new URLSearchParams(String(opts.body))) : {};
    calls.push({ path: u.pathname, grant: body.grant_type, code: body.code, query: Object.fromEntries(u.searchParams) });
    if (u.pathname.endsWith("/access_token")) {
      if (body.grant_type === "authorization_code") {
        if (refusals-- > 0) return json(400, { error: "invalid_grant", error_description: "Invalid authorization code" });
        return body.code === "GOODCODE" ? json(200, { refresh_token: "refresh-123", access_token: "x" }) : json(400, { error: "invalid_grant" });
      }
      return json(200, { access_token: "access-1", expires_in: 1800 });
    }
    if (u.pathname === "/v1/me") return json(200, { me: { display_name: "Test Person" } });
    if (u.pathname === "/v1/me/organizations") {
      return json(200, {
        organizations: [
          { organization: { name: "Org Two", ad_accounts: [{ id: ACC_B, name: "Shop B", status: "ACTIVE", currency: "SAR" }] } },
          { organization: { name: "Org One", ad_accounts: [{ id: ACC_A, name: "Shop A", status: "ACTIVE", currency: "USD" }] } },
        ],
      });
    }
    return json(404, {});
  };
  return { fetchImpl, calls };
}

// Scripted answers. A function answer receives the printed text so far (to read the state from the link).
function scriptedIO(answers) {
  const printed = [];
  const queue = [...answers];
  const next = (q) => {
    printed.push(q);
    if (!queue.length) throw new Error(`no scripted answer for: ${q}`);
    const a = queue.shift();
    return typeof a === "function" ? a(printed.join("\n")) : a;
  };
  return { printed, io: { print: (s = "") => printed.push(s), ask: async (q) => next(q), askSecret: async (q) => next(q) } };
}

let lastUrl = null;
const browser = (url) => {
  lastUrl = url;
  return true;
};
const landing = (code = "GOODCODE") => () => `https://127.0.0.1/callback?code=${code}&state=${new URL(lastUrl).searchParams.get("state")}`;

test("setup: from an empty folder to a connected, registered, read-only account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-"));
  const file = join(dir, ".env");
  const { fetchImpl, calls } = fakeSnap();
  const execCalls = [];
  const exec = (cmd, args) => execCalls.push([cmd, ...args]);
  const { io, printed } = scriptedIO([CLIENT_ID, SECRET, landing(), "2", "300", "SA", "", "my-snap"]);
  const r = await runSetup({ io, file, fetchImpl, open: browser, exec, claudeAvailable: () => true, root: "/work/ads-mcp-for-snapchat" });

  const saved = readFileSync(file, "utf8");
  for (const line of [`SNAP_CLIENT_ID=${CLIENT_ID}`, `SNAP_CLIENT_SECRET=${SECRET}`, "SNAP_REFRESH_TOKEN=refresh-123", `SNAP_AD_ACCOUNT_ID=${ACC_B}`, "SNAP_ACCOUNT_CURRENCY=SAR", "SNAP_MAX_DAILY_BUDGET=300", "SNAP_DEFAULT_COUNTRY=sa", "SNAP_READ_ONLY=1"]) {
    assert.ok(saved.split("\n").includes(line), `settings contain ${line.split("=")[0]}`);
  }
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(r.account.name, "Shop B", "accounts are listed sorted by organization, so 2 is Org Two's Shop B");
  // The browser got a real authorization link for this app, with a state the pasted address had to match.
  const link = new URL(lastUrl);
  assert.equal(link.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(link.searchParams.get("redirect_uri"), "https://127.0.0.1/callback");
  assert.equal(calls.find((c) => c.path === "/v1/me/organizations").query.with_ad_accounts, "true");
  // Registered with the server name BEFORE -e; the default settings file needs no -e at all here.
  assert.deepEqual(execCalls[0].slice(0, 6), ["claude", "mcp", "add", "--scope", "user", "my-snap"]);
  assert.ok(execCalls[0].includes("-e") && execCalls[0].indexOf("-e") > execCalls[0].indexOf("my-snap"));
  assert.deepEqual(execCalls[0].slice(-2), ["node", "/work/ads-mcp-for-snapchat/src/index.js"]);
  // The secret and the refresh token are never printed.
  const out = printed.join("\n");
  assert.ok(!out.includes(SECRET) && !out.includes("refresh-123"));
});

test("setup: a wrong paste or an expired code is explained and retried, and nothing secret is printed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-"));
  const file = join(dir, ".env");
  const { fetchImpl } = fakeSnap({ refuseCode: 1 });
  const { io, printed } = scriptedIO(["not-an-id", CLIENT_ID, "short", SECRET, "https://127.0.0.1/callback?state=x", landing(), landing(), "1", "", "", "n", "s"]);
  const r = await runSetup({ io, file, fetchImpl, open: browser, exec: () => {}, claudeAvailable: () => false, root: "/x/node_modules/ads-mcp-for-snapchat" });
  const out = printed.join("\n");
  assert.match(out, /That is not a Client ID/);
  assert.match(out, /does not look like a secret/);
  assert.match(out, /has no code in it/);
  assert.match(out, /Snap did not accept the code/);
  assert.equal(r.account.id, ACC_A);
  assert.equal(r.registered, false);
  assert.match(out, /claude mcp add --scope user s -e SNAP_ENV_FILE=.* -- npx -y ads-mcp-for-snapchat/, "without the claude command it prints the exact command, name before -e");
  assert.ok(readFileSync(file, "utf8").includes("SNAP_READ_ONLY=0"), "answering n turns read-only off");
});

test("setup: switching an existing file to another account clears that account's pixel and brand profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-"));
  const file = join(dir, ".env.account2");
  writeFileSync(file, `SNAP_CLIENT_ID=${CLIENT_ID}\nSNAP_CLIENT_SECRET=${SECRET}\nSNAP_AD_ACCOUNT_ID=${ACC_A}\nSNAP_PIXEL_ID=pixel-of-a\nSNAP_BRAND_PROFILE_ID=profile-of-a\n`);
  const { fetchImpl } = fakeSnap();
  // Enter keeps the saved Client ID and secret.
  const { io } = scriptedIO(["", "", landing(), "2", "", "", "", ""]);
  await runSetup({ io, file, fetchImpl, open: browser, exec: () => {}, claudeAvailable: () => false, root: "/work/ads-mcp-for-snapchat" });
  const lines = readFileSync(file, "utf8").split("\n");
  assert.ok(lines.includes(`SNAP_AD_ACCOUNT_ID=${ACC_B}`));
  assert.ok(lines.includes("SNAP_PIXEL_ID=") && lines.includes("SNAP_BRAND_PROFILE_ID="));
  assert.ok(lines.includes(`SNAP_CLIENT_SECRET=${SECRET}`));
});

test("oauth helpers: link, reading the code back, and the account list", async () => {
  assert.throws(() => authorizeUrl({ clientId: "nope", state: "s" }), /Client ID/);
  const url = authorizeUrl({ clientId: CLIENT_ID, state: "st" });
  assert.match(url, /^https:\/\/accounts\.snapchat\.com\/login\/oauth2\/authorize\?/);
  assert.equal(extractCode("https://127.0.0.1/callback?code=abc123XYZ_-&state=st", "st"), "abc123XYZ_-");
  assert.equal(extractCode("abcdefghij12", "st"), "abcdefghij12");
  assert.throws(() => extractCode("https://127.0.0.1/callback?code=abc&state=other", "st"), /different authorization attempt/);
  assert.throws(() => extractCode("https://127.0.0.1/callback?error=access_denied", "st"), /refused/);
  assert.throws(() => extractCode("", "st"), /Nothing was pasted/);
  const rows = await listAdAccounts({ request: async () => ({ organizations: [{ organization: { name: "O", ad_accounts: [{ id: "1", name: "Z" }, { id: "2", name: "A" }] } }] }) });
  assert.deepEqual(rows.map((r) => r.name), ["A", "Z"]);
  assert.deepEqual(launchCommand("/home/u/.npm/_npx/1/node_modules/ads-mcp-for-snapchat"), { command: "npx", args: ["-y", "ads-mcp-for-snapchat"] });
});

test("snap_connect: link, pasted address, account choice; the token is saved but never shown, and the account needs a restart", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { SnapClient } = await import("../src/snap.js");
  const { registerTools } = await import("../src/tools.js");
  const dir = mkdtempSync(join(tmpdir(), "connect-"));
  const file = join(dir, ".env");
  const savedFile = process.env.SNAP_ENV_FILE;
  process.env.SNAP_ENV_FILE = file;
  try {
    const { fetchImpl } = fakeSnap();
    const env = { SNAP_CLIENT_ID: CLIENT_ID, SNAP_CLIENT_SECRET: SECRET, SNAP_READ_ONLY: "1" };
    const server = new McpServer({ name: "t", version: "1" });
    registerTools(server, new SnapClient({ env, fetchImpl }), { ...env, SNAP_LOG_FILE: join(dir, "log.jsonl") });
    const client = new Client({ name: "c", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (args = {}) => {
      const r = await client.callTool({ name: "snap_connect", arguments: args });
      return { error: r.isError, text: r.content[0].text, data: r.isError ? null : JSON.parse(r.content[0].text) };
    };

    const early = await call({ redirected_url: "https://127.0.0.1/callback?code=GOODCODE&state=x" });
    assert.ok(early.error && /Start with snap_connect/.test(early.text), "a pasted address without a link from this server is refused");
    const s1 = await call();
    const state = new URL(s1.data.link).searchParams.get("state");
    assert.equal(new URL(s1.data.link).searchParams.get("client_id"), CLIENT_ID);
    const wrong = await call({ redirected_url: "https://127.0.0.1/callback?code=GOODCODE&state=other" });
    assert.ok(wrong.error && /different authorization attempt/.test(wrong.text));
    const s2 = await call({ redirected_url: `https://127.0.0.1/callback?code=GOODCODE&state=${state}` });
    assert.equal(s2.data.connected, true, "works in read-only mode: it changes no ads");
    assert.deepEqual(s2.data.ad_accounts.map((x) => x.name), ["Shop A", "Shop B"]);
    assert.ok(!s2.text.includes("refresh-123"), "the refresh token is never returned to the chat");
    assert.ok(readFileSync(file, "utf8").includes("SNAP_REFRESH_TOKEN=refresh-123"));
    const bad = await call({ ad_account_id: "cccccccc-0000-0000-0000-000000000003" });
    assert.ok(bad.error && /not one this login can see/.test(bad.text));
    const s3 = await call({ ad_account_id: ACC_B });
    assert.match(s3.data.next, /reopen/);
    const lines = readFileSync(file, "utf8").split("\n");
    assert.ok(lines.includes(`SNAP_AD_ACCOUNT_ID=${ACC_B}`) && lines.includes("SNAP_ACCOUNT_CURRENCY=SAR"));
    await client.close();
  } finally {
    if (savedFile === undefined) delete process.env.SNAP_ENV_FILE;
    else process.env.SNAP_ENV_FILE = savedFile;
  }
});

test("snap_connect without a Client ID and secret explains where to enter them", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { SnapClient } = await import("../src/snap.js");
  const { registerTools } = await import("../src/tools.js");
  const server = new McpServer({ name: "t", version: "1" });
  registerTools(server, new SnapClient({ env: { SNAP_BROKER_URL: "off" }, fetchImpl: async () => ({}) }), { SNAP_LOG_FILE: join(mkdtempSync(join(tmpdir(), "c-")), "l.jsonl") });
  const client = new Client({ name: "c", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = await client.callTool({ name: "snap_connect", arguments: {} });
  assert.ok(r.isError && /extension's settings/.test(r.content[0].text));
  await client.close();
});
