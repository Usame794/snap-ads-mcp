// Several ad accounts: one settings file per account (SNAP_ENV_FILE), with its own change log, limits and credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { envFile, loadEnv, ROOT, setEnvValue } from "../src/env.js";
import { addedDailyBudgetInWindow } from "../src/audit-log.js";
import { setup } from "./helpers/harness.js";

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  // process.env turns undefined into the string "undefined", so unset keys must be deleted instead
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test("saving a secret or token writes the settings file in use, never the main .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "acc-"));
  const second = join(dir, ".env.account2");
  writeFileSync(second, "SNAP_AD_ACCOUNT_ID=acc-2\n");
  const mainBefore = existsSync(join(ROOT, ".env")) ? readFileSync(join(ROOT, ".env"), "utf8") : null;
  withEnv({ SNAP_ENV_FILE: second }, () => {
    assert.equal(envFile(), second);
    setEnvValue("SNAP_REFRESH_TOKEN", "token-for-account-2");
  });
  assert.equal(readFileSync(second, "utf8"), "SNAP_AD_ACCOUNT_ID=acc-2\nSNAP_REFRESH_TOKEN=token-for-account-2\n");
  const mainAfter = existsSync(join(ROOT, ".env")) ? readFileSync(join(ROOT, ".env"), "utf8") : null;
  assert.equal(mainAfter, mainBefore, "the main .env is untouched");
  withEnv({ SNAP_ENV_FILE: undefined }, () => assert.equal(envFile(), join(ROOT, ".env")));
});

test("loadEnv reads the file named by SNAP_ENV_FILE", () => {
  const dir = mkdtempSync(join(tmpdir(), "acc-"));
  const file = join(dir, ".env.account2");
  writeFileSync(file, "SNAP_TEST_ONLY_VALUE=from-account-2\n");
  withEnv({ SNAP_ENV_FILE: file, SNAP_TEST_ONLY_VALUE: undefined }, () => {
    loadEnv();
    assert.equal(process.env.SNAP_TEST_ONLY_VALUE, "from-account-2");
  });
});

test("each settings file gets its own change log, so limits and undo never mix between accounts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acc-"));
  const fileA = join(dir, ".env.a");
  const fileB = join(dir, ".env.b");
  const a = await setup({ env: { SNAP_LOG_FILE: "", SNAP_ENV_FILE: fileA } });
  const b = await setup({ env: { SNAP_LOG_FILE: "", SNAP_ENV_FILE: fileB } });
  const rootLogBefore = existsSync(join(ROOT, "changes.log.jsonl"));
  // account A enables a squad (adds 100/day) and renames something
  assert.equal((await a.twoStep("snap_set_status", { entity: "adsquad", id: "s2", status: "ACTIVE" })).applied.data?.applied, true);
  assert.equal(addedDailyBudgetInWindow(`${fileA}.log.jsonl`), 100);
  assert.equal(addedDailyBudgetInWindow(`${fileB}.log.jsonl`), 0, "account B's 24h budget is not used up by account A");
  assert.ok(existsSync(`${fileA}.log.jsonl`));
  assert.ok(!existsSync(`${fileB}.log.jsonl`));
  assert.equal(existsSync(join(ROOT, "changes.log.jsonl")), rootLogBefore, "nothing is written to the project's default log");
  // account B has nothing to undo; account A has its own change
  assert.match((await b.call("snap_undo", {})).error, /No undoable change/);
  assert.equal((await a.call("snap_undo", {})).data?.reverting?.change, "status PAUSED -> ACTIVE");
  // SNAP_LOG_FILE still wins when set
  const c = await setup({ env: { SNAP_ENV_FILE: fileA } });
  await c.twoStep("snap_rename", { entity: "adsquad", id: "s1", new_name: "Squad one renamed" });
  assert.ok(existsSync(c.logFile) && c.logFile !== `${fileA}.log.jsonl`);
  await a.close();
  await b.close();
  await c.close();
});

test("the server reads its limits from SNAP_ENV_FILE: a bad value there stops it, a good one starts it", () => {
  const dir = mkdtempSync(join(tmpdir(), "acc-"));
  const bad = join(dir, ".env.bad");
  const good = join(dir, ".env.good");
  writeFileSync(bad, "SNAP_MAX_DAILY_BUDGET=lots\n");
  writeFileSync(good, "SNAP_MAX_DAILY_BUDGET=250\nSNAP_DEFAULT_COUNTRY=gb\n");
  const run = (file) => spawnSync(process.execPath, ["src/index.js"], { cwd: ROOT, input: "", encoding: "utf8", timeout: 20000, env: { PATH: process.env.PATH, SNAP_ENV_FILE: file } });
  const r1 = run(bad);
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /SNAP_MAX_DAILY_BUDGET/);
  assert.equal(run(good).status, 0);
});

test("credential and log files of any account are git-ignored, the example is not", () => {
  const r = spawnSync("git", ["check-ignore", "--no-index", ".env", ".env.account2", ".env.account2.log.jsonl", "changes.log.jsonl"], { cwd: ROOT, encoding: "utf8" });
  assert.deepEqual(r.stdout.trim().split("\n"), [".env", ".env.account2", ".env.account2.log.jsonl", "changes.log.jsonl"]);
  assert.equal(spawnSync("git", ["check-ignore", "--no-index", "-q", ".env.example"], { cwd: ROOT }).status, 1, ".env.example stays tracked");
});

test("a key written twice in a settings file: the last line wins, and saving a value replaces every copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "dup-"));
  const file = join(dir, ".env.account2");
  writeFileSync(file, "SNAP_READ_ONLY=0\nSNAP_AD_ACCOUNT_ID=acc-2\nSNAP_READ_ONLY=1\n");
  withEnv({ SNAP_READ_ONLY: undefined, SNAP_AD_ACCOUNT_ID: undefined }, () => {
    loadEnv(file);
    assert.equal(process.env.SNAP_READ_ONLY, "1", "the line appended at the end takes effect");
  });
  withEnv({ SNAP_READ_ONLY: "0" }, () => {
    loadEnv(file);
    assert.equal(process.env.SNAP_READ_ONLY, "0", "a real environment variable still wins over the file");
  });
  writeFileSync(file, "SNAP_REFRESH_TOKEN=old-1\nSNAP_AD_ACCOUNT_ID=acc-2\nSNAP_REFRESH_TOKEN=old-2\n");
  setEnvValue("SNAP_REFRESH_TOKEN", "new", file);
  assert.equal(readFileSync(file, "utf8"), "SNAP_REFRESH_TOKEN=new\nSNAP_AD_ACCOUNT_ID=acc-2\n");
  writeFileSync(file, "SNAP_AD_ACCOUNT_ID=acc-2\nSNAP_REFRESH_TOKEN=old");
  setEnvValue("SNAP_REFRESH_TOKEN", "new", file);
  assert.equal(readFileSync(file, "utf8"), "SNAP_AD_ACCOUNT_ID=acc-2\nSNAP_REFRESH_TOKEN=new");
});
