import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools } from "../src/tools.js";

const baseEnv = { SNAP_AD_ACCOUNT_ID: "acc1", SNAP_BRAND_PROFILE_ID: "prof1" };
const ARGS = { media_id: "m1", name: "Test creative", headline: "Short headline", url: "https://example.com/" };

async function setup(mediaStatus = "READY") {
  const logFile = join(mkdtempSync(join(tmpdir(), "cc-")), "log.jsonl");
  const calls = { created: [] };
  const fake = {
    request: async (method, path) => {
      assert.equal(method, "GET");
      assert.equal(path, "/media/m1");
      return { media: [{ media: { id: "m1", media_status: mediaStatus } }] };
    },
    createEntity: async (entity, obj) => {
      calls.created.push({ entity, obj });
      return { id: "cr1", name: obj.name };
    },
  };
  const server = new McpServer({ name: "t", version: "1" });
  registerTools(server, fake, { ...baseEnv, SNAP_LOG_FILE: logFile });
  const client = new Client({ name: "c", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (args) => client.callTool({ name: "snap_create_creative", arguments: args });
  // Applying needs the approval_token of a preview of the same request.
  const apply = async (args) => {
    const preview = await call(args);
    if (preview.isError) return preview;
    return call({ ...args, confirm: true, approval_token: JSON.parse(preview.content[0].text).approval_token });
  };
  return { calls, call, apply, close: () => client.close() };
}
const text = (r) => r.content[0].text;

test("snap_create_creative previews by default and sends nothing", async () => {
  const t = await setup();
  const r = await t.call(ARGS);
  assert.ok(!r.isError);
  assert.match(text(r), /"dry_run": ?true/);
  assert.equal(t.calls.created.length, 0);
  await t.close();
});

test("snap_create_creative with confirm creates one WEB_VIEW creative", async () => {
  const t = await setup();
  const r = await t.apply(ARGS);
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /cr1/);
  assert.equal(t.calls.created.length, 1);
  const { entity, obj } = t.calls.created[0];
  assert.equal(entity, "creative");
  assert.equal(obj.type, "WEB_VIEW");
  assert.equal(obj.ad_account_id, "acc1");
  assert.equal(obj.top_snap_media_id, "m1");
  assert.equal(obj.profile_properties.profile_id, "prof1");
  await t.close();
});

test("snap_create_creative refuses media that is not READY, even with confirm", async () => {
  const t = await setup("PENDING_UPLOAD");
  const r = await t.apply(ARGS);
  assert.equal(r.isError, true);
  assert.match(text(r), /not READY/);
  assert.equal(t.calls.created.length, 0);
  await t.close();
});

test("snap_create_creative rejects a long headline, a non-https url and an unknown CTA", async () => {
  const t = await setup();
  for (const [bad, re] of [[{ headline: "x".repeat(35) }, /34/], [{ url: "http://x.com" }, /https/], [{ call_to_action: "NOPE" }, /call_to_action/]]) {
    const r = await t.apply({ ...ARGS, ...bad });
    assert.equal(r.isError, true);
    assert.match(text(r), re);
  }
  assert.equal(t.calls.created.length, 0);
  await t.close();
});

test("snap_create_creative with confirm=true but no approval_token creates nothing", async () => {
  const t = await setup();
  const r = await t.call({ ...ARGS, confirm: true });
  assert.equal(r.isError, true);
  assert.match(text(r), /approval_token/);
  assert.equal(t.calls.created.length, 0);
  await t.close();
});
