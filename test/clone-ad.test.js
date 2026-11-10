import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapClient } from "../src/snap.js";
import { executeCloneAd, planCloneAd } from "../src/clone-ad.js";

const src = { id: "a1", name: "Hero", ad_squad_id: "s1", creative_id: "cr1", type: "COLLECTION", render_type: "DYNAMIC", status: "ACTIVE", created_at: "x" };
const sq = (id, name) => ({ squad: { id, name }, existingAds: [] });

test("plan: clones paused, skips own squad and squads that already have the creative", () => {
  const targets = [sq("s1", "own"), sq("s2", "two"), { squad: { id: "s3", name: "three" }, existingAds: [{ creative_id: "cr1" }] }, sq("s4", "four")];
  const p = planCloneAd({ sourceAd: src, targets, newName: "Hero v2" });
  assert.deepEqual(p.toCreate.map((t) => t.squadId), ["s2", "s4"]);
  assert.ok(p.toCreate.every((t) => t.obj.status === "PAUSED" && t.obj.name === "Hero v2" && t.obj.creative_id === "cr1" && t.obj.render_type === "DYNAMIC"));
  assert.equal(p.toCreate[0].obj.ad_squad_id, "s2");
  assert.deepEqual(p.skipped.map((s) => s.squad), ["own", "three"]);
  assert.equal(src.status, "ACTIVE");
});

test("plan: defaults to source name; limits and empty target lists are refused", () => {
  assert.equal(planCloneAd({ sourceAd: src, targets: [sq("s2", "two")] }).toCreate[0].obj.name, "Hero");
  assert.throws(() => planCloneAd({ sourceAd: src, targets: [] }), /at least one/);
  assert.throws(() => planCloneAd({ sourceAd: src, targets: Array.from({ length: 21 }, (_, i) => sq("t" + i, "n")) }), /Too many/);
});

test("execute: creates each ad in its target squad, stops and reports on failure", async () => {
  const posts = [];
  const fetchImpl = async (url, opts = {}) => {
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (String(url).includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    const obj = JSON.parse(opts.body).ads[0];
    posts.push({ url: String(url), obj });
    if (posts.length === 2) return json({ request_status: "ERROR", debug_message: "nope" }, 400);
    return json({ request_status: "SUCCESS", ads: [{ sub_request_status: "SUCCESS", ad: { ...obj, id: "n" + posts.length } }] });
  };
  const client = new SnapClient({ env: { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" }, fetchImpl });
  const plan = planCloneAd({ sourceAd: src, targets: [sq("s2", "two"), sq("s3", "three"), sq("s4", "four")] });
  await assert.rejects(
    () => executeCloneAd({ client, plan, sourceAdId: "a1", logFile: join(mkdtempSync(join(tmpdir(), "k-")), "l.jsonl") }),
    (e) => /nope/.test(e.message) && e.created.length === 1 && e.created[0].adsquad === "two",
  );
  assert.equal(posts.length, 2);
  assert.match(posts[0].url, /\/adsquads\/s2\/ads$/);
  assert.equal("id" in posts[0].obj, false);
});
