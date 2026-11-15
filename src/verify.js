// `verify`: runs the read-only tools on a real account, one by one, and prints a short pass/fail list. It exists so that one
// command (instead of asking an AI app about each tool) shows what works on your account, and what does not.
// It only calls tools that declare themselves read-only, and it forces read-only mode on top of that.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "./tools.js";
import { loadPolicy } from "./policy.js";
import { localClock } from "./insights.js";
import { shiftIso } from "./fatigue.js";

const count = (a) => (Array.isArray(a) ? `${a.length} item${a.length === 1 ? "" : "s"}` : null);

// Each check: the tool, its arguments, what it needs from the settings (else it is skipped), and a short summary of the answer.
export function checksFor({ start, end, hasPixel, hasCountry }) {
  return [
    { tool: "snap_ping", args: {}, show: (d) => `authorized as ${d.me?.display_name ?? d.me?.email ?? "your login"}; account ${d.ad_account ? "set" : "NOT set"}` },
    { tool: "snap_list_campaigns", args: { limit: 5 }, show: (d) => count(d) },
    { tool: "snap_list_adsquads", args: { limit: 5 }, show: (d) => count(d) },
    { tool: "snap_list_media", args: { limit: 3 }, show: (d) => count(d) },
    { tool: "snap_list_segments", args: { limit: 3 }, show: (d) => count(d) },
    { tool: "snap_spend_pacing", args: {}, show: (d) => `${d.today?.active_squads ?? "?"} active ad squads; month so far ${d.month?.month_to_date_spend ?? "?"}` },
    { tool: "snap_anomaly_check", args: {}, show: (d) => `verdict ${d.verdict}${d.findings?.length ? ` (${d.findings.length} finding${d.findings.length === 1 ? "" : "s"})` : ""}` },
    { tool: "snap_funnel", args: { days: 7 }, show: (d) => `weakest step: ${d.weakest_step ?? "n/a"}${d.missing_steps?.length ? `; missing events: ${d.missing_steps.join(", ")}` : ""}` },
    { tool: "snap_report_hourly", args: { days: 7 }, show: (d) => `best hours ${JSON.stringify(d.best_hours ?? [])}` },
    { tool: "snap_billing_check", args: {}, show: (d) => `verdict ${d.verdict}; ${d.funding_sources?.length ?? 0} funding source(s)` },
    { tool: "snap_audience_health", args: {}, show: (d) => `${d.audiences} audiences, ${d.with_problems} with problems` },
    { tool: "snap_unused_media", args: { limit: 5 }, show: (d) => `${d.unused_count} of ${d.media_total} files unused` },
    { tool: "snap_budget_advice", args: {}, show: (d) => `${d.active_squads_with_a_daily_budget} squads read; ${d.increases?.length ?? 0} raise, ${d.decreases?.length ?? 0} lower suggested` },
    { tool: "snap_check_landing_pages", args: { max_links: 20 }, show: (d) => `${d.links_checked} link(s) checked, ${d.problems?.length ?? 0} problem(s)` },
    { tool: "snap_health_check", args: { start_time: start, end_time: end }, show: (d) => `${d.active_squads_checked} active ad squads, ${d.squads_with_issues} with issues` },
    { tool: "snap_review_issues", args: {}, show: (d) => `${d.shown ?? d.items?.length ?? 0} ad(s) not approved` },
    { tool: "snap_list_dynamic_templates", args: { limit: 5 }, show: (d) => count(d) },
    { tool: "snap_catalog_feed_status", args: {}, show: (d) => `${d.catalogs} catalog(s), ${d.feeds_with_problems} feed(s) with problems` },
    { tool: "snap_pixel_health", args: {}, needs: hasPixel, setting: "SNAP_PIXEL_ID", show: (d) => `${d.top_priority_issues?.length ?? 0} top-priority issue(s)` },
    { tool: "snap_capi_status", args: {}, needs: hasPixel, setting: "SNAP_PIXEL_ID", show: (d) => `${d.test_events?.event_count_past_hour ?? 0} test events in the last hour` },
    { tool: "snap_audience_size", args: {}, needs: hasCountry, setting: "SNAP_DEFAULT_COUNTRY", show: (d) => `${d.audience_size_min}-${d.audience_size_max} people (${d.verdict})` },
    { tool: "snap_audience_insights", args: {}, needs: hasCountry, setting: "SNAP_DEFAULT_COUNTRY", show: (d) => `${d.groups?.length ?? 0} insight group(s)` },
    { tool: "snap_competitor_ads", args: { advertiser: "Nike", status: "ACTIVE" }, show: (d) => `${d.count} ad(s) returned by the public Ads Gallery` },
    { tool: "snap_portfolio_summary", args: {}, show: (d) => (d.configured === false ? "not configured (optional: SNAP_PORTFOLIO_FILES)" : `${d.accounts?.length ?? 0} account(s)`) },
  ];
}

// Printed output never includes ids or tokens: ids are shortened, long secret-looking strings are hidden.
export const tidy = (s) => String(s).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => `${m.slice(0, 8)}…`).replace(/[A-Za-z0-9._-]{40,}/g, "[hidden]").replace(/\s+/g, " ").slice(0, 220);

export async function runVerify({ client, env = process.env, now = new Date(), log = console.log }) {
  // Everything below runs with writes switched off, whatever the settings say.
  const settings = { ...env, SNAP_READ_ONLY: "1", SNAP_TOOLSETS: "", SNAP_LOG_FILE: env.SNAP_LOG_FILE ?? "" };
  const policy = loadPolicy(settings);
  const server = new McpServer({ name: "verify", version: "1" });
  registerTools(server, client, settings);
  const mcp = new Client({ name: "verify", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const tools = new Map((await mcp.listTools()).tools.map((t) => [t.name, t]));
  const end = localClock(now, policy.reportUtcOffset).todayStart;
  const start = shiftIso(end, -7 * 86_400_000);
  const checks = checksFor({ start, end, hasPixel: Boolean(settings.SNAP_PIXEL_ID), hasCountry: Boolean(settings.SNAP_DEFAULT_COUNTRY) });
  const results = [];
  for (const c of checks) {
    const tool = tools.get(c.tool);
    let row;
    if (!tool) row = { tool: c.tool, status: "SKIP", detail: "tool is not available" };
    else if (tool.annotations?.readOnlyHint !== true) row = { tool: c.tool, status: "SKIP", detail: "not read-only; never called here" };
    else if ("needs" in c && !c.needs) row = { tool: c.tool, status: "SKIP", detail: `needs ${c.setting} in your settings` };
    else {
      try {
        const r = await mcp.callTool({ name: c.tool, arguments: c.args });
        const text = r.content?.[0]?.text ?? "";
        if (r.isError) row = { tool: c.tool, status: "FAIL", detail: tidy(text) };
        else {
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
          let detail = "ok";
          try {
            detail = tidy(c.show(Array.isArray(data) ? data : data ?? {}) ?? "ok");
          } catch {
            detail = "ok";
          }
          row = { tool: c.tool, status: "OK", detail };
        }
      } catch (e) {
        row = { tool: c.tool, status: "FAIL", detail: tidy(e.message) };
      }
    }
    results.push(row);
    log(`  ${row.status === "OK" ? "✓" : row.status === "SKIP" ? "-" : "✗"} ${row.tool.padEnd(28)} ${row.detail}`);
  }
  await mcp.close();
  const failed = results.filter((r) => r.status === "FAIL").length;
  log("");
  log(`${results.filter((r) => r.status === "OK").length} worked, ${failed} failed, ${results.filter((r) => r.status === "SKIP").length} skipped.`);
  log(failed ? "Copy everything above (it contains no tokens and only short ids) and send it to whoever maintains this project." : "Everything read-only worked on this account.");
  return { results, failed };
}
