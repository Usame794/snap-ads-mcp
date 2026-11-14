// Story Ads, Collection Ads, plain Snap Ads and the ad type that goes with each creative. Shapes follow Snap's API reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adTypeFor, buildCollectionCreative, buildCompositeCreative, buildCreativeElement, buildInteractionZone, buildPreviewCreative, buildSnapAdCreative, WEB_VIEW_CTAS } from "../src/formats.js";
import { CTAS, buildCreative } from "../src/influencer.js";
import { ACC, sampleWorld, setup } from "./helpers/harness.js";

const posts = (t, plural) => t.writes().filter((c) => c.method === "POST" && c.path.endsWith(`/${plural}`)).map((c) => c.body[plural][0]);

function world() {
  const w = sampleWorld();
  w.creatives.cr2 = { id: "cr2", name: "Snap two", type: "SNAP_AD", ad_account_id: ACC };
  w.creatives.cr3 = { id: "cr3", name: "Snap three", type: "WEB_VIEW", ad_account_id: ACC };
  w.creatives.lens = { id: "lens", name: "A lens", type: "LENS", ad_account_id: ACC };
  w.creatives.crx = { id: "crx", name: "Foreign", type: "WEB_VIEW", ad_account_id: "acc-OTHER" };
  w.creatives.story = { id: "story", name: "A story", type: "COMPOSITE", ad_account_id: ACC };
  w.creatives.coll = { id: "coll", name: "A collection", type: "COLLECTION", ad_account_id: ACC };
  w.creatives.prev = { id: "prev", name: "A tile", type: "PREVIEW", ad_account_id: ACC };
  w.media.img = { id: "img", ad_account_id: ACC, media_status: "READY", type: "IMAGE" };
  w.media.pending = { id: "pending", ad_account_id: ACC, media_status: "PENDING_UPLOAD", type: "IMAGE" };
  return w;
}
const product = (i, media = "img") => ({ name: `Product ${i}`, image_media_id: media, url: `https://shop.example.com/p${i}` });

test("call to action list is Snap's documented WEB_VIEW list (BUY_NOW and VIEW_MORE are not valid)", () => {
  assert.equal(CTAS, WEB_VIEW_CTAS);
  assert.ok(!CTAS.includes("BUY_NOW") && !CTAS.includes("VIEW_MORE"));
  assert.ok(["SHOP_NOW", "ORDER_NOW", "MORE", "BOOK_NOW"].every((c) => CTAS.includes(c)));
  assert.throws(() => buildCreative({ adAccountId: "a", profileId: "p", mediaId: "m", name: "n", headline: "h", url: "https://x.com", callToAction: "BUY_NOW" }), /call_to_action/);
});

test("builders produce Snap's documented shapes and enforce its limits", () => {
  assert.deepEqual(buildSnapAdCreative({ adAccountId: "a", profileId: "p", mediaId: "m", name: "N", headline: "H" }), { ad_account_id: "a", name: "N", type: "SNAP_AD", top_snap_media_id: "m", headline: "H", shareable: true, profile_properties: { profile_id: "p" } });
  assert.deepEqual(buildPreviewCreative({ adAccountId: "a", name: "T", previewMediaId: "pm", previewHeadline: "Tile", logoMediaId: "lg" }).preview_properties, { preview_media_id: "pm", preview_headline: "Tile", logo_media_id: "lg" });
  assert.throws(() => buildPreviewCreative({ adAccountId: "a", name: "T", previewMediaId: "pm", previewHeadline: "x".repeat(56) }), /55/);
  const comp = buildCompositeCreative({ adAccountId: "a", profileId: "p", name: "S", headline: "H", creativeIds: ["c1", "c2"], previewCreativeId: "pv" });
  assert.deepEqual([comp.type, comp.composite_properties.creative_ids, comp.preview_creative_id], ["COMPOSITE", ["c1", "c2"], "pv"]);
  assert.throws(() => buildCompositeCreative({ adAccountId: "a", profileId: "p", name: "S", headline: "H", creativeIds: [] }), /1 to 20/);
  assert.throws(() => buildCompositeCreative({ adAccountId: "a", profileId: "p", name: "S", headline: "H", creativeIds: Array.from({ length: 21 }, (_, i) => `c${i}`) }), /1 to 20/);
  assert.throws(() => buildCompositeCreative({ adAccountId: "a", profileId: "p", name: "S", headline: "H", creativeIds: ["c1", "c1"] }), /same creative twice/);
  assert.throws(() => buildCompositeCreative({ adAccountId: "a", profileId: "p", name: "S", headline: "x".repeat(35), creativeIds: ["c1"] }), /34/);
  assert.deepEqual(buildCreativeElement({ adAccountId: "a", name: "P", imageMediaId: "i", url: "https://x.com/p", title: "T" }), { ad_account_id: "a", name: "P", type: "BUTTON", interaction_type: "WEB_VIEW", button_properties: { button_overlay_media_id: "i" }, web_view_properties: { url: "https://x.com/p" }, title: "T" });
  assert.throws(() => buildCreativeElement({ adAccountId: "a", name: "P", imageMediaId: "i", url: "http://x.com" }), /https/);
  assert.throws(() => buildInteractionZone({ adAccountId: "a", name: "Z", headline: "MORE", creativeElementIds: ["1", "2", "3"] }), /4 to 20/);
  assert.throws(() => buildInteractionZone({ adAccountId: "a", name: "Z", headline: "BUY_NOW", creativeElementIds: ["1", "2", "3", "4"] }), /button label/);
  const coll = buildCollectionCreative({ adAccountId: "a", profileId: "p", name: "C", topSnapMediaId: "m", headline: "H", interactionZoneId: "z", fallbackUrl: "https://x.com" });
  assert.deepEqual(coll.collection_properties, { interaction_zone_id: "z", default_fallback_interaction_type: "WEB_VIEW", web_view_properties: { url: "https://x.com" } });
  assert.ok(!("call_to_action" in coll), "Snap requires call_to_action to be left out on a Collection creative");
});

test("the ad type follows the creative; a mismatch or a tile-only creative is refused", () => {
  assert.deepEqual(["WEB_VIEW", "SNAP_AD", "COMPOSITE", "COLLECTION", "APP_INSTALL"].map((t) => adTypeFor(t)), ["REMOTE_WEBPAGE", "SNAP_AD", "STORY", "COLLECTION", "APP_INSTALL"]);
  assert.throws(() => adTypeFor("COMPOSITE", "REMOTE_WEBPAGE"), /needs ad type STORY/);
  assert.throws(() => adTypeFor("PREVIEW"), /only the tile/);
  assert.throws(() => adTypeFor("LENS"), /Give ad_type/);
  assert.equal(adTypeFor("LENS", "LENS"), "LENS");
});

test("snap_create_ad picks STORY / COLLECTION / SNAP_AD from the creative and stays PAUSED", async () => {
  const t = await setup({ world: world() });
  for (const [creative, type] of [["story", "STORY"], ["coll", "COLLECTION"], ["cr2", "SNAP_AD"], ["cr1", "REMOTE_WEBPAGE"]]) {
    const r = await t.twoStep("snap_create_ad", { creative_id: creative, adsquad_id: "s1", name: `Ad ${creative}` });
    assert.equal(r.preview.data.would_create.type, type);
    assert.equal(r.applied.data.status, "PAUSED");
  }
  assert.deepEqual(posts(t, "ads").map((a) => [a.type, a.status]), [["STORY", "PAUSED"], ["COLLECTION", "PAUSED"], ["SNAP_AD", "PAUSED"], ["REMOTE_WEBPAGE", "PAUSED"]]);
  assert.match((await t.call("snap_create_ad", { creative_id: "story", adsquad_id: "s1", name: "Wrong", ad_type: "REMOTE_WEBPAGE" })).error, /needs ad type STORY/);
  assert.match((await t.call("snap_create_ad", { creative_id: "prev", adsquad_id: "s1", name: "Tile" })).error, /only the tile/);
  assert.match((await t.call("snap_create_ad", { creative_id: "crx", adsquad_id: "s1", name: "Foreign" })).error, /another ad account/);
  await t.close();
});

test("snap_create_creative makes a plain SNAP_AD (no link, no call to action) from a video or image", async () => {
  const t = await setup({ world: world() });
  const r = await t.twoStep("snap_create_creative", { media_id: "m1", name: "Video snap", headline: "Watch this", creative_type: "SNAP_AD" });
  assert.equal(r.applied.data.applied, true);
  const sent = posts(t, "creatives")[0];
  assert.deepEqual([sent.type, sent.top_snap_media_id, "web_view_properties" in sent, "call_to_action" in sent], ["SNAP_AD", "m1", false, false]);
  assert.match((await t.call("snap_create_creative", { media_id: "m1", name: "x", headline: "y", creative_type: "SNAP_AD", url: "https://x.com" })).error, /no link/);
  assert.match((await t.call("snap_create_creative", { media_id: "m1", name: "x", headline: "y" })).error, /https/, "WEB_VIEW still needs a url");
  await t.close();
});

test("Story: preview tile then composite, in order, from creatives of this account only", async () => {
  const t = await setup({ world: world() });
  const args = { name: "Winter story", headline: "New in", creative_ids: ["cr3", "cr2", "cr1"], preview: { preview_media_id: "img", preview_headline: "Winter drop", logo_media_id: "img" } };
  const r = await t.twoStep("snap_create_story_creative", args);
  assert.deepEqual(r.preview.data.would_create.snaps_in_order.map((s) => s.id), ["cr3", "cr2", "cr1"]);
  assert.equal(r.applied.data.applied, true);
  const [tile, story] = posts(t, "creatives");
  assert.deepEqual([tile.type, tile.preview_properties.preview_headline, tile.preview_properties.logo_media_id], ["PREVIEW", "Winter drop", "img"]);
  assert.deepEqual([story.type, story.composite_properties.creative_ids, story.preview_creative_id], ["COMPOSITE", ["cr3", "cr2", "cr1"], r.applied.data.preview_creative_id]);
  assert.equal(r.applied.data.story_creative_id, Object.values(t.db.creatives).find((c) => c.name === "Winter story").id);
  // without a preview: only the composite
  const noTile = await t.twoStep("snap_create_story_creative", { name: "Short story", headline: "Hi", creative_ids: ["cr2"] });
  assert.equal(noTile.applied.data.preview_creative_id, undefined);
  assert.match(noTile.preview.data.would_create.preview_tile, /only between other stories/);
  // refusals: wrong part type, foreign creative, media not ready, too many, duplicates
  assert.match((await t.call("snap_create_story_creative", { ...args, creative_ids: ["cr1", "lens"] })).error, /LENS; a Story can only contain/);
  assert.match((await t.call("snap_create_story_creative", { ...args, creative_ids: ["cr1", "crx"] })).error, /another ad account/);
  assert.match((await t.call("snap_create_story_creative", { ...args, preview: { preview_media_id: "pending", preview_headline: "x" } })).error, /not READY/);
  assert.equal((await t.raw("snap_create_story_creative", { ...args, creative_ids: Array.from({ length: 21 }, () => "cr1") })).isError, true);
  assert.match((await t.call("snap_create_story_creative", { ...args, creative_ids: ["cr1", "cr1"] })).error, /same creative twice/);
  await t.close();
});

test("Collection: product tiles, then the product row, then the COLLECTION creative", async () => {
  const t = await setup({ world: world() });
  const args = { name: "Bags collection", top_snap_media_id: "m1", headline: "Our bags", fallback_url: "https://shop.example.com/bags", products: [1, 2, 3, 4, 5].map((i) => product(i)) };
  const r = await t.twoStep("snap_create_collection_creative", args);
  assert.equal(r.applied.data.applied, true);
  const tiles = posts(t, "creative_elements");
  assert.equal(tiles.length, 5);
  assert.deepEqual([tiles[0].type, tiles[0].interaction_type, tiles[0].button_properties.button_overlay_media_id, tiles[0].web_view_properties.url], ["BUTTON", "WEB_VIEW", "img", "https://shop.example.com/p1"]);
  const [zone] = posts(t, "interaction_zones");
  assert.deepEqual([zone.headline, zone.creative_element_ids], ["SHOP_NOW", r.applied.data.product_tile_ids]);
  const coll = posts(t, "creatives")[0];
  assert.deepEqual([coll.type, coll.collection_properties.interaction_zone_id, coll.collection_properties.default_fallback_interaction_type, "call_to_action" in coll], ["COLLECTION", r.applied.data.interaction_zone_id, "WEB_VIEW", false]);
  // refusals
  assert.equal((await t.raw("snap_create_collection_creative", { ...args, products: args.products.slice(0, 3) })).isError, true, "fewer than 4 products");
  assert.match((await t.call("snap_create_collection_creative", { ...args, products: [product(1, "pending"), product(2), product(3), product(4)] })).error, /not READY/);
  assert.match((await t.call("snap_create_collection_creative", { ...args, fallback_url: "http://shop.example.com" })).error, /https/);
  assert.match((await t.call("snap_create_collection_creative", { ...args, products: [{ ...product(1), url: "ftp://x" }, product(2), product(3), product(4)] })).error, /https/);
  await t.close();
});

test("a failure half way through a Collection reports exactly what was already created", async () => {
  const t = await setup({ world: world() });
  const args = { name: "Bags collection", top_snap_media_id: "m1", headline: "Our bags", fallback_url: "https://shop.example.com/bags", products: [1, 2, 3, 4].map((i) => product(i)) };
  const p = (await t.call("snap_create_collection_creative", args)).data;
  // the 5th POST (the product row, after 4 tiles) fails in transit
  let n = 0;
  const origPush = t.calls.push.bind(t.calls);
  t.calls.push = (c) => {
    if (c.method === "POST" && ++n === 5) t.hooks.failNextWrite = new TypeError("fetch failed");
    return origPush(c);
  };
  const r = await t.call("snap_create_collection_creative", { ...args, confirm: true, approval_token: p.approval_token });
  assert.match(r.error, /OUTCOME UNKNOWN.*Created so far.*product_tile_ids/);
  assert.equal(posts(t, "creative_elements").length, 4);
  assert.equal(posts(t, "creatives").length, 0, "no collection creative after the failure");
  await t.close();
});

test("product tile images must be square images of at least 120x120 (checked in the preview, before anything is sent)", async () => {
  const w = world();
  w.media.square = { id: "square", ad_account_id: ACC, media_status: "READY", type: "IMAGE", image_metadata: { width: 600, height: 600 } };
  w.media.tall = { id: "tall", ad_account_id: ACC, media_status: "READY", type: "IMAGE", image_metadata: { width: 600, height: 1000 } };
  w.media.tiny = { id: "tiny", ad_account_id: ACC, media_status: "READY", type: "IMAGE", image_metadata: { width: 100, height: 100 } };
  w.media.vid = { id: "vid", ad_account_id: ACC, media_status: "READY", type: "VIDEO", video_metadata: { width: 720, height: 1280 } };
  const t = await setup({ world: w });
  const base = { name: "C", top_snap_media_id: "vid", headline: "H", fallback_url: "https://shop.example.com" };
  const four = (img) => [1, 2, 3, 4].map((i) => product(i, i === 3 ? img : "square"));
  assert.match((await t.call("snap_create_collection_creative", { ...base, products: four("tall") })).error, /"Product 3" \(tall\) is 600x1000; product tile images must be square/);
  assert.match((await t.call("snap_create_collection_creative", { ...base, products: four("tiny") })).error, /at least 120x120/);
  assert.match((await t.call("snap_create_collection_creative", { ...base, products: four("vid") })).error, /is a VIDEO; product tiles need an image/);
  assert.equal(t.writes().length, 0, "refused before anything is sent");
  // a good one: the preview lists the media ids and sizes that the approval is bound to
  const ok = (await t.call("snap_create_collection_creative", { ...base, products: four("square") })).data;
  assert.deepEqual(ok.would_create.main_snap, { media_id: "vid", type: "VIDEO", size: "720x1280" });
  assert.deepEqual(ok.would_create.products.map((p) => [p.image_media_id, p.image_size]), [["square", "600x600"], ["square", "600x600"], ["square", "600x600"], ["square", "600x600"]]);
  assert.equal(ok.warnings, undefined);
  // size unknown: allowed, but the preview says it could not be checked
  const unknown = (await t.call("snap_create_collection_creative", { ...base, products: four("img") })).data;
  assert.match(unknown.warnings[0], /size unknown, could not check that it is square/);
  await t.close();
});
