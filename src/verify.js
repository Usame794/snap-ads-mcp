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

// For `verify --details`: the specifics behind a summary line. Links are shown without their query string (it can carry
// tracking ids); everything goes through tidy() before it is printed.
const where = (u) => {
  try {
    const x = new URL(u);
    let path = x.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // keep the encoded form
    }
    return `${x.hostname}${path.length > 70 ? `${path.slice(0, 70)}...` : path}`;
  } catch {
    return String(u).split("?")[0];
  }
};
export const DETAILS = {
  snap_check_landing_pages: (d) => [...(d.problems ?? []).slice(0, 10), ...(d.could_not_check ?? []).slice(0, 5).map((p) => ({ ...p, verdict: "BLOCKED", detail: "the website answered with a block (it probably refuses automatic checks); open it yourself" }))].map((p) => `${p.verdict}${p.status ? ` ${p.status}` : ""} ${where(p.url)}: ${p.detail ?? ""}${p.missing_params ? ` (missing ${p.missing_params.join(", ")})` : ""}${p.lands_on_other_site ? ` (ends on ${p.lands_on_other_site})` : ""} [${p.ads?.length ?? 0} ad(s), e.g. ${p.ads?.[0]?.ad ?? "?"}]`),
  snap_pixel_health: (d) => (d.top_priority_issues ?? []).slice(0, 10).map((i) => (typeof i === "string" ? i : JSON.stringify(i))),
  snap_catalog_feed_status: (d) => (d.catalogs_detail ?? []).flatMap((c) => c.feeds.filter((f) => f.problems.length || f.upload_errors).map((f) => `${c.catalog} / ${f.name}: ${[...f.problems, ...(f.upload_issues ?? [])].slice(0, 4).join("; ")}`)).slice(0, 10),
  snap_audience_health: (d) => [
    ...(d.important_used_by_active_squads ?? []).slice(0, 10).map((p) => `USED NOW by ${p.used_by_active_squads} active ad squad(s): ${p.name} (${p.source_type}, ${p.size} people): ${p.flags.map((f) => f.code).join(", ")}`),
    ...Object.entries(d.by_flag ?? {}).map(([k, n]) => `${k}: ${n} audience(s)`),
  ],
  snap_review_issues: (d) => (d.items ?? []).slice(0, 10).map((i) => `${i.name}: ${String(i.reasons?.[0] ?? i.review_status ?? "").slice(0, 120)}`),
  snap_health_check: (d) => Object.entries(d.issue_counts ?? {}).map(([k, n]) => `${k}: ${n} ad squad(s)`),
};

// Each check: the tool, its arguments, what it needs from the settings (else it is skipped), and a short summary of the answer.
export function checksFor({ start, end, hasPixel, hasCountry }) {
  return [
    { tool: "snap_ping", args: {}, show: (d) => `authorized as ${d.me?.display_name ?? d.me?.email ?? "your login"}; account ${d.ad_account ? "set" : "NOT set"}` },
    { tool: "snap_list_campaigns", args: { limit: 5 }, show: (d) => count(d) },
    { tool: "snap_list_adsquads", args: { limit: 5 }, show: (d) => count(d) },
    { tool: "snap_list_media", args: { limit: 3 }, show: (d) => count(d) },
    { tool: "snap_list_segments", args: { limit: 3 }, show: (d) => count(d) },
    { tool: "snap_spend_pacing", args: {}, show: (d) => `${d.today?.active_squads ?? "?"} active ad squads; month so far ${d.month?.month_to_date_spend ?? "?"}` },
    { tool: "snap_anomaly_check", args: {}, show: (d) => `verdict ${d.verdict}${d.findings?.length ? ` (${d.findings.map((f) => f.code).join(", ")})` : ""}; ${d.days?.length ?? 0} days read` },
    { tool: "snap_funnel", args: { days: 7 }, show: (d) => `weakest step: ${d.weakest_step ?? "n/a"}${d.missing_steps?.length ? `; missing events: ${d.missing_steps.join(", ")}` : ""}` },
    { tool: "snap_report", args: { view: "hourly", days: 7 }, show: (d) => `best hours ${JSON.stringify(d.best_hours ?? [])}${d.coverage_pct != null ? `; covers ${d.coverage_pct}% of spend (${d.source})` : ""}` },
    { tool: "snap_billing_check", args: {}, show: (d) => `verdict ${d.verdict}; ${d.funding_sources?.length ?? 0} funding source(s)` },
    { tool: "snap_audience_health", args: {}, show: (d) => `${d.audiences} audiences, ${d.with_problems} with problems` },
    { tool: "snap_unused_media", args: { limit: 5 }, show: (d) => `${d.unused_count} of ${d.media_total} files unused${d.warning ? " (list cut: partial)" : ""}` },
    { tool: "snap_budget_advice", args: {}, show: (d) => `${d.active_squads_with_a_daily_budget} squads read, ${d.squads_compared ?? "?"} compared; ${d.increases?.length ?? 0} raise, ${d.decreases?.length ?? 0} lower suggested` },
    { tool: "snap_check_landing_pages", args: { max_links: 20 }, show: (d) => `${d.active_ads} active ads, ${d.links_checked} link(s) checked, ${d.problems?.length ?? 0} problem(s)${d.partial ? " (partial: out of time)" : ""}` },
    { tool: "snap_health_check", args: { start_time: start, end_time: end }, show: (d) => `${d.active_squads_checked} active ad squads, ${d.squads_with_issues} with issues` },
    { tool: "snap_review_issues", args: {}, show: (d) => `${d.shown ?? d.items?.length ?? 0} ad(s) not approved` },
    { tool: "snap_list_dynamic_templates", args: { limit: 5 }, show: (d) => count(d) },
    { tool: "snap_catalog_feed_status", args: {}, show: (d) => `${d.catalogs} catalog(s), ${d.feeds_with_problems} feed(s) with problems${d.feeds_with_problems ? `; e.g. ${d.catalogs_detail.flatMap((c) => c.feeds).find((f) => f.problems.length || f.upload_errors)?.problems?.[0] ?? "upload errors"}` : ""}` },
    { tool: "snap_pixel_health", args: {}, needs: hasPixel, setting: "SNAP_PIXEL_ID", show: (d) => `${d.top_priority_issues?.length ?? 0} top-priority issue(s)` },
    { tool: "snap_capi_status", args: {}, needs: hasPixel, setting: "SNAP_PIXEL_ID", show: (d) => `${d.test_events?.event_count_past_hour ?? 0} test events in the last hour` },
    { tool: "snap_audience_size", args: {}, needs: hasCountry, setting: "SNAP_DEFAULT_COUNTRY", show: (d) => `${d.audience_size_min}-${d.audience_size_max} people (${d.verdict})` },
    { tool: "snap_audience_insights", args: { min_age: 18, max_age: 24, gender: "FEMALE" }, needs: hasCountry, setting: "SNAP_DEFAULT_COUNTRY", show: (d) => `${d.groups?.length ?? 0} insight group(s)${d.groups?.length ? "" : " (none: unexpected for a narrowed targeting)"}` },
    { tool: "snap_competitor_ads", args: { advertiser: "Nike", status: "ACTIVE" }, show: (d) => `${d.count} ad(s) returned by the public Ads Gallery` },
    { tool: "snap_portfolio_summary", args: {}, show: (d) => (d.configured === false ? "not configured (optional: SNAP_PORTFOLIO_FILES)" : `${d.accounts?.length ?? 0} account(s)`) },
  ];
}

// Printed output never includes ids or tokens: ids are shortened, long secret-looking strings are hidden.
export const tidy = (s) => String(s).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => `${m.slice(0, 8)}…`).replace(/[A-Za-z0-9._-]{40,}/g, (m) => (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(m) ? m : "[hidden]")).replace(/\s+/g, " ").slice(0, 220);

export async function runVerify({ client, env = process.env, now = new Date(), log = console.log, details = false }) {
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
        const r = await mcp.callTool({ name: c.tool, arguments: c.args }, undefined, { timeout: 5 * 60_000 });
        const text = r.content?.[0]?.text ?? "";
        // Snap refusing the normal login for the Conversions API test tools is a missing setting, not a fault.
        if (r.isError && c.tool === "snap_competitor_ads" && /429|too many requests/i.test(text)) row = { tool: c.tool, status: "SKIP", detail: "Snap's public Ads Gallery is rate-limited right now; try again in a few minutes" };
        else if (r.isError && c.tool.startsWith("snap_capi_") && /refused the token for the Conversions API/.test(text) && !settings.SNAP_CAPI_TOKEN) row = { tool: c.tool, status: "SKIP", detail: "needs SNAP_CAPI_TOKEN: a Conversions API token from Ads Manager (Events Manager > Conversions API > Generate token). Optional." };
        else if (r.isError) row = { tool: c.tool, status: "FAIL", detail: tidy(text) };
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
          row = { tool: c.tool, status: "OK", detail, ...(details && DETAILS[c.tool] ? { lines: (() => { try { return DETAILS[c.tool](data ?? {}).map(tidy); } catch { return []; } })() } : {}) };
        }
      } catch (e) {
        row = { tool: c.tool, status: "FAIL", detail: tidy(e.message) };
      }
    }
    results.push(row);
    log(`  ${row.status === "OK" ? "✓" : row.status === "SKIP" ? "-" : "✗"} ${row.tool.padEnd(28)} ${row.detail}`);
  }
  if (details) {
    const withLines = results.filter((r) => r.lines?.length);
    log("");
    log("Details");
    if (!withLines.length) log("  (nothing to show)");
    for (const r of withLines) {
      log(`  ${r.tool}`);
      for (const l of r.lines) log(`    - ${l}`);
    }
  }
  await mcp.close();
  const failed = results.filter((r) => r.status === "FAIL").length;
  log("");
  log(`${results.filter((r) => r.status === "OK").length} worked, ${failed} failed, ${results.filter((r) => r.status === "SKIP").length} skipped.`);
  log(failed ? "Copy everything above (it contains no tokens and only short ids) and send it to whoever maintains this project." : "Everything read-only worked on this account.");
  return { results, failed };
}
