import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers/harness.js";

const OLD = ["snap_set_status_bulk", "snap_bulk_rename", "snap_bulk_set_schedule", "snap_bulk_exclude_segments", "snap_bulk_set_budget", "snap_report_daily", "snap_report_hourly", "snap_report_compare", "snap_report_audience"];

test("old tool names are hidden by default and the merged tools take their place", async () => {
  const t = await setup();
  const names = (await t.client.listTools()).tools.map((x) => x.name);
  assert.equal(names.length, 76);
  for (const old of OLD) assert.ok(!names.includes(old), `${old} is hidden`);
  for (const merged of ["snap_set_status", "snap_rename", "snap_set_schedule", "snap_exclude_segments", "snap_set_daily_budget", "snap_report"]) assert.ok(names.includes(merged), merged);
});

test("SNAP_LEGACY_TOOLS=1 shows the old names as deprecated aliases that point to the new tool", async () => {
  const t = await setup({ env: { SNAP_LEGACY_TOOLS: "1" } });
  const tools = (await t.client.listTools()).tools;
  assert.equal(tools.length, 85);
  for (const old of OLD) assert.match(tools.find((x) => x.name === old).description, /^DEPRECATED, use snap_/, old);
});

test("a merged tool accepts one id or many ids, and says so", async () => {
  const t = await setup();
  const tool = (await t.client.listTools()).tools.find((x) => x.name === "snap_set_status");
  assert.ok(tool.inputSchema.properties.id && tool.inputSchema.properties.ids);
  assert.ok(!tool.inputSchema.required?.includes("id"), "id is optional: ids can be used instead");
  assert.match(tool.description, /several items at once pass ids/);
  const one = await t.call("snap_set_status", { entity: "adsquad", id: "s1", status: "PAUSED" });
  assert.equal(one.data.approval_token !== undefined, true, JSON.stringify(one).slice(0, 200));
  const many = await t.call("snap_set_status", { entity: "adsquad", ids: ["s1", "s3"], status: "PAUSED" });
  assert.ok(many.data.approval_token, JSON.stringify(many).slice(0, 200));
});

test("a wrong mix of arguments gets a clear message, and nothing is sent", async () => {
  const t = await setup();
  const both = await t.call("snap_set_status", { entity: "adsquad", id: "s1", ids: ["s3"], status: "PAUSED" });
  assert.match(both.error, /id does not apply when using ids/);
  const none = await t.call("snap_set_status", { entity: "adsquad", status: "PAUSED" });
  assert.match(none.error, /id/);
  const budgetMix = await t.call("snap_set_daily_budget", { entity: "adsquad", adsquad_ids: ["s1"], mode: "set", value: 12 });
  assert.match(budgetMix.error, /entity does not apply when using adsquad_ids/);
  assert.equal(t.writes().length, 0);
});

test("a preview from the merged tool can be confirmed with the same arguments, and the guards are unchanged", async () => {
  const t = await setup();
  const { preview, applied } = await t.twoStep("snap_set_daily_budget", { adsquad_ids: ["s1"], mode: "set", value: 12 });
  assert.ok(preview.data.approval_token);
  assert.equal(applied.data.applied, true, JSON.stringify(applied).slice(0, 300));
  const tooBig = await t.call("snap_set_daily_budget", { adsquad_ids: ["s1"], mode: "set", value: 5000 });
  assert.match(JSON.stringify(tooBig), /SNAP_MAX_DAILY_BUDGET|above|limit/i);
});

test("with the legacy names on, a preview from the merged tool is accepted by the old alias too (same binding)", async () => {
  const t = await setup({ env: { SNAP_LEGACY_TOOLS: "1" } });
  const args = { entity: "adsquad", ids: ["s1"], status: "PAUSED" };
  const preview = await t.call("snap_set_status", args);
  const applied = await t.call("snap_set_status_bulk", { ...args, confirm: true, approval_token: preview.data.approval_token });
  assert.equal(applied.data?.applied, true, JSON.stringify(applied).slice(0, 300));
});

test("snap_report chooses the report with view, and a bad view or missing field is explained", async () => {
  const t = await setup();
  const tool = (await t.client.listTools()).tools.find((x) => x.name === "snap_report");
  assert.deepEqual(tool.inputSchema.properties.view.enum, ["table", "daily", "hourly", "compare", "audience"]);
  assert.equal(tool.inputSchema.properties.view.default, "table");
  const missing = await t.call("snap_report", { view: "daily", entity: "campaign", id: "c1" });
  assert.match(missing.error, /start_time/);
  const wrong = await t.call("snap_report", { view: "hourly", breakdown: "ad" });
  assert.match(wrong.error, /breakdown does not apply when using view=hourly/);
  const hourly = await t.call("snap_report", { view: "hourly", days: 7 });
  assert.ok(!hourly.error || !/does not apply|Required/.test(hourly.error), hourly.error);
});

test("SNAP_TOOLSETS still hides merged tools by group, and legacy aliases follow the group of their replacement", async () => {
  const t = await setup({ env: { SNAP_TOOLSETS: "reports", SNAP_LEGACY_TOOLS: "1" } });
  const names = (await t.client.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes("snap_report") && names.includes("snap_report_daily"));
  assert.ok(!names.includes("snap_set_status") && !names.includes("snap_set_status_bulk"));
});
