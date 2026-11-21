import test from "node:test";
import assert from "node:assert/strict";
import { setup, sampleWorld } from "./helpers/harness.js";

const manySquads = () => {
  const w = sampleWorld();
  for (let i = 0; i < 25; i++) w.adsquads[`p${i}`] = { id: `p${i}`, name: `Paged ${String(i).padStart(2, "0")}`, status: "PAUSED", campaign_id: "c1", daily_budget_micro: 10e6, bid_micro: 2e6, targeting: {}, updated_at: "t0" };
  return w;
};

test("a list can be read page by page: has_more and next_offset say when to continue", async () => {
  const t = await setup({ world: manySquads() });
  const first = await t.raw("snap_list_adsquads", { campaign_id: "c1", limit: 10, name_contains: "Paged" });
  const f = first.structuredContent;
  assert.equal(f.returned, 10);
  assert.equal(f.total_matching, 25);
  assert.equal(f.has_more, true);
  assert.equal(f.next_offset, 10);
  const second = (await t.raw("snap_list_adsquads", { campaign_id: "c1", limit: 10, offset: 10, name_contains: "Paged" })).structuredContent;
  assert.equal(second.items[0].name, "Paged 10");
  const last = (await t.raw("snap_list_adsquads", { campaign_id: "c1", limit: 10, offset: 20, name_contains: "Paged" })).structuredContent;
  assert.equal(last.returned, 5);
  assert.equal(last.has_more, false);
  assert.equal(last.next_offset, null);
});

test("response_format concise returns only id, name and status; detailed is the default", async () => {
  const t = await setup({ world: manySquads() });
  const concise = (await t.raw("snap_list_adsquads", { campaign_id: "c1", limit: 3, name_contains: "Paged", response_format: "concise" })).structuredContent.items[0];
  assert.deepEqual(Object.keys(concise).sort(), ["id", "name", "status"]);
  const detailed = (await t.raw("snap_list_adsquads", { campaign_id: "c1", limit: 3, name_contains: "Paged" })).structuredContent.items[0];
  assert.ok("daily_budget" in detailed);
});

test("every list tool accepts limit, offset and response_format", async () => {
  const t = await setup();
  const { tools } = await t.client.listTools();
  for (const tool of tools.filter((x) => x.name.startsWith("snap_list_"))) {
    const props = Object.keys(tool.inputSchema.properties);
    for (const k of ["limit", "offset", "response_format"]) assert.ok(props.includes(k), `${tool.name} has ${k}`);
  }
});

test("object results also come back as structured data, next to the text", async () => {
  const t = await setup();
  const r = await t.raw("snap_ping", {});
  assert.ok(r.structuredContent && typeof r.structuredContent === "object");
  assert.equal(r.content[0].type, "text");
});
