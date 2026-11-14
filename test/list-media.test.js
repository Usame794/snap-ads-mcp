// snap_list_media: find READY images and videos by type and name, newest first, across every page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACC, sampleWorld, setup } from "./helpers/harness.js";

function world() {
  const w = sampleWorld();
  w.media = {
    v1: { id: "v1", name: "Summer video.mp4", type: "VIDEO", media_status: "READY", ad_account_id: ACC, created_at: "2026-10-01T00:00:00Z", video_metadata: { width: 1080, height: 1920 } },
    v2: { id: "v2", name: "Old video.mp4", type: "VIDEO", media_status: "READY", ad_account_id: ACC, created_at: "2025-01-01T00:00:00Z" },
    i1: { id: "i1", name: "Bag product.png", type: "IMAGE", media_status: "READY", ad_account_id: ACC, created_at: "2026-09-01T00:00:00Z" },
    i2: { id: "i2", name: "Pending bag.png", type: "IMAGE", media_status: "PENDING_UPLOAD", ad_account_id: ACC, created_at: "2026-11-01T00:00:00Z" },
  };
  for (let i = 0; i < 30; i++) w.media[`x${i}`] = { id: `x${i}`, name: `Tile ${i}.png`, type: "IMAGE", media_status: "READY", ad_account_id: ACC, created_at: `2026-08-${String(i % 28 + 1).padStart(2, "0")}T00:00:00Z` };
  return w;
}
const rows = (r) => JSON.parse(r.content[0].text);
const note = (r) => r.content.slice(1).map((c) => c.text).join(" ");

test("lists READY media newest first, with filters for type and name", async () => {
  const t = await setup({ world: world() });
  t.hooks.pageSize = 10; // several pages
  const videos = await t.raw("snap_list_media", { type: "VIDEO" });
  assert.deepEqual(rows(videos).map((m) => m.id), ["v1", "v2"], "newest first");
  assert.deepEqual(rows(videos)[0].video_metadata, { width: 1080, height: 1920 });
  assert.deepEqual(rows(await t.raw("snap_list_media", { name_contains: "BAG" })).map((m) => m.id), ["i1"], "case-insensitive; the pending one is hidden");
  assert.deepEqual(rows(await t.raw("snap_list_media", { name_contains: "bag", ready_only: false })).map((m) => m.id), ["i2", "i1"]);
  const all = await t.raw("snap_list_media", { type: "IMAGE", limit: 5 });
  assert.equal(rows(all).length, 5);
  assert.match(note(all), /31 media match; showing the newest 5/);
  assert.equal(t.writes().length, 0, "read-only");
  await t.close();
});

test("an incomplete media list says so", async () => {
  const t = await setup({ world: world() });
  t.hooks.pageSize = 10;
  t.hooks.brokenPaging = true;
  const r = await t.raw("snap_list_media", { ready_only: false, limit: 500 });
  assert.equal(rows(r).length, 10);
  assert.match(note(r), /INCOMPLETE/);
  await t.close();
});
