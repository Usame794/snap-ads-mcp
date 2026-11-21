import test from "node:test";
import assert from "node:assert/strict";
import { setup, sampleWorld } from "./helpers/harness.js";
import { loadPolicy } from "../src/policy.js";

test("a plain date is accepted where Snap needs a time on the hour", async () => {
  const t = await setup({ env: { SNAP_REPORT_UTC_OFFSET: "+03:00" } });
  const r = await t.raw("snap_get_stats", { entity: "campaign", id: "c1", start_time: "2026-10-19", end_time: "2026-10-20" });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const call = t.calls.filter((c) => c.path === "/campaigns/c1/stats").at(-1);
  assert.equal(call.query.start_time, "2026-10-19T00:00:00+03:00");
  assert.equal(call.query.end_time, "2026-10-20T00:00:00+03:00");
});

test("a full ISO date-time is passed through unchanged", async () => {
  const t = await setup();
  await t.raw("snap_get_stats", { entity: "campaign", id: "c1", start_time: "2026-10-19T05:00:00+00:00", end_time: "2026-10-20T05:00:00+00:00" });
  const call = t.calls.filter((c) => c.path === "/campaigns/c1/stats").at(-1);
  assert.equal(call.query.start_time, "2026-10-19T05:00:00+00:00");
});

test("an answer longer than SNAP_MAX_RESPONSE_CHARS is cut with a note on how to ask for less", async () => {
  assert.equal(loadPolicy({}).maxResponseChars, 100000);
  assert.throws(() => loadPolicy({ SNAP_MAX_RESPONSE_CHARS: "10" }), /SNAP_MAX_RESPONSE_CHARS/);
  const world = sampleWorld();
  for (let i = 0; i < 80; i++) world.adsquads[`z${i}`] = { id: `z${i}`, name: `Long squad name number ${i}`, status: "PAUSED", campaign_id: "c1", daily_budget_micro: 10e6, bid_micro: 2e6, targeting: {}, updated_at: "t0" };
  const t = await setup({ world, env: { SNAP_MAX_RESPONSE_CHARS: "5000" } });
  const cut = await t.raw("snap_list_adsquads", { campaign_id: "c1", limit: 200 });
  assert.match(cut.content[0].text, /the answer was cut at 5000 characters/);
  assert.match(cut.content[0].text, /fewer rows/);
  assert.equal(cut.structuredContent.items.length, 0, "a cut answer carries no rows as data");
  assert.equal(cut.structuredContent.has_more, true);
  const small = await t.raw("snap_list_adsquads", { campaign_id: "c1", limit: 5 });
  assert.ok(!/was cut at/.test(small.content[0].text), "a short answer is not cut");
});

test("list tools declare an output schema and still answer", async () => {
  const t = await setup();
  const { tools } = await t.client.listTools();
  const lists = tools.filter((x) => x.name.startsWith("snap_list_"));
  assert.ok(lists.length >= 9);
  for (const tool of lists) assert.ok(tool.outputSchema?.properties?.items, `${tool.name} has an outputSchema`);
  const r = await t.raw("snap_list_campaigns", {});
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.equal(r.structuredContent.items.length, 2);
});
