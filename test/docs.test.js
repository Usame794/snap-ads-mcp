// Documentation stays true: every tool and every setting in the code is described in the README.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/env.js";
import { setup } from "./helpers/harness.js";

const read = (f) => readFileSync(join(ROOT, f), "utf8");

test("every tool is described in the README, and the README states the right tool count", async () => {
  const t = await setup();
  const names = (await t.client.listTools()).tools.map((x) => x.name);
  await t.close();
  const readme = read("README.md");
  assert.deepEqual(names.filter((n) => !readme.includes(`\`${n}\``)), [], "add the tool to the README tools table");
  assert.match(read("ARCHITECTURE.md"), new RegExp(`${names.length} tools`), "ARCHITECTURE.md has the current tool count");
});

test("every SNAP_ setting the code reads is documented in the README or .env.example", () => {
  const code = ["policy.js", "tools.js", "env.js", "index.js", "portfolio.js", "snap.js", "setup.js", "cli.js"].map((f) => read(`src/${f}`)).join("\n");
  const used = new Set([...code.matchAll(/\b(SNAP_[A-Z0-9_]+)\b/g)].map((m) => m[1]));
  const docs = `${read("README.md")}\n${read(".env.example")}`;
  const internal = ["SNAP_ENV_FILE", "SNAP_HOME", "SNAP_LOG_FILE"]; // documented in their own sections; checked below
  const missing = [...used].filter((k) => !docs.includes(k));
  assert.deepEqual(missing, [], "document the setting in README.md or .env.example");
  for (const k of internal) assert.ok(docs.includes(k), k);
});

test("SECURITY.md lists the outside addresses the server contacts", () => {
  const sec = read("SECURITY.md");
  for (const host of ["adsapi.snapchat.com", "accounts.snapchat.com", "tr.snapchat.com"]) assert.ok(sec.includes(host), host);
  const code = ["snap.js", "intel.js", "checks.js", "oauth.js"].map((f) => read(`src/${f}`)).join("\n");
  const hosts = new Set([...code.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/g)].map((m) => m[1]));
  const allowed = ["adsapi.snapchat.com", "accounts.snapchat.com", "tr.snapchat.com", "ad-preview.snapchat.com", "ads-interfaces.sc-cdn.net", "snap.com", "developers.snap.com"];
  assert.deepEqual([...hosts].filter((h) => !allowed.includes(h) && !h.endsWith("example.com") && !h.endsWith("example")), [], "a new outside address must be reviewed and added to SECURITY.md");
});
