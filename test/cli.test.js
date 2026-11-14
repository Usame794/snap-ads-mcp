// The npm entry point: commands, the settings location of an installed copy, and `init`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dataDir, ROOT } from "../src/env.js";
import { init } from "../src/cli.js";

const CLI = join(ROOT, "src", "cli.js");
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, SNAP_ENV_FILE: "", ...env } });

test("a git checkout keeps its data in the project folder; an npm install uses a folder in the home directory", () => {
  assert.equal(dataDir({ root: "/work/ads-mcp-for-snapchat", env: {}, home: "/home/u" }), "/work/ads-mcp-for-snapchat");
  assert.equal(dataDir({ root: "/home/u/.npm/_npx/abc/node_modules/ads-mcp-for-snapchat", env: {}, home: "/home/u" }), join("/home/u", ".ads-mcp-for-snapchat"));
  assert.equal(dataDir({ root: "/usr/lib/node_modules/ads-mcp-for-snapchat", env: { SNAP_HOME: "/data/snap" }, home: "/home/u" }), "/data/snap");
});

test("init creates a private settings file from the template and never overwrites one", () => {
  const file = join(mkdtempSync(join(tmpdir(), "cli-")), "sub", ".env");
  assert.deepEqual(init(file), { created: true, file });
  assert.equal(readFileSync(file, "utf8"), readFileSync(join(ROOT, ".env.example"), "utf8"));
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(file, "SNAP_AD_ACCOUNT_ID=mine\n");
  assert.equal(init(file).created, false);
  assert.equal(readFileSync(file, "utf8"), "SNAP_AD_ACCOUNT_ID=mine\n");
});

test("help, where and an unknown command", () => {
  const help = run(["help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /save-secret/);
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const where = run(["where"], { SNAP_ENV_FILE: join(dir, ".env.account2") });
  assert.equal(where.stdout.trim(), join(dir, ".env.account2"));
  const bad = run(["deploy"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown command: deploy/);
});

test("init through the command line writes SNAP_ENV_FILE and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const file = join(dir, ".env.account2");
  const r = run(["init"], { SNAP_ENV_FILE: file });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(file));
  assert.match(r.stdout, /Created/);
});

test("a setup command runs its script with the remaining arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const file = join(dir, ".env");
  writeFileSync(file, "SNAP_CLIENT_ID=x\n");
  // auth with a code but no secret or redirect URL: the script itself reports what is missing, so the code reached it
  const r = run(["auth", "THE_CODE"], { SNAP_ENV_FILE: file, SNAP_CLIENT_SECRET: "", SNAP_REDIRECT_URI: "", CODE: "" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing: SNAP_CLIENT_SECRET, SNAP_REDIRECT_URI\./);
});

test("package.json, server.json and the server agree on name and version", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const server = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8"));
  assert.equal(pkg.bin["ads-mcp-for-snapchat"], "src/cli.js");
  assert.equal(pkg.mcpName, server.name);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.ok(server.description.length <= 100);
  assert.match(readFileSync(join(ROOT, "src", "index.js"), "utf8"), new RegExp(`version: "${pkg.version.replace(/\./g, "\\.")}"`));
  for (const f of pkg.files) assert.ok(existsSync(join(ROOT, f)), `${f} is in the package`);
});
