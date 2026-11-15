// Tool groups: every tool belongs to exactly one group, SNAP_TOOLSETS hides the rest, a typo stops the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLSETS, parseToolsets, toolAllowed, toolsetOf } from "../src/toolsets.js";
import { loadPolicy } from "../src/policy.js";
import { setup } from "./helpers/harness.js";

test("parsing: unset and 'all' mean everything; names are trimmed, lower-cased and unique; a typo is an error", () => {
  assert.equal(parseToolsets(undefined), null);
  assert.equal(parseToolsets(""), null);
  assert.equal(parseToolsets(" ALL "), null);
  assert.deepEqual(parseToolsets(" Reports, checks ,reports"), ["reports", "checks"]);
  assert.throws(() => parseToolsets("reports,reprots"), /unknown group reprots/);
  assert.throws(() => loadPolicy({ SNAP_TOOLSETS: "nope" }), /Unsafe configuration[\s\S]*unknown group nope/);
  assert.equal(loadPolicy({}).toolsets, null);
  assert.deepEqual(loadPolicy({ SNAP_TOOLSETS: "setup,reports" }).toolsets, ["setup", "reports"]);
});

test("every registered tool is in exactly one group, and every listed tool exists", async () => {
  const t = await setup();
  const names = (await t.client.listTools()).tools.map((x) => x.name);
  const listed = Object.values(TOOLSETS).flat();
  assert.equal(new Set(listed).size, listed.length, "no tool is in two groups");
  assert.deepEqual(names.filter((n) => !toolsetOf(n)), [], "a new tool must be added to a group in toolsets.js");
  assert.deepEqual(listed.filter((n) => !names.includes(n)), [], "no group lists a tool that does not exist");
  await t.close();
});

test("SNAP_TOOLSETS shows only the chosen groups; everything else is unaffected", async () => {
  const t = await setup({ env: { SNAP_TOOLSETS: "setup,reports" } });
  const names = (await t.client.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(names, [...TOOLSETS.setup, ...TOOLSETS.reports].sort());
  assert.ok(!names.includes("snap_set_status") && !names.includes("snap_create_campaign"), "change and create tools are hidden");
  const ping = await t.call("snap_ping", {});
  assert.deepEqual(ping.data.safety_limits.toolsets, ["setup", "reports"]);
  assert.ok((await t.client.listPrompts()).prompts.length >= 3, "playbooks are still offered");
  await t.close();
  assert.equal(toolAllowed(null, "snap_unknown_future_tool"), true);
  assert.equal(toolAllowed(["reports"], "snap_unknown_future_tool"), false);
});
