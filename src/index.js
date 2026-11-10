#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv } from "./env.js";
import { SnapClient } from "./snap.js";
import { registerTools } from "./tools.js";

loadEnv();
const server = new McpServer({ name: "snap-ads-mcp", version: "0.1.0" });
// Re-read .env whenever a token is needed, so editing it does not require a restart.
registerTools(server, new SnapClient({ beforeToken: () => loadEnv(undefined, { override: true }) }));
await server.connect(new StdioServerTransport());
