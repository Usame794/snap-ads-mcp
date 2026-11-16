#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv } from "./env.js";
import { loadPolicy } from "./policy.js";
import { SnapClient } from "./snap.js";
import { registerTools } from "./tools.js";

// A Claude Desktop extension passes optional settings the person left empty as unreplaced "${user_config.x}" text on some
// versions. Treat those as unset, so an empty optional setting can never stop the server or become a real value.
for (const [k, v] of Object.entries(process.env)) if (k.startsWith("SNAP_") && /^\$\{user_config\.[a-z_]+\}$/.test(v ?? "")) delete process.env[k];
loadEnv();
let policy;
try {
  // Safety settings are validated before anything else. An invalid value stops the server instead of disabling a limit.
  policy = loadPolicy(process.env);
} catch (e) {
  process.stderr.write(`[ads-mcp-for-snapchat] ${e.message}\n`);
  process.exit(1);
}
// Snapshot of the non-secret settings taken at startup. Later edits to .env do not change limits or the target account.
const settings = { ...process.env };
const server = new McpServer({ name: "ads-mcp-for-snapchat", version: "0.9.4" });
// Only the OAuth credentials are re-read from .env when a token is needed, so replacing them does not require a restart.
const client = new SnapClient({ beforeToken: () => loadEnv(undefined, { override: true }), timeoutMs: policy.httpTimeoutMs });
registerTools(server, client, settings);
await server.connect(new StdioServerTransport());
