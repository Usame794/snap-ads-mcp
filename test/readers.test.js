import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapClient } from "../src/snap.js";
import { buildLookalike, checkReadPath, listCatalogs, listProductSets, listSegments, rawGet, targetingOptions } from "../src/readers.js";

const env = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };
function api(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (String(url).includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    calls.push({ method: opts.method ?? "GET", path: u.pathname.replace(/^\/v1/, ""), q: Object.fromEntries(u.searchParams) });
    const hit = routes[u.pathname.replace(/^\/v1/, "")];
    return hit ? json(typeof hit === "function" ? hit(u) : hit) : json({}, 404);
  };
  return { calls, client: new SnapClient({ env, fetchImpl }) };
}

test("read path guard: only allow-listed, no traversal, no query string", () => {
  assert.equal(checkReadPath("/adaccounts/x/stats"), "/adaccounts/x/stats");
  assert.equal(checkReadPath("/me"), "/me");
  for (const bad of ["adaccounts/x", "/adaccounts/../etc", "/adaccounts//x", "/adaccounts/x?limit=1", "/secrets/x", "/oauth2/token", ""]) assert.throws(() => checkReadPath(bad), /path/);
});

test("raw GET only issues GET and truncates big answers", async () => {
  const { calls, client } = api({ "/adaccounts/a/foo": { big: "x".repeat(5000) }, "/adaccounts/a/small": { ok: true } });
  const small = await rawGet(client, { path: "/adaccounts/a/small" });
  assert.deepEqual(small, { ok: true });
  const big = await rawGet(client, { path: "/adaccounts/a/foo", maxChars: 1000 });
  assert.equal(big.truncated, true);
  assert.equal(big.preview.length, 1000);
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("segments: filtered by type and size, sorted by size, all pages followed", async () => {
  const page1 = { segments: [{ segment: { id: "1", name: "A", source_type: "PIXEL", approximate_number_users: 100 } }, { segment: { id: "2", name: "B", source_type: "FIRST_PARTY", approximate_number_users: 5000, targetable_status: "READY" } }], paging: { next_link: "https://adsapi.snapchat.com/v1/adaccounts/a/segments?cursor=c2&limit=200" } };
  const page2 = { segments: [{ segment: { id: "3", name: "C", source_type: "FIRST_PARTY", approximate_number_users: 0 } }, { segment: { id: "4", name: "D", source_type: "FIRST_PARTY", approximate_number_users: 900 } }] };
  const { client } = api({ "/adaccounts/a/segments": (u) => (u.searchParams.get("cursor") === "c2" ? page2 : page1) });
  const all = await listSegments(client, "a");
  assert.deepEqual(all.map((s) => s.id), ["2", "4", "1", "3"]);
  assert.deepEqual((await listSegments(client, "a", { sourceType: "FIRST_PARTY", minSize: 1 })).map((s) => s.id), ["2", "4"]);
});

test("catalogs and product sets are flattened", async () => {
  const { client } = api({
    "/organizations/o/catalogs": { catalogs: [{ catalog: { id: "c1", name: "Cat", vertical: "COMMERCE", default_product_set_id: "ps1" } }] },
    "/catalogs/c1/product_sets": { product_sets: [{ product_set: { id: "ps1", name: "All" } }] },
  });
  assert.deepEqual((await listCatalogs(client, "o"))[0], { id: "c1", name: "Cat", vertical: "COMMERCE", status: undefined, default_product_set_id: "ps1" });
  assert.equal((await listProductSets(client, "c1"))[0].name, "All");
});

test("targeting options: country code passed, results searchable, bad kinds refused", async () => {
  const { calls, client } = api({ "/targeting/v1/interests/scls": { targeting_dimensions: [{ scls: { id: "SLC_1", name: "Adventure Seekers", path: "/Adventure Seekers" } }, { scls: { id: "SLC_9", name: "Fashion", path: "/Fashion" } }] } });
  const all = await targetingOptions(client, { kind: "interests_lifestyle", country: "SA" });
  assert.equal(calls[0].q.country_code, "sa");
  assert.equal(all.length, 2);
  assert.deepEqual((await targetingOptions(client, { kind: "interests_lifestyle", country: "sa", search: "fash" })).map((r) => r.id), ["SLC_9"]);
  await assert.rejects(() => targetingOptions(client, { kind: "interests_lifestyle" }), /country is required/);
  await assert.rejects(() => targetingOptions(client, { kind: "nope", country: "sa" }), /kind must be/);
  await assert.rejects(() => targetingOptions(client, { kind: "regions", country: "saudi" }), /2-letter/);
});

test("lookalike builder matches the shape Snap uses and validates", () => {
  const l = buildLookalike({ adAccountId: "a", seedSegmentId: "seed", name: "LAL test", countries: ["sa", "ae"], type: "REACH", retentionDays: 90 });
  assert.deepEqual(l.creation_spec, { seed_segment_id: "seed", country: "SA", countries: ["SA", "AE"], type: "REACH" });
  assert.equal(l.source_type, "LOOKALIKE");
  assert.equal(l.retention_in_days, 90);
  assert.throws(() => buildLookalike({ adAccountId: "a", name: "abc", countries: ["SA"] }), /seed_segment_id/);
  assert.throws(() => buildLookalike({ adAccountId: "a", seedSegmentId: "s", name: "abc" }), /countries is required/);
  assert.throws(() => buildLookalike({ adAccountId: "a", seedSegmentId: "s", name: "abc", countries: ["SA"], type: "X" }), /type must/);
  assert.throws(() => buildLookalike({ adAccountId: "a", seedSegmentId: "s", name: "abc", countries: ["SA"], retentionDays: 500 }), /1 to 180/);
  assert.throws(() => buildLookalike({ adAccountId: "a", seedSegmentId: "s", name: "abc", countries: ["saudi"] }), /2-letter/);
});
