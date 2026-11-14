#!/usr/bin/env node
// Command-line entry for the npm package: `npx ads-mcp-for-snapchat <command>`. With no command it starts the MCP server,
// which is what an MCP client runs. The other commands are the one-time setup helpers from scripts/.
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { envFile, ROOT } from "./env.js";

const SCRIPTS = {
  "save-secret": "save-secret.js",
  auth: "get-refresh-token.js",
  check: "check.js",
  "weekly-report": "weekly-report.js",
};

export const HELP = `Ads MCP for Snapchat

Usage: npx ads-mcp-for-snapchat [command]

  (no command)     start the MCP server (this is what Claude runs)
  init             create the settings file from the template
  where            print the settings file in use
  save-secret      save the client secret from the clipboard (--stdin to paste it instead)
  auth CODE        exchange the authorization code for a refresh token
  check            test the connection and the ad account (read-only)
  weekly-report    write the weekly report to the exports folder
  help             show this text

Settings file: SNAP_ENV_FILE if set, otherwise .env in ~/.ads-mcp-for-snapchat (npm install) or the project folder (git clone).`;

// Creates the settings file from .env.example, private to the user. Never overwrites an existing file.
export function init(file = envFile()) {
  if (existsSync(file)) return { created: false, file };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  copyFileSync(join(ROOT, ".env.example"), file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // not fatal (e.g. Windows)
  }
  return { created: true, file };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "serve") return import("./index.js");
  if (command === "help" || command === "--help" || command === "-h") return console.log(HELP);
  if (command === "where") return console.log(envFile());
  if (command === "init") {
    const r = init();
    console.log(r.created ? `Created ${r.file}. Fill in SNAP_CLIENT_ID and SNAP_AD_ACCOUNT_ID, then run save-secret.` : `${r.file} already exists; nothing changed.`);
    return;
  }
  const script = SCRIPTS[command];
  if (!script) {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  // The scripts read their own arguments from process.argv, as if run with `node scripts/<file> ...`.
  const path = join(ROOT, "scripts", script);
  process.argv = [process.argv[0], path, ...rest];
  return import(pathToFileURL(path).href);
}

const isEntry = () => {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
};
if (process.argv[1] && isEntry()) await main();
