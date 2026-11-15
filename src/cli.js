#!/usr/bin/env node
// Command-line entry for the npm package: `npx ads-mcp-for-snapchat <command>`. With no command it starts the MCP server,
// which is what an MCP client runs. The other commands are the one-time setup helpers from scripts/.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { envFile, ROOT } from "./env.js";
import { init } from "./init.js";

const SCRIPTS = {
  "save-secret": "save-secret.js",
  auth: "get-refresh-token.js",
  check: "check.js",
  "weekly-report": "weekly-report.js",
};

export const HELP = `Ads MCP for Snapchat

Usage: npx ads-mcp-for-snapchat [command]

  (no command)     start the MCP server (this is what Claude runs)
  setup            guided setup: connect your account and add it to Claude (--file PATH for another account)
  init             create the settings file from the template
  where            print the settings file in use
  save-secret      save the client secret from the clipboard (--stdin to paste it instead)
  auth CODE        exchange the authorization code for a refresh token
  check            test the connection and the ad account (read-only)
  weekly-report    write the weekly report to the exports folder
  verify           run every read-only tool on your account and show what works (changes nothing); add --details for the specifics behind each problem
  help             show this text

Settings file: SNAP_ENV_FILE if set, otherwise .env in ~/.ads-mcp-for-snapchat (npm install) or the project folder (git clone).`;

export { init } from "./init.js";

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "serve") return import("./index.js");
  if (command === "help" || command === "--help" || command === "-h") return console.log(HELP);
  if (command === "where") return console.log(envFile());
  if (command === "verify") {
    const { loadEnv } = await import("./env.js");
    const { SnapClient } = await import("./snap.js");
    const { runVerify } = await import("./verify.js");
    loadEnv();
    console.log("Checking every read-only tool on your ad account (nothing is changed)...\n");
    const { failed } = await runVerify({ client: new SnapClient(), details: rest.includes("--details") });
    process.exitCode = failed ? 1 : 0;
    return;
  }
  if (command === "setup") return (await import("./setup.js")).setupCommand(rest);
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
