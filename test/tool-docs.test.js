import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers/harness.js";
import { TOOL_HINTS, PARAM_DOCS } from "../src/tool-docs.js";

test("every parameter of every tool has a description", async () => {
  const t = await setup();
  const { tools } = await t.client.listTools();
  const missing = [];
  for (const tool of tools) for (const [k, v] of Object.entries(tool.inputSchema.properties ?? {})) if (!v.description) missing.push(`${tool.name}.${k}`);
  assert.deepEqual(missing, [], `parameters without a description: ${missing.join(", ")}`);
});

test("tools with a usage hint show it in their description, and every hint names a tool that exists", async () => {
  const t = await setup();
  const { tools } = await t.client.listTools();
  const names = new Set(tools.map((x) => x.name));
  for (const [name, hint] of Object.entries(TOOL_HINTS)) {
    assert.ok(names.has(name), `${name} exists`);
    assert.ok(tools.find((x) => x.name === name).description.includes(hint), `${name} shows its hint`);
    for (const ref of hint.match(/snap_[a-z_]+/g) ?? []) assert.ok(names.has(ref), `${name}: hint points to ${ref}, which must exist`);
  }
});

test("descriptions that point to another tool name a tool that exists", async () => {
  const t = await setup();
  const { tools } = await t.client.listTools();
  const names = new Set(tools.map((x) => x.name));
  const bad = [];
  for (const tool of tools) for (const ref of tool.description.match(/\bsnap_[a-z_]+/g) ?? []) if (!names.has(ref)) bad.push(`${tool.name} -> ${ref}`);
  for (const [k, d] of Object.entries(PARAM_DOCS)) for (const ref of d.match(/\bsnap_[a-z_]+/g) ?? []) if (!names.has(ref)) bad.push(`param ${k} -> ${ref}`);
  assert.deepEqual(bad, []);
});
