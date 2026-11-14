#!/usr/bin/env node
// Builds the Claude Desktop extension (dist/ads-mcp-for-snapchat-<version>.mcpb): the published package files, production
// dependencies only, and manifest.json. Double-clicking the file installs it in Claude Desktop.
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../src/env.js";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error(`manifest.json is ${manifest.version} but package.json is ${pkg.version}`);
const stage = join(ROOT, "dist", "mcpb");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of [...pkg.files, "package.json", "package-lock.json", "manifest.json"]) cpSync(join(ROOT, f), join(stage, f), { recursive: true });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit" });
const out = join(ROOT, "dist", `ads-mcp-for-snapchat-${pkg.version}.mcpb`);
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["-y", "@anthropic-ai/mcpb@2.1.2", "pack", stage, out], { stdio: "inherit" });
console.log(`Built ${out}`);
