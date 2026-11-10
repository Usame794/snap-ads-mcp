import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapClient } from "../src/snap.js";
import { fatigueReport, judgeFatigue, shiftIso } from "../src/fatigue.js";

const env = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };
const row = (o) => ({ spend: { now: 200, before: 200 }, roas: { now: 8, before: 8 }, frequency: { now: 2, before: 2 }, swipe_rate_pct: { now: 3, before: 3 }, ...o });

test("shiftIso keeps the offset and local midnight", () => {
  assert.equal(shiftIso("2026-10-27T00:00:00+03:00", -7 * 86_400_000), "2026-10-20T00:00:00+03:00");
  assert.equal(shiftIso("2026-10-27T00:00:00Z", -86_400_000), "2026-10-26T00:00:00Z");
  assert.equal(shiftIso("2026-10-27T00:00:00-05:00", -14 * 86_400_000), "2026-10-13T00:00:00-05:00");
  assert.throws(() => shiftIso("2026-10-27T00:00:00", 1), /offset/);
});

test("fatigue verdicts", () => {
  const v = (o, min) => judgeFatigue(row(o), { minSpend: min }).status;
  assert.equal(v({}), "HEALTHY");
  assert.equal(v({ roas: { now: 5, before: 8 }, frequency: { now: 3, before: 2 } }), "FATIGUED", "ROAS -37% and frequency up");
  assert.equal(v({ roas: { now: 5, before: 8 }, swipe_rate_pct: { now: 1.5, before: 3 } }), "FATIGUED", "ROAS -37% and swipe rate halved");
  assert.equal(v({ roas: { now: 5, before: 8 } }), "WATCH", "ROAS down 37% but nothing else moved");
  assert.equal(v({ roas: { now: 6.2, before: 8 } }), "WATCH", "ROAS down 22%");
  assert.equal(v({ roas: { now: 7, before: 8 } }), "HEALTHY", "ROAS down 12%");
  assert.equal(v({ spend: { now: 0, before: 300 } }), "STOPPED");
  assert.equal(v({ spend: { now: 120, before: 0 } }), "NEW");
  assert.equal(v({ spend: { now: 20, before: 300 } }), "LOW_SPEND");
  assert.equal(v({ roas: { now: 4, before: 8 }, frequency: { now: 3, before: 2 }, spend: { now: 30, before: 30 } }, 10), "FATIGUED", "min spend is configurable");
});

test("fatigue report: windows, ordering and the replace list", async () => {
  const stat = (spend, p, v, imp, sw, freq) => ({ spend: spend * 1e6, conversion_purchases: p, conversion_purchases_value: v * 1e6, impressions: imp, swipes: sw, frequency: freq });
  const seen = [];
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (String(url).includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    const path = u.pathname.replace(/^\/v1/, "");
    if (path === "/campaigns/c/stats") {
      seen.push(u.searchParams.get("start_time"));
      const now = u.searchParams.get("start_time").startsWith("2026-10-20");
      const rows = now
        ? [{ id: "tired", stats: stat(300, 20, 1500, 10000, 50, 4) }, { id: "ok", stats: stat(400, 50, 3200, 10000, 300, 2) }, { id: "gone", stats: stat(0, 0, 0, 0, 0, 0) }]
        : [{ id: "tired", stats: stat(300, 40, 3000, 10000, 300, 2) }, { id: "ok", stats: stat(400, 50, 3100, 10000, 300, 2) }, { id: "gone", stats: stat(250, 20, 1500, 10000, 100, 2) }];
      return json({ total_stats: [{ total_stat: { breakdown_stats: { ad: rows } } }] });
    }
    if (path === "/campaigns/c/ads") return json({ ads: [{ sub_request_status: "SUCCESS", ad: { id: "tired", name: "Tired ad", creative_id: "c1" } }, { sub_request_status: "SUCCESS", ad: { id: "ok", name: "Good ad", creative_id: "c2" } }, { sub_request_status: "SUCCESS", ad: { id: "gone", name: "Old ad", creative_id: "c3" } }] });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const client = new SnapClient({ env, fetchImpl });
  const r = await fatigueReport(client, { entity: "campaign", id: "c", end_time: "2026-10-27T00:00:00+03:00", days: 7 });
  assert.equal(r.window.current.start_time, "2026-10-20T00:00:00+03:00");
  assert.equal(r.window.previous.start_time, "2026-10-13T00:00:00+03:00");
  assert.deepEqual(r.items.map((i) => [i.name, i.status]), [["Tired ad", "FATIGUED"], ["Old ad", "STOPPED"], ["Good ad", "HEALTHY"]]);
  assert.deepEqual(r.replace_first, ["tired"]);
  assert.deepEqual(r.counts, { FATIGUED: 1, STOPPED: 1, HEALTHY: 1 });
  await assert.rejects(() => fatigueReport(client, { entity: "ad", id: "x", end_time: "2026-10-27T00:00:00+03:00" }), /campaign or adsquad/);
});

import { collectBreakdown } from "../src/report.js";

test("breakdown stats follow every page (cursor), not just the first", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (String(url).includes("access_token")) return json({ access_token: "t", expires_in: 1800 });
    const cursor = u.searchParams.get("cursor");
    seen.push(cursor);
    const page = (rows, next) => ({ total_stats: [{ total_stat: { breakdown_stats: { campaign: rows }, ...(next ? { paging: { next_link: `https://adsapi.snapchat.com/v1/adaccounts/a/stats?cursor=${next}` } } : {}) } }] });
    if (!cursor) return json(page([{ id: "1" }, { id: "2" }], "c2"));
    if (cursor === "c2") return json(page([{ id: "3" }], "c3"));
    return json(page([{ id: "4" }]));
  };
  const client = new SnapClient({ env, fetchImpl });
  const rows = await collectBreakdown(client, "/adaccounts/a/stats", { granularity: "TOTAL" }, "campaign");
  assert.deepEqual(rows.map((r) => r.id), ["1", "2", "3", "4"]);
  assert.deepEqual(seen, [null, "c2", "c3"]);
});
