import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SnapClient } from "../src/snap.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools } from "../src/tools.js";

const env = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r", SNAP_AD_ACCOUNT_ID: "acc1" };

async function setup({ status = "PAUSED", spend = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (u.hostname.includes("accounts")) return json({ access_token: "t", expires_in: 1800 });
    const path = u.pathname.replace(/^\/v1/, "");
    calls.push({ m: opts.method ?? "GET", path });
    if (opts.method === "DELETE") return json({ request_status: "SUCCESS" });
    if (path.endsWith("/stats")) return json({ total_stats: [{ total_stat: { stats: { spend: spend * 1e6 } } }] });
    if (path === "/adsquads/s1") return json({ adsquads: [{ sub_request_status: "SUCCESS", adsquad: { id: "s1", name: "Squad One", status, campaign_id: "c1" } }] });
    if (path === "/adsquads/s1/ads") return json({ ads: [] });
    if (path === "/campaigns/c1") return json({ campaigns: [{ sub_request_status: "SUCCESS", campaign: { id: "c1", name: "Camp", status: "ACTIVE", ad_account_id: "acc1" } }] });
    return json({}, 404);
  };
  const server = new McpServer({ name: "t", version: "1" });
  registerTools(server, new SnapClient({ env, fetchImpl }), { ...env, SNAP_LOG_FILE: join(mkdtempSync(join(tmpdir(), "del-")), "log.jsonl") });
  const client = new Client({ name: "c", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (args) => client.callTool({ name: "snap_delete", arguments: { entity: "adsquad", id: "s1", ...args } });
  const deletes = () => calls.filter((c) => c.m === "DELETE").length;
  // Preview first (no name needed), then confirm with the token; confirm_name is typed after reading the preview.
  const apply = async (confirmArgs = {}) => {
    const preview = await call({});
    const token = preview.isError ? undefined : JSON.parse(preview.content[0].text).approval_token;
    return call({ ...confirmArgs, confirm: true, approval_token: token });
  };
  return { call, apply, deletes, close: () => client.close() };
}
const text = (r) => r.content[0].text;

test("snap_delete previews by default and never sends DELETE", async () => {
  const t = await setup();
  const r = await t.call({ confirm_name: "Squad One" });
  assert.ok(!r.isError);
  assert.match(text(r), /"dry_run": ?true/);
  assert.equal(t.deletes(), 0);
  await t.close();
});

test("snap_delete refuses an ACTIVE item even with confirm and the right name", async () => {
  const t = await setup({ status: "ACTIVE" });
  // a blocked delete gets no approval token at all, so it can never be confirmed
  const preview = await t.call({ confirm_name: "Squad One" });
  assert.match(text(preview), /it is ACTIVE; pause it first/);
  assert.ok(!text(preview).includes("approval_token"));
  const r = await t.apply({ confirm_name: "Squad One" });
  assert.equal(r.isError, true);
  assert.match(text(r), /approval_token/);
  assert.equal(t.deletes(), 0);
  await t.close();
});

test("snap_delete refuses an item that spent in the last 30 days", async () => {
  const t = await setup({ spend: 12.5 });
  const preview = await t.call({ confirm_name: "Squad One" });
  assert.match(text(preview), /it spent \$12.5 in the last 30 days/);
  assert.ok(!text(preview).includes("approval_token"));
  const r = await t.apply({ confirm_name: "Squad One" });
  assert.equal(r.isError, true);
  assert.match(text(r), /approval_token/);
  assert.equal(t.deletes(), 0);
  await t.close();
});

test("snap_delete refuses a missing or wrong name even when everything else is clean", async () => {
  const t = await setup();
  for (const args of [{}, { confirm_name: "squad one" }]) {
    const r = await t.apply(args);
    assert.equal(r.isError, true);
    assert.match(text(r), /exactly the name/);
  }
  assert.equal(t.deletes(), 0);
  await t.close();
});

test("snap_delete with the approval token and the exact name deletes once; the token cannot be reused", async () => {
  const t = await setup();
  const preview = await t.call({});
  const token = JSON.parse(text(preview)).approval_token;
  const ok = await t.call({ confirm: true, approval_token: token, confirm_name: "Squad One" });
  assert.ok(!ok.isError, text(ok));
  assert.equal(t.deletes(), 1);
  const again = await t.call({ confirm: true, approval_token: token, confirm_name: "Squad One" });
  assert.equal(again.isError, true);
  assert.match(text(again), /already used/);
  assert.equal(t.deletes(), 1);
  await t.close();
});

test("snap_delete with confirm=true and no approval token never sends DELETE", async () => {
  const t = await setup();
  const r = await t.call({ confirm: true, confirm_name: "Squad One" });
  assert.equal(r.isError, true);
  assert.match(text(r), /approval_token/);
  assert.equal(t.deletes(), 0);
  await t.close();
});
