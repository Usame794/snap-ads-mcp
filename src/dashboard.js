// Data for the interactive cards (MCP Apps): an account dashboard and a campaign board. Both only read. The same data is returned as
// text for assistants and apps that cannot show the cards, so nothing depends on the card being displayed.
import { collectBreakdown, dailyReport } from "./report.js";
import { localClock, pacingReport } from "./insights.js";
import { shiftIso } from "./fatigue.js";
import { judgeDays } from "./checks.js";

const r2 = (n) => Math.round(n * 100) / 100;

export async function dashboardData(client, { adAccountId, offset = "+00:00", days = 7, currency = null, now = new Date() }) {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("days must be a whole number from 1 to 30");
  const end = localClock(now, offset).todayStart;
  const start = shiftIso(end, -days * 86_400_000);
  const warnings = [];
  const daily = await dailyReport(client, { entity: "adaccount", id: adAccountId, start_time: start, end_time: end });
  if (daily.warning) warnings.push(daily.warning);
  let pacing = null;
  try {
    const p = await pacingReport(client, { adAccountId, offset, now });
    pacing = {
      spend_today: p.today.spend_so_far,
      active_squads: p.today.active_squads,
      active_daily_budgets_total: p.today.active_daily_budgets_total,
      month_to_date_spend: p.month.month_to_date_spend,
      projected_month_spend: p.month.projected_month_spend,
      most_it_could_spend_this_month: p.month.most_it_could_spend_this_month,
      days_elapsed: p.month.days_elapsed,
      days_in_month: p.month.days_in_month,
    };
    if (p.warning) warnings.push(p.warning);
  } catch (e) {
    warnings.push(`Pacing could not be read (${String(e.message).slice(0, 120)}).`);
  }
  // Alerts from the same daily rows (no extra calls): a spike, a drop, missing purchases. Judged only with 5+ full days.
  let alerts = [];
  if (daily.rows.length >= 5) {
    const j = judgeDays(daily.rows);
    alerts = (j.findings ?? []).map((f) => ({ severity: f.severity, code: f.code, detail: f.detail, day: daily.rows.at(-1)?.date ?? null }));
  }
  const totals = { spend: daily.total_spend, purchases: daily.total_purchases, purchase_value: daily.total_purchase_value, roas: daily.total_roas, cpa: daily.total_cpa, impressions: daily.total_impressions, swipe_rate_pct: daily.total_swipe_rate_pct };
  const cur = currency ? ` ${currency}` : "";
  const summary = `Last ${days} days: spend ${totals.spend}${cur}, ${totals.purchases} purchases, ROAS ${totals.roas ?? "n/a"}, CPA ${totals.cpa ?? "n/a"}${pacing ? `. This month so far ${pacing.month_to_date_spend}${cur}, projected ${pacing.projected_month_spend}${cur}` : ""}.`;
  return {
    summary,
    account: { id: adAccountId, currency },
    range: { start_time: start, end_time: end, days, utc_offset: offset },
    totals,
    daily: daily.rows.map((x) => ({ date: x.date, spend: x.spend, purchases: x.purchases, roas: x.roas })),
    pacing,
    alerts,
    ...(warnings.length ? { warnings } : {}),
  };
}

// One row per campaign (level "campaigns") or per ad squad (level "adsquads"), with spend, ROAS and purchases over the last
// `days` full days and a flag when something needs a look. Read-only: the card's buttons go through the normal tools.
const flagOf = (spend, purchases, roas) => (spend > 0 && !purchases ? "No purchases" : roas != null && roas < 1 && spend > 0 ? "ROAS under 1" : null);

export async function boardData(client, { adAccountId, offset = "+00:00", status = null, limit = 30, currency = null, level = "campaigns", days = 7, now = new Date() }) {
  if (!["campaigns", "adsquads"].includes(level)) throw new Error("level must be campaigns or adsquads");
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("days must be a whole number from 1 to 30");
  const end = localClock(now, offset).todayStart;
  const start = shiftIso(end, -days * 86_400_000);
  const warnings = [];
  const campaigns = (await client.listPaged(`/adaccounts/${adAccountId}/campaigns`, "campaign")).items;
  const byCampaign = new Map(campaigns.map((c) => [c.id, c]));
  const key = level === "adsquads" ? "adsquad" : "campaign";
  let stats = {};
  try {
    const rows = await collectBreakdown(client, `/adaccounts/${adAccountId}/stats`, { granularity: "TOTAL", breakdown: key, start_time: start, end_time: end, fields: "spend,conversion_purchases,conversion_purchases_value" }, key);
    stats = Object.fromEntries(rows.map((x) => [x.id, x.stats ?? {}]));
    if (rows.incomplete) warnings.push("Spend figures are a lower bound (Snap returned more pages than were read).");
  } catch (e) {
    warnings.push(`Spend could not be read (${String(e.message).slice(0, 120)}).`);
  }
  let squads = [];
  try {
    const listed = await client.listPaged(`/adaccounts/${adAccountId}/adsquads`, "adsquad", { maxPages: 4 });
    squads = listed.items;
    if (!listed.complete) warnings.push("Not every ad squad was read; budgets are a lower bound.");
  } catch {
    // The budget column is optional on the campaign level.
    if (level === "adsquads") throw new Error("The ad squads of this account could not be read.");
  }
  const budgets = {};
  for (const s of squads) if (s.status === "ACTIVE" && s.daily_budget_micro > 0) budgets[s.campaign_id] = (budgets[s.campaign_id] ?? 0) + s.daily_budget_micro / 1e6;
  const measure = (id) => {
    const s = stats[id] ?? {};
    const sp = r2((s.spend ?? 0) / 1e6);
    const purchases = s.conversion_purchases ?? 0;
    const roas = sp ? r2((s.conversion_purchases_value ?? 0) / 1e6 / sp) : null;
    return { spend: sp, purchases, roas, flag: flagOf(sp, purchases, roas) };
  };
  const source = level === "adsquads"
    ? squads.map((s) => {
        const c = byCampaign.get(s.campaign_id);
        const m = measure(s.id);
        return { id: s.id, entity: "adsquad", name: s.name, status: s.status, campaign_id: s.campaign_id, campaign_name: c?.name ?? null, campaign_status: c?.status ?? null, daily_budget: s.daily_budget_micro > 0 ? r2(s.daily_budget_micro / 1e6) : null, lifetime_budget: s.lifetime_budget_micro > 0 ? r2(s.lifetime_budget_micro / 1e6) : null, spend: m.spend, purchases: m.purchases, roas: m.roas, flag: m.flag, spend_7d: m.spend, roas_7d: m.roas };
      })
    : campaigns.map((c) => {
        const m = measure(c.id);
        return { id: c.id, entity: "campaign", name: c.name, status: c.status, active_daily_budget: budgets[c.id] != null ? r2(budgets[c.id]) : null, campaign_daily_budget: c.daily_budget_micro > 0 ? r2(c.daily_budget_micro / 1e6) : null, spend: m.spend, purchases: m.purchases, roas: m.roas, flag: m.flag, spend_7d: m.spend, roas_7d: m.roas };
      });
  const rows = source.filter((x) => !status || x.status === status).sort((a, b) => (a.status === b.status ? b.spend - a.spend : a.status === "ACTIVE" ? -1 : 1));
  const shown = rows.slice(0, limit);
  const cur = currency ? ` ${currency}` : "";
  const noun = level === "adsquads" ? "ad squads" : "campaigns";
  return {
    summary: `${rows.length} ${noun} (${rows.filter((x) => x.status === "ACTIVE").length} active). Spend is for the last ${days} days${cur}.${rows.some((x) => x.flag) ? ` ${rows.filter((x) => x.flag).length} need a look.` : ""}`,
    account: { id: adAccountId, currency },
    level,
    range: { start_time: start, end_time: end, days },
    items: shown,
    campaigns: level === "campaigns" ? shown : undefined,
    total: rows.length,
    total_campaigns: level === "campaigns" ? rows.length : undefined,
    has_more: rows.length > limit,
    ...(warnings.length ? { warnings } : {}),
  };
}
