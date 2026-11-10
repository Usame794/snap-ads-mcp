// Read-only account audit, review issues, pixel health and period comparison.
import { breakdownReport, summarizeRow } from "./report.js";

async function pages(client, path, entity, { limit = 200, maxPages = 12 } = {}) {
  const out = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const data = await client.request("GET", path, { query: { limit, cursor } });
    for (const row of data[entity] ?? []) out.push(row[entity.slice(0, -1)] ?? row);
    const next = data.paging?.next_link;
    if (!next) break;
    cursor = new URL(next).searchParams.get("cursor");
    if (!cursor) break;
  }
  return out;
}

const hasBuyerExclusion = (squad) =>
  (squad.targeting?.segments ?? []).some((s) => s.operation === "EXCLUDE" && (s.segment_id ?? []).length) || (squad.targeting?.product_audiences ?? []).length > 0;

export function judgeSquad({ squad, campaign, row, thresholds }) {
  const issues = [];
  const spending = Boolean(row && row.spend > 0);
  if (spending && !hasBuyerExclusion(squad)) issues.push({ code: "NO_BUYER_EXCLUSION", detail: `$${row.spend} spent in the window with no excluded audiences and no product-audience (retargeting) rule` });
  if (row) {
    if (row.frequency >= thresholds.maxFrequency) issues.push({ code: "HIGH_FREQUENCY", detail: `frequency ${row.frequency} in the window (limit ${thresholds.maxFrequency})` });
    if (row.spend >= thresholds.minSpend && row.swipe_rate_pct != null && row.swipe_rate_pct < thresholds.minSwipeRatePct) issues.push({ code: "LOW_SWIPE_RATE", detail: `swipe rate ${row.swipe_rate_pct}% on $${row.spend} (floor ${thresholds.minSwipeRatePct}%): results are mostly view-through` });
    if (row.spend >= thresholds.minSpend && (row.roas ?? 0) < thresholds.minRoas) issues.push({ code: "LOW_ROAS", detail: `ROAS ${row.roas} on $${row.spend} (floor ${thresholds.minRoas})` });
    if (row.spend >= thresholds.minSpend && row.purchases === 0) issues.push({ code: "SPEND_NO_PURCHASES", detail: `$${row.spend} spent, 0 purchases` });
  }
  if (squad.status === "ACTIVE" && campaign.status !== "ACTIVE") issues.push({ code: "PARENT_NOT_ACTIVE", detail: `campaign is ${campaign.status}, so this squad cannot deliver` });
  return issues;
}

export async function healthCheck(client, { adAccountId, start_time, end_time, thresholds = {} }) {
  const th = { maxFrequency: 5, minSwipeRatePct: 0.15, minSpend: 100, minRoas: 3, ...thresholds };
  const campaigns = (await pages(client, `/adaccounts/${adAccountId}/campaigns`, "campaigns", { maxPages: 15 })).filter((c) => c.status === "ACTIVE");
  const findings = [];
  let squadsChecked = 0;
  let idle = 0;
  for (const campaign of campaigns) {
    const squads = (await client.listChildren("campaign", campaign.id, "adsquad")).filter((s) => s.status === "ACTIVE");
    if (!squads.length) continue;
    let rows = {};
    try {
      const rep = await breakdownReport(client, { entity: "campaign", id: campaign.id, breakdown: "adsquad", start_time, end_time });
      rows = Object.fromEntries(rep.rows.map((r) => [r.id, r]));
    } catch {
      // stats can fail for odd campaigns; the structural checks still run
    }
    for (const squad of squads) {
      squadsChecked += 1;
      if (!(rows[squad.id]?.spend > 0)) idle += 1;
      const issues = judgeSquad({ squad, campaign, row: rows[squad.id], thresholds: th });
      if (issues.length) findings.push({ campaign: campaign.name, campaign_id: campaign.id, adsquad: squad.name, adsquad_id: squad.id, daily_budget: (squad.daily_budget_micro ?? 0) / 1e6, issues });
    }
  }
  const byCode = {};
  for (const f of findings) for (const i of f.issues) byCode[i.code] = (byCode[i.code] ?? 0) + 1;
  return { window: { start_time, end_time }, thresholds: th, active_campaigns: campaigns.length, active_squads_checked: squadsChecked, active_squads_with_no_spend_in_window: idle, squads_with_issues: findings.length, issue_counts: byCode, findings };
}

// Ads that are not approved, with Snap's reasons, limited to ads whose squad is ACTIVE when onlyActive is set.
export async function reviewIssues(client, { adAccountId, onlyActive = true, maxAds = 2000 }) {
  const ads = (await pages(client, `/adaccounts/${adAccountId}/ads`, "ads", { maxPages: Math.ceil(maxAds / 200) })).filter((a) => a.review_status && a.review_status !== "APPROVED");
  const out = [];
  const squadCache = new Map();
  for (const a of ads) {
    let squad = squadCache.get(a.ad_squad_id);
    if (squad === undefined) {
      try {
        squad = await client.getEntity("adsquad", a.ad_squad_id);
      } catch {
        squad = null;
      }
      squadCache.set(a.ad_squad_id, squad);
    }
    if (onlyActive && (!squad || squad.status !== "ACTIVE")) continue;
    out.push({ ad_id: a.id, name: a.name, ad_status: a.status, review_status: a.review_status, reasons: a.review_status_reasons ?? [], adsquad: squad?.name, adsquad_id: a.ad_squad_id, adsquad_status: squad?.status });
  }
  const counts = ads.reduce((m, a) => ((m[a.review_status] = (m[a.review_status] ?? 0) + 1), m), {});
  return { scanned_non_approved: ads.length, by_status: counts, shown: out.length, only_active_squads: onlyActive, items: out.slice(0, 100) };
}

export async function pixelHealth(client, pixelId) {
  const ready = await client.request("GET", `/pixels/${pixelId}/signal_readiness_scores`);
  const quality = await client.request("GET", `/pixels/${pixelId}/event_quality_scores`);
  const readiness = (ready.signal_readiness_score ?? []).map((r) => r.signal_readiness_score ?? r).map((s) => ({ use_case: s.use_case?.gbb_use_case, source: s.event_source, status: s.readiness_status, spending: s.use_case?.is_spending }));
  const events = (quality.event_quality_scores ?? []).map((r) => r.event_quality_score ?? r).map((e) => ({
    event: e.event_type,
    source: e.event_source,
    action_source: e.action_source,
    recommendations: (e.recommendations ?? []).map((x) => ({ priority: x.priority, score: x.score, title: x.title, detail: String(x.description ?? "").split("\n")[0].slice(0, 160) })).sort((a, b) => String(a.priority).localeCompare(String(b.priority))),
  }));
  const p1 = events.flatMap((e) => e.recommendations.filter((r) => r.priority === "P1").map((r) => `${e.event}/${e.source}: ${r.title}`));
  return { pixel_id: pixelId, readiness, spending_use_cases: readiness.filter((r) => r.spending), events, top_priority_issues: p1 };
}

const pct = (a, b) => (b ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null);

// Two windows side by side, totals or per child. Deltas are "this window vs the earlier one".
export async function compareReport(client, { entity, id, breakdown, current, previous }) {
  const run = async (w) => {
    if (breakdown) return (await breakdownReport(client, { entity, id, breakdown, ...w })).rows;
    const base = { campaign: "campaigns", adsquad: "adsquads", ad: "ads" }[entity];
    if (!base) throw new Error("entity must be campaign, adsquad or ad");
    const data = await client.request("GET", `/${base}/${id}/stats`, { query: { granularity: "TOTAL", ...w, fields: "impressions,spend,swipes,conversion_purchases,conversion_purchases_value,frequency" } });
    return [summarizeRow("total", id, data.total_stats?.[0]?.total_stat?.stats)];
  };
  const [a, b] = [await run(current), await run(previous)];
  const cur = Object.fromEntries(a.map((r) => [r.id, r]));
  const prev = Object.fromEntries(b.map((r) => [r.id, r]));
  // Children that only existed in one of the two windows (stopped or new) must still show up.
  const ids = [...new Set([...a.map((r) => r.id), ...b.map((r) => r.id)])];
  const rows = ids.map((id) => {
    const base = cur[id] ?? prev[id];
    const r = cur[id] ?? summarizeRow(base.name, id, {});
    const p = prev[id] ?? summarizeRow(base.name, id, {});
    return {
      id,
      name: base.name,
      spend: { now: r.spend, before: p.spend, change_pct: pct(r.spend, p.spend) },
      purchases: { now: r.purchases, before: p.purchases, change_pct: pct(r.purchases, p.purchases) },
      roas: { now: r.roas, before: p.roas, change: r.roas != null && p.roas != null ? Math.round((r.roas - p.roas) * 100) / 100 : null },
      cpa: { now: r.cpa, before: p.cpa, change: r.cpa != null && p.cpa != null ? Math.round((r.cpa - p.cpa) * 100) / 100 : null },
      frequency: { now: r.frequency, before: p.frequency },
      swipe_rate_pct: { now: r.swipe_rate_pct, before: p.swipe_rate_pct },
    };
  });
  rows.sort((x, y) => y.spend.now - x.spend.now);
  return { current, previous, rows };
}
