import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFileAllowed } from "../src/media-dir.js";
import { loadPolicy } from "../src/policy.js";

const root = mkdtempSync(join(tmpdir(), "media-"));
const allowed = join(root, "allowed");
const other = join(root, "other");
mkdirSync(allowed);
mkdirSync(other);
writeFileSync(join(allowed, "a.png"), "x");
writeFileSync(join(other, "b.png"), "x");

test("with no SNAP_MEDIA_DIR nothing is restricted", () => {
  assert.doesNotThrow(() => assertFileAllowed(join(other, "b.png"), null));
});

test("a file inside the folder is allowed, one outside is refused", () => {
  assert.doesNotThrow(() => assertFileAllowed(join(allowed, "a.png"), allowed));
  assert.throws(() => assertFileAllowed(join(other, "b.png"), allowed), /outside the folder allowed by SNAP_MEDIA_DIR/);
  assert.throws(() => assertFileAllowed(join(allowed, "..", "other", "b.png"), allowed), /outside/, "a .. path cannot escape");
});

test("a symbolic link inside the folder that points outside is refused", { skip: process.platform === "win32" }, () => {
  symlinkSync(join(other, "b.png"), join(allowed, "link.png"));
  assert.throws(() => assertFileAllowed(join(allowed, "link.png"), allowed), /outside/);
});

test("a missing file or a missing folder gives a clear error", () => {
  assert.throws(() => assertFileAllowed(join(allowed, "nope.png"), allowed), /File not found/);
  assert.throws(() => assertFileAllowed(join(allowed, "a.png"), join(root, "gone")), /SNAP_MEDIA_DIR .* does not exist/);
});

test("SNAP_MEDIA_DIR must be an absolute path", () => {
  assert.equal(loadPolicy({}).mediaDir, null);
  assert.equal(loadPolicy({ SNAP_MEDIA_DIR: "/data/media" }).mediaDir, "/data/media");
  assert.throws(() => loadPolicy({ SNAP_MEDIA_DIR: "media" }), /SNAP_MEDIA_DIR/);
});

import { setup } from "./helpers/harness.js";

test("the upload tools respect SNAP_MEDIA_DIR, and the four relabeled tools are marked destructive", async () => {
  const t = await setup({ env: { SNAP_MEDIA_DIR: allowed } });
  const refused = await t.call("snap_upload_media", { file_path: join(other, "b.png") });
  assert.match(refused.error, /outside the folder allowed by SNAP_MEDIA_DIR/);
  const tools = (await t.client.listTools()).tools;
  for (const n of ["snap_set_frequency_cap", "snap_set_ad_schedule", "snap_set_placement", "snap_claim_ad_code"]) {
    assert.equal(tools.find((x) => x.name === n).annotations.destructiveHint, true, n);
  }
});
