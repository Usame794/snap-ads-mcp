// Data for the interactive cards (MCP Apps): an account dashboard and a campaign board. Both only read. The same data is returned as
// text for assistants and apps that cannot show the cards, so nothing depends on the card being displayed.
import { collectBreakdown, dailyReport } from "./report.js";
import { localClock, pacingReport } from "./insights.js";
import { shiftIso } from "./fatigue.js";

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
    ...(warnings.length ? { warnings } : {}),
  };
}

export async function boardData(client, { adAccountId, offset = "+00:00", status = null, limit = 30, currency = null, now = new Date() }) {
  const end = localClock(now, offset).todayStart;
  const start = shiftIso(end, -7 * 86_400_000);
  const warnings = [];
  const campaigns = (await client.listPaged(`/adaccounts/${adAccountId}/campaigns`, "campaign")).items;
  let spend = {};
  try {
    const rows = await collectBreakdown(client, `/adaccounts/${adAccountId}/stats`, { granularity: "TOTAL", breakdown: "campaign", start_time: start, end_time: end, fields: "spend,conversion_purchases_value" }, "campaign");
    spend = Object.fromEntries(rows.map((x) => [x.id, x.stats ?? {}]));
    if (rows.incomplete) warnings.push("Spend figures are a lower bound (Snap returned more pages than were read).");
  } catch (e) {
    warnings.push(`Spend could not be read (${String(e.message).slice(0, 120)}).`);
  }
  const budgets = {};
  try {
    for (const s of (await client.listPaged(`/adaccounts/${adAccountId}/adsquads`, "adsquad", { maxPages: 4 })).items) {
      if (s.status === "ACTIVE" && s.daily_budget_micro > 0) budgets[s.campaign_id] = (budgets[s.campaign_id] ?? 0) + s.daily_budget_micro / 1e6;
    }
  } catch {
    // The budget column is optional.
  }
  const rows = campaigns
    .filter((c) => !status || c.status === status)
    .map((c) => {
      const s = spend[c.id] ?? {};
      const sp = (s.spend ?? 0) / 1e6;
      return { id: c.id, name: c.name, status: c.status, spend_7d: r2(sp), roas_7d: sp ? r2((s.conversion_purchases_value ?? 0) / 1e6 / sp) : null, active_daily_budget: budgets[c.id] != null ? r2(budgets[c.id]) : null };
    })
    .sort((a, b) => (a.status === b.status ? b.spend_7d - a.spend_7d : a.status === "ACTIVE" ? -1 : 1));
  const shown = rows.slice(0, limit);
  const cur = currency ? ` ${currency}` : "";
  return {
    summary: `${rows.length} campaigns (${rows.filter((x) => x.status === "ACTIVE").length} active). Spend is for the last 7 days${cur}.`,
    account: { id: adAccountId, currency },
    range: { start_time: start, end_time: end, days: 7 },
    campaigns: shown,
    total_campaigns: rows.length,
    has_more: rows.length > limit,
    ...(warnings.length ? { warnings } : {}),
  };
}
