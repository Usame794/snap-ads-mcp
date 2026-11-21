// An upgraded Claude Desktop install has no saved value for a setting that was added later. If that setting is required, Desktop
// does not start the extension at all ("No MCP config found"). These tests keep new settings optional and make the server
// work when they are missing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT } from "../src/env.js";
import { CORE_TOOLS } from "../src/toolsets.js";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

test("only the settings that existed before the first upgrade-sensitive release are required; every newer one is optional", () => {
  const required = Object.entries(manifest.user_config).filter(([, v]) => v.required).map(([k]) => k).sort();
  assert.deepEqual(required, ["max_daily_budget", "read_only"], "a new required setting stops the extension from starting on upgraded installs");
});

async function toolCount(extra) {
  const transport = new StdioClientTransport({ command: "node", args: ["src/index.js"], cwd: ROOT, env: { PATH: process.env.PATH, SNAP_ENV_FILE: "/nonexistent/snap-test.env", ...extra } });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.length;
}

test("the extension's environment starts the server in every state of the Tool set setting", async () => {
  const env = manifest.server.mcp_config.env;
  assert.equal(env.SNAP_TOOLSETS_DEFAULT, "core");
  const base = { SNAP_MAX_DAILY_BUDGET: "500", SNAP_READ_ONLY: "false", SNAP_TOOLSETS_DEFAULT: "core" };
  assert.equal(await toolCount({ ...base, SNAP_TOOLSETS: "${user_config.toolsets}" }), CORE_TOOLS.length, "never saved (placeholder left in place): core");
  assert.equal(await toolCount({ ...base, SNAP_TOOLSETS: "" }), CORE_TOOLS.length, "empty: core");
  assert.equal(await toolCount({ ...base }), CORE_TOOLS.length, "missing: core");
  assert.equal(await toolCount({ ...base, SNAP_TOOLSETS: "core" }), CORE_TOOLS.length);
  assert.equal(await toolCount({ ...base, SNAP_TOOLSETS: "all" }), 80, "a real value wins over the default");
  assert.equal(await toolCount({ ...base, SNAP_TOOLSETS: "core,reports" }) > CORE_TOOLS.length, true);
});
