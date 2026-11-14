#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv } from "./env.js";
import { loadPolicy } from "./policy.js";
import { SnapClient } from "./snap.js";
import { registerTools } from "./tools.js";

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
const server = new McpServer({ name: "ads-mcp-for-snapchat", version: "0.4.0" });
// Only the OAuth credentials are re-read from .env when a token is needed, so replacing them does not require a restart.
const client = new SnapClient({ beforeToken: () => loadEnv(undefined, { override: true }), timeoutMs: policy.httpTimeoutMs });
registerTools(server, client, settings);
await server.connect(new StdioServerTransport());
