// 0.6.0: audience size, spend pacing, ad preview, and the ready-made playbooks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adPreview, audienceSizeForSquad, audienceSizeForTargeting, judgeAudience, judgePace, localClock, pacingReport } from "../src/insights.js";
import { PROMPTS } from "../src/prompts.js";

test("audience size: verdicts by size", () => {
  assert.equal(judgeAudience(0, 0).verdict, "UNKNOWN");
  assert.equal(judgeAudience(10_000, 40_000).verdict, "VERY_SMALL");
  assert.equal(judgeAudience(100_000, 250_000).verdict, "SMALL");
  assert.equal(judgeAudience(2_000_000, 3_000_000).verdict, "OK");
  assert.equal(judgeAudience(60_000_000, 80_000_000).verdict, "VERY_BROAD");
});

test("audience size: an ad squad uses GET audience_size_v2; planned targeting POSTs a spec and creates nothing", async () => {
  const calls = [];
  const client = {
    request: async (method, path, opts = {}) => {
      calls.push({ method, path, body: opts.body });
      return { audience_size: { audience_size_minimum: 120_000, audience_size_maximum: 160_000 } };
    },
  };
  const squad = await audienceSizeForSquad(client, "sq1");
  assert.deepEqual(calls[0], { method: "GET", path: "/adsquads/sq1/audience_size_v2", body: undefined });
  assert.equal(squad.verdict, "SMALL");
  const planned = await audienceSizeForTargeting(client, "acc1", { countries: ["SA", "ae"], minAge: 18, gender: "FEMALE", excludeSegmentIds: ["buyers"] });
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].path, "/adaccounts/acc1/audience_size_v2");
  assert.deepEqual(calls[1].body.targeting.geos, [{ country_code: "sa" }, { country_code: "ae" }]);
  assert.deepEqual(calls[1].body.targeting.segments, [{ segment_id: ["buyers"], operation: "EXCLUDE" }]);
  assert.equal(calls[1].body.status, "PAUSED");
  assert.equal(calls.filter((c) => /\/adsquads$|\/campaigns$/.test(c.path)).length, 0, "no create endpoint is called");
  assert.equal(planned.audience_size_max, 160_000);
  await assert.rejects(audienceSizeForTargeting(client, "acc1", { countries: ["usa"] }), /2-letter/);
});

test("pacing: the local clock follows the report offset", () => {
  // 2026-11-14 21:00 UTC is already 2026-11-15 00:00 in +03:00
  const c = localClock(new Date("2026-11-14T21:00:00Z"), "+03:00");
  assert.equal(c.today, "2026-11-15");
  assert.equal(c.todayStart, "2026-11-15T00:00:00+03:00");
  assert.equal(c.tomorrowStart, "2026-11-16T00:00:00+03:00");
  assert.equal(c.monthStart, "2026-11-01T00:00:00+03:00");
  assert.equal(c.daysInMonth, 30);
  assert.equal(c.dayFraction, 0);
});

test("pacing: per-squad verdicts", () => {
  assert.equal(judgePace({ dailyBudget: null, spentToday: 5, dayFraction: 0.5 }).pace, "NO_DAILY_BUDGET");
  assert.equal(judgePace({ dailyBudget: 100, spentToday: 95, dayFraction: 0.5 }).pace, "BUDGET_NEARLY_USED");
  assert.equal(judgePace({ dailyBudget: 100, spentToday: 1, dayFraction: 0.05 }).pace, "TOO_EARLY");
  assert.equal(judgePace({ dailyBudget: 100, spentToday: 80, dayFraction: 0.5 }).pace, "AHEAD");
  assert.equal(judgePace({ dailyBudget: 100, spentToday: 0, dayFraction: 0.5 }).pace, "NOT_SPENDING");
  assert.equal(judgePace({ dailyBudget: 100, spentToday: 20, dayFraction: 0.5 }).pace, "BEHIND");
  assert.equal(judgePace({ dailyBudget: 100, spentToday: 50, dayFraction: 0.5 }).pace, "ON_TRACK");
});

test("pacing report: today per active squad, month to date, projection and the monthly budget", async () => {
  const queries = [];
  const stats = (key, rows) => ({ total_stats: [{ total_stat: { breakdown_stats: { [key]: rows } } }] });
  const client = {
    request: async (_m, path, { query }) => {
      queries.push(query);
      if (query.breakdown === "adsquad") return stats("adsquad", [{ id: "s1", stats: { spend: 80e6 } }, { id: "s2", stats: { spend: 0 } }]);
      return stats("campaign", [{ id: "c1", stats: { spend: 3000e6 } }, { id: "c2", stats: { spend: 500e6 } }]);
    },
    listPaged: async () => ({ items: [{ id: "c1", name: "Main", status: "ACTIVE" }, { id: "c2", name: "Old", status: "PAUSED" }], complete: true }),
    listChildren: async (_e, id) =>
      id === "c1"
        ? [
            { id: "s1", name: "Fast", status: "ACTIVE", daily_budget_micro: 100e6 },
            { id: "s2", name: "Stuck", status: "ACTIVE", daily_budget_micro: 200e6 },
            { id: "s3", name: "Paused", status: "PAUSED", daily_budget_micro: 999e6 },
          ]
        : [],
  };
  // 12:00 local on the 11th of a 30-day month: 10.5 days elapsed
  const r = await pacingReport(client, { adAccountId: "acc1", offset: "+03:00", monthlyBudget: 9000, now: new Date("2026-11-11T09:00:00Z") });
  assert.equal(queries[0].start_time, "2026-11-11T00:00:00+03:00");
  assert.equal(queries[0].end_time, "2026-11-12T00:00:00+03:00");
  assert.equal(queries[1].start_time, "2026-11-01T00:00:00+03:00");
  assert.deepEqual(r.squads.map((s) => [s.adsquad, s.pace]), [["Fast", "AHEAD"], ["Stuck", "NOT_SPENDING"]], "paused squads and campaigns are left out; problems first");
  assert.equal(r.today.spend_so_far, 80);
  assert.equal(r.today.active_daily_budgets_total, 300);
  assert.equal(r.month.month_to_date_spend, 3500);
  assert.equal(r.month.days_elapsed, 10.5);
  assert.equal(r.month.projected_month_spend, 10000);
  assert.equal(r.month.verdict, "OVERSPENDING");
  assert.equal(r.month.daily_spend_to_hit_budget, Math.round((5500 / 19.5) * 100) / 100);
  assert.equal(r.month.most_it_could_spend_this_month, 3500 + 300 * 19.5);
});

test("ad preview: builds the public preview link from Snap's answer, from an ad id too; the Snapcode is optional", async () => {
  const paths = [];
  const client = {
    getEntity: async (entity, id) => (assert.equal(entity, "ad"), { id, creative_id: "cr1" }),
    request: async (_m, path) => {
      paths.push(path);
      if (path.endsWith("/creative_preview")) return { expires_at: "2027-02-12T00:00:00Z", creative_preview_link: "https://adsapi.snapchat.com/media/creative_preview?creative_id=cr1&expires_at=1799&signature=SIG-1" };
      throw new Error("snapcode unavailable");
    },
  };
  const r = await adPreview(client, { adId: "ad1" });
  assert.equal(r.preview_url, "https://ad-preview.snapchat.com/?creative_id=cr1&expires_at=1799&signature=SIG-1");
  assert.equal(r.snapcode_image, undefined);
  assert.deepEqual(paths, ["/creatives/cr1/creative_preview", "/creatives/cr1/snapcode"]);
  await assert.rejects(adPreview(client, {}), /creative_id or ad_id/);
});

test("playbooks are listed by the server and never tell the assistant to apply changes on its own", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { SnapClient } = await import("../src/snap.js");
  const { registerTools } = await import("../src/tools.js");
  const server = new McpServer({ name: "t", version: "1" });
  registerTools(server, new SnapClient({ env: {}, fetchImpl: async () => ({}) }), { SNAP_LOG_FILE: join(mkdtempSync(join(tmpdir(), "p-")), "l.jsonl") });
  const client = new Client({ name: "c", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ["launch_checklist", "replace_tired_ads", "weekly_review"]);
  const tools = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const [name, p] of Object.entries(PROMPTS)) {
    const res = await client.getPrompt({ name, arguments: name === "weekly_review" ? {} : { name_or_id: "X", campaign: "X" } });
    const text = res.messages[0].content.text;
    assert.match(text, /Do not call any tool with confirm=true/, `${name} keeps the approval rule`);
    for (const used of text.match(/snap_[a-z_]+/g)) assert.ok(tools.has(used), `${name} refers to a real tool: ${used}`);
    assert.ok(p.title && p.description);
  }
  await client.close();
});
