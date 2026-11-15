// Catalog (Dynamic Product) ads: product set filters, templates, the catalog campaign, ad squad and creative, and the ad that ties them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDynamicCreative, buildDynamicTemplate, buildProductSet, checkProductSetFilter, describeFilter, productAudiences } from "../src/catalog-ads.js";
import { buildCampaign, buildAdSquad } from "../src/create.js";
import { ACC, sampleWorld, setup } from "./helpers/harness.js";

const bad = (filter, re) => assert.throws(() => checkProductSetFilter(filter), re);

test("product set filters follow Snap's rules", () => {
  assert.deepEqual(checkProductSetFilter({ AVAILABILITY: { EQ: "IN_STOCK" } }), { AVAILABILITY: { EQ: "IN_STOCK" } });
  checkProductSetFilter({ AND: [{ PRICE_AMOUNT: { GT: "15.50" } }, { BRAND: { IS_ANY: ["a", "b"] } }, { TITLE: { CONTAINS: "Red Shoes" } }] });
  checkProductSetFilter({ ID: { IS_ANY: Array.from({ length: 1000 }, (_, i) => `sp-${i}`) } });
  bad({}, /filter is required/);
  bad({ NOPE: { EQ: "x" } }, /Unknown product attribute/);
  bad({ AVAILABILITY: { EQ: "in stock" } }, /must be one of IN_STOCK/);
  bad({ AVAILABILITY: { CONTAINS: "IN" } }, /only supports EQ and NEQ/);
  bad({ PRICE_AMOUNT: { GT: 15.5 } }, /written as a string/);
  bad({ PRICE_AMOUNT: { GT: "15.555" } }, /2 decimals/);
  bad({ AND: [{ BRAND: { EQ: "a" } }, { BRAND: { EQ: "b" } }] }, /appears more than once/);
  bad({ AND: [{ BRAND: { EQ: "a" } }], OR: [] }, /Only one logical operator/);
  bad({ BRAND: { IS_ANY: Array.from({ length: 16 }, (_, i) => `b${i}`) } }, /at most 15/);
  bad({ ID: { IS_ANY: Array.from({ length: 1001 }, (_, i) => `i${i}`) } }, /at most 1000/);
  bad({ BRAND: { IS_ANY: ["a/b"] } }, /only works with letters/);
  bad({ AND: Array.from({ length: 11 }, (_, i) => ({ [["BRAND", "COLOR", "SIZE", "TITLE", "MATERIAL", "PATTERN", "PRODUCT_TYPE", "ITEM_GROUP_ID", "ID", "CUSTOM_LABEL_0", "CUSTOM_LABEL_1"][i]]: { EQ: "x" } })) }, /At most 10/);
  assert.equal(describeFilter({ AND: [{ PRICE_AMOUNT: { GT: "15.50" } }, { COLOR: { IS_ANY: ["red"] } }] }), "PRICE_AMOUNT GT 15.50 AND COLOR IS_ANY [red]");
  assert.throws(() => buildProductSet({ name: "ab", filter: { BRAND: { EQ: "x" } } }), /3-255/);
});

test("template, creative and audiences are built in Snap's documented shapes", () => {
  const t = buildDynamicTemplate({ adAccountId: "a", name: "Grid", textFields: ["title", "price"], backgroundColor: "#FFF" });
  assert.deepEqual([t.layout, t.text_fields, t.background_color, t.ios_url === t.android_url], ["AUTOMATIC", ["title", "price"], "FFF", true]);
  assert.throws(() => buildDynamicTemplate({ adAccountId: "a", name: "x", textFields: ["title", "price", "brand"] }), /at most 2/);
  assert.throws(() => buildDynamicTemplate({ adAccountId: "a", name: "x", layout: "CAROUSEL" }), /layout must be one of/);
  assert.throws(() => buildDynamicTemplate({ adAccountId: "a", name: "x", textFields: ["nope"] }), /Unknown text field/);
  const c = buildDynamicCreative({ adAccountId: "a", profileId: "p", name: "DPA", headline: "Shop now", callToAction: "SHOP_NOW", templateId: "dt", productSetId: "ps", urlMacroParameters: "utm_campaign=campaign.name" });
  assert.deepEqual([c.type, c.render_type, c.dynamic_render_properties, c.web_view_properties, c.top_snap_media_id], ["WEB_VIEW", "DYNAMIC", { dynamic_template_id: "dt", product_set_id: "ps" }, undefined, undefined]);
  assert.throws(() => buildDynamicCreative({ adAccountId: "a", profileId: "p", name: "n", headline: "x".repeat(35), templateId: "dt", productSetId: "ps" }), /34/);
  const re = productAudiences({ mode: "retargeting", productSetId: "ps", days: 7 });
  assert.deepEqual(re.map((r) => [r.event_type, r.operation, r.retention_seconds]), [["VIEW_CONTENT", "INCLUDE", 604800], ["ADD_CART", "INCLUDE", 604800], ["PURCHASE", "EXCLUDE", 604800]]);
  const pr = productAudiences({ mode: "prospecting", productSetId: "ps" });
  assert.ok(pr.length === 4 && pr.every((r) => r.operation === "EXCLUDE" && r.retention_seconds === 14 * 86400));
  assert.throws(() => productAudiences({ mode: "retargeting", productSetId: "ps", days: 31 }), /1 to 30/);
  assert.throws(() => productAudiences({ mode: "other", productSetId: "ps" }), /retargeting or prospecting/);
});

test("campaign and ad squad builders carry the catalog and product set", () => {
  const camp = buildCampaign({ adAccountId: "a", name: "DPA campaign", catalogId: "cat1" });
  assert.deepEqual([camp.product_properties, camp.status, camp.objective_v2_properties.objective_v2_type], [{ catalog_id: "cat1" }, "PAUSED", "SALES"]);
  assert.throws(() => buildCampaign({ adAccountId: "a", name: "DPA campaign", objective: "TRAFFIC", catalogId: "cat1" }), /SALES/);
  assert.equal(buildCampaign({ adAccountId: "a", name: "Plain campaign" }).product_properties, undefined);
  const env = { SNAP_MAX_DAILY_BUDGET: "100", SNAP_MAX_BID: "10" };
  const squad = buildAdSquad({ campaignId: "c", name: "DPA squad", dailyBudget: 20, bid: 2, pixelId: "px", countries: ["sa"], productSetId: "ps1", dpaMode: "retargeting", audienceDays: 10, env });
  assert.deepEqual(squad.product_properties, { product_set_id: "ps1" });
  assert.equal(squad.status, "PAUSED");
  assert.equal(squad.targeting.product_audiences.length, 3);
  assert.throws(() => buildAdSquad({ campaignId: "c", name: "DPA squad", dailyBudget: 20, bid: 2, pixelId: "px", countries: ["sa"], productSetId: "ps1", env }), /dpa_mode is required/);
  assert.throws(() => buildAdSquad({ campaignId: "c", name: "DPA squad", dailyBudget: 20, bid: 2, pixelId: "px", countries: ["sa"], dpaMode: "retargeting", env }), /needs a product_set_id/);
  assert.throws(() => buildAdSquad({ campaignId: "c", name: "DPA squad", dailyBudget: 500, bid: 2, pixelId: "px", countries: ["sa"], productSetId: "ps1", dpaMode: "prospecting", env }), /absolute limit/);
});

const world = () => sampleWorld({ campaigns: { ...sampleWorld().campaigns, cc1: { id: "cc1", name: "Catalog campaign", status: "PAUSED", ad_account_id: ACC, product_properties: { catalog_id: "cat1" }, updated_at: "t0" } } });

test("product set tool: previews the rule, refuses foreign catalogs and duplicate names, then creates", async () => {
  const t = await setup({ world: world() });
  const filter = { AND: [{ AVAILABILITY: { EQ: "IN_STOCK" } }, { COLOR: { IS_ANY: ["red"] } }] };
  const p = await t.call("snap_create_product_set", { catalog_id: "cat1", name: "Red in stock", filter });
  assert.equal(p.data.would_create.rule, "AVAILABILITY EQ IN_STOCK AND COLOR IS_ANY [red]");
  assert.equal(t.writes().length, 0);
  assert.match((await t.call("snap_create_product_set", { catalog_id: "catx", name: "Red in stock", filter })).error, /another organization/);
  assert.match((await t.call("snap_create_product_set", { catalog_id: "cat1", name: "All products", filter })).error, /already has a product set named/);
  assert.match((await t.call("snap_create_product_set", { catalog_id: "cat1", name: "Bad", filter: { BRAND: { EQ: 5 } } })).error, /text value/);
  const done = await t.call("snap_create_product_set", { catalog_id: "cat1", name: "Red in stock", filter, confirm: true, approval_token: p.data.approval_token });
  assert.ok(done.data.product_set_id);
  const post = t.writes()[0];
  assert.equal(post.path, "/catalogs/cat1/product_sets");
  assert.deepEqual(post.body, { product_sets: [{ name: "Red in stock", filter }] });
  await t.close();
});

test("dynamic templates are listed and created for this ad account only", async () => {
  const t = await setup({ world: world() });
  const list = await t.call("snap_list_dynamic_templates");
  const ids = (Array.isArray(list.data) ? list.data : list.data.items ?? []).map((x) => x.id);
  assert.ok(ids.includes("dt1"), JSON.stringify(list.data).slice(0, 300));
  const r = await t.twoStep("snap_create_dynamic_template", { name: "Compact", layout: "FIT", text_fields: ["title"] });
  assert.ok(r.applied.data.dynamic_template_id);
  assert.deepEqual([t.writes()[0].path, t.writes()[0].body.dynamic_templates[0].layout], [`/adaccounts/${ACC}/dynamic_templates`, "FIT"]);
  await t.close();
});

test("catalog campaign, ad squad, creative and ad: the whole chain stays PAUSED and the product sets must match", async () => {
  const t = await setup({ world: world() });
  // campaign with a foreign catalog is refused; with an own catalog it is created PAUSED with product_properties
  assert.match((await t.call("snap_create_campaign", { name: "DPA campaign", catalog_id: "catx" })).error, /another organization/);
  const camp = await t.twoStep("snap_create_campaign", { name: "DPA campaign", catalog_id: "cat1" });
  assert.equal(t.writes()[0].body.campaigns[0].product_properties.catalog_id, "cat1");
  const campaignId = camp.applied.data.campaign_id;

  // ad squad: needs a catalog campaign, a product set of that catalog, and a pixel for retargeting
  const squadArgs = { campaign_id: campaignId, name: "DPA retargeting", daily_budget: 20, bid: 2, product_set_id: "ps1", dpa_mode: "retargeting" };
  assert.match((await t.call("snap_create_adsquad", { ...squadArgs, campaign_id: "c1" })).error, /not a catalog campaign/);
  assert.match((await t.call("snap_create_adsquad", { ...squadArgs, product_set_id: "psx" })).error, /not in this campaign's catalog/);
  assert.match((await t.call("snap_create_adsquad", { ...squadArgs, dpa_mode: undefined })).error, /dpa_mode is required/);
  const sq = await t.twoStep("snap_create_adsquad", squadArgs);
  assert.equal(sq.preview.data.would_create.catalog_ads.mode, "retargeting");
  const squadBody = t.writes().at(-1).body.adsquads[0];
  assert.deepEqual([squadBody.status, squadBody.product_properties, squadBody.targeting.product_audiences.length], ["PAUSED", { product_set_id: "ps1" }, 3]);
  const squadId = sq.applied.data.adsquad_id;

  // creative: no media, template of this account, product set of the ad squad
  const cArgs = { name: "DPA creative", headline: "Shop now", creative_type: "DYNAMIC_PRODUCT", dynamic_template_id: "dt1", product_set_id: "ps1", call_to_action: "SHOP_NOW" };
  assert.match((await t.call("snap_create_creative", { ...cArgs, media_id: "m1" })).error, /no media or url of its own/);
  assert.match((await t.call("snap_create_creative", { ...cArgs, dynamic_template_id: "dtx" })).error, /another ad account/);
  assert.match((await t.call("snap_create_creative", { media_id: "m1", name: "x", headline: "y", url: "https://example.com/", dynamic_template_id: "dt1" })).error, /belong to DYNAMIC_PRODUCT/);
  const cr = await t.twoStep("snap_create_creative", cArgs);
  const creativeBody = t.writes().at(-1).body.creatives[0];
  assert.deepEqual([creativeBody.render_type, creativeBody.dynamic_render_properties, creativeBody.web_view_properties], ["DYNAMIC", { dynamic_template_id: "dt1", product_set_id: "ps1" }, undefined]);

  // ad: the creative's product set must equal the ad squad's; the ad is DYNAMIC and PAUSED
  const ad = await t.twoStep("snap_create_ad", { creative_id: cr.applied.data.creative_id, adsquad_id: squadId, name: "DPA ad" });
  assert.equal(ad.preview.data.would_create.render_type, "DYNAMIC");
  const adBody = t.writes().at(-1).body.ads[0];
  assert.deepEqual([adBody.status, adBody.type, adBody.render_type], ["PAUSED", "REMOTE_WEBPAGE", "DYNAMIC"]);

  // mismatches are refused in both directions
  t.db.creatives.other = { id: "other", name: "Other set", type: "WEB_VIEW", render_type: "DYNAMIC", ad_account_id: ACC, dynamic_render_properties: { dynamic_template_id: "dt1", product_set_id: "ps-other" } };
  assert.match((await t.call("snap_create_ad", { creative_id: "other", adsquad_id: squadId, name: "Wrong set" })).error, /Snap requires them to match/);
  assert.match((await t.call("snap_create_ad", { creative_id: "cr1", adsquad_id: squadId, name: "Plain creative" })).error, /only takes catalog/);
  assert.match((await t.call("snap_create_ad", { creative_id: cr.applied.data.creative_id, adsquad_id: "s1", name: "No product set" })).error, /has no product set/);
  await t.close();
});

test("the money limits apply to catalog ad squads as to every other ad squad", async () => {
  const t = await setup({ world: world(), env: { SNAP_MAX_DAILY_BUDGET: "15" } });
  const r = await t.call("snap_create_adsquad", { campaign_id: "cc1", name: "Too big", daily_budget: 20, bid: 1, product_set_id: "ps1", dpa_mode: "prospecting" });
  assert.match(r.error, /absolute limit of 15/);
  assert.equal(t.writes().length, 0);
  await t.close();
});
