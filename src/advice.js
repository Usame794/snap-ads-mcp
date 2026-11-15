// Read-only advice: which hours work, which creatives win, and where budget could move. They only read and suggest. Every
// suggestion names the tool that would apply it, and that tool still previews and waits for approval.
import { breakdownReport } from "./report.js";
import { localClock } from "./insights.js";
import { shiftIso } from "./fatigue.js";

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------- Hourly report ----------

const offsetMsOf = (iso) => {
  const m = String(iso).match(/([+-])(\d{2}):?(\d{2})$/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
};
const ENTITY_BASE = { adaccount: "adaccounts", campaign: "campaigns", adsquad: "adsquads", ad: "ads" };
const DAYPARTS = [["night 0-5", 0, 5], ["morning 6-11", 6, 11], ["afternoon 12-17", 12, 17], ["evening 18-23", 18, 23]];

export function summarizeHours(series, requestedIso) {
  const off = offsetMsOf(requestedIso);
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, spend: 0, purchases: 0, value: 0, impressions: 0 }));
  for (const r of series) {
    const t = Date.parse(r.start_time);
    if (Number.isNaN(t)) continue;
    const h = new Date(t + off).getUTCHours();
    hours[h].spend += (r.stats?.spend ?? 0) / 1e6;
    hours[h].purchases += r.stats?.conversion_purchases ?? 0;
    hours[h].value += (r.stats?.conversion_purchases_value ?? 0) / 1e6;
    hours[h].impressions += r.stats?.impressions ?? 0;
  }
  const row = (o) => ({ ...o, spend: round(o.spend), value: round(o.value), roas: o.spend ? round(o.value / o.spend) : null, cpa: o.purchases ? round(o.spend / o.purchases) : null });
  const rows = hours.map(row);
  const total = rows.reduce((n, r) => n + r.spend, 0);
  const parts = DAYPARTS.map(([label, a, b]) => row(hours.filter((h) => h.hour >= a && h.hour <= b).reduce((n, h) => ({ ...n, spend: n.spend + h.spend, purchases: n.purchases + h.purchases, value: n.value + h.value, impressions: n.impressions + h.impressions }), { label, spend: 0, purchases: 0, value: 0, impressions: 0 })));
  const judged = rows.filter((r) => total > 0 && r.spend >= total * 0.02 && r.roas != null);
  const best = [...judged].sort((a, b) => b.roas - a.roas).slice(0, 3).map((r) => r.hour);
  const worst = [...judged].sort((a, b) => a.roas - b.roas).slice(0, 3).map((r) => r.hour);
  return { total_spend: round(total), by_hour: rows, by_daypart: parts, best_hours: best, worst_hours: worst };
}

export async function hourlyReport(client, { entity = "adaccount", id, offset = "+00:00", days = 7, now = new Date() }) {
  if (!ENTITY_BASE[entity]) throw new Error("entity must be adaccount, campaign, adsquad or ad");
  if (!Number.isInteger(days) || days < 1 || days > 7) throw new Error("days must be a whole number from 1 to 7 (Snap's hourly limit)");
  const end = localClock(now, offset).todayStart;
  const start = shiftIso(end, -days * 86_400_000);
  const data = await client.request("GET", `/${ENTITY_BASE[entity]}/${id}/stats`, { query: { granularity: "HOUR", start_time: start, end_time: end, fields: "spend,impressions,conversion_purchases,conversion_purchases_value", omit_empty: true } });
  const series = data.timeseries_stats?.[0]?.timeseries_stat?.timeseries ?? [];
  const out = summarizeHours(series, start);
  return {
    window: { start_time: start, end_time: end, days },
    ...out,
    note: "Hours are local to SNAP_REPORT_UTC_OFFSET, summed over the days. Purchases are Snap-attributed and arrive late, so the most recent hours can look worse than they are. Seven days is a small sample: use it as a hint. To act on it, snap_set_ad_schedule needs a lifetime-budget ad squad.",
    ...(series.length ? {} : { warning: "Snap returned no hourly data for this window." }),
  };
}

// ---------- Creative comparison ----------

export function classifyAds(rows, { minSpend = 50 }) {
  const judged = rows.filter((r) => r.spend >= minSpend && r.roas != null);
  const med = median(judged.map((r) => r.roas));
  return {
    median_roas: med == null ? null : round(med),
    ads: rows.map((r) => {
      let verdict = "TOO_EARLY";
      if (r.spend >= minSpend) {
        if (med != null && r.roas != null && r.roas >= med * 1.25 && r.purchases >= 3) verdict = "WINNER";
        else if (r.purchases === 0 || (med != null && r.roas != null && r.roas <= med * 0.7)) verdict = "LAGGING";
        else verdict = "NORMAL";
      }
      return { ...r, verdict };
    }),
  };
}

export async function creativeCompare(client, { adAccountId, entity, id, start_time, end_time, minSpend = 50, limit = 30 }) {
  const rep = await breakdownReport(client, { entity, id, start_time, end_time, breakdown: "ad" });
  const creatives = await client.listPaged(`/adaccounts/${adAccountId}/creatives`, "creative");
  const byId = new Map(creatives.items.map((c) => [c.id, c]));
  const { median_roas, ads } = classifyAds(rep.rows, { minSpend });
  const rows = ads.map((a) => {
    const c = byId.get(a.creative_id) ?? {};
    return { ...a, headline: c.headline ?? null, call_to_action: c.call_to_action ?? null, creative_type: c.type ?? null };
  });
  const groups = {};
  for (const r of rows) {
    const key = r.call_to_action ?? "(none)";
    const g = (groups[key] ??= { call_to_action: key, ads: 0, spend: 0, value: 0, purchases: 0 });
    g.ads += 1;
    g.spend += r.spend;
    g.value += r.purchase_value;
    g.purchases += r.purchases;
  }
  const by_call_to_action = Object.values(groups).map((g) => ({ ...g, spend: round(g.spend), value: round(g.value), roas: g.spend ? round(g.value / g.spend) : null })).sort((a, b) => b.spend - a.spend);
  return {
    window: rep.window,
    median_roas,
    min_spend_to_judge: minSpend,
    winners: rows.filter((r) => r.verdict === "WINNER").map((r) => r.name),
    lagging: rows.filter((r) => r.verdict === "LAGGING").map((r) => r.name),
    by_call_to_action,
    ads: rows.slice(0, limit),
    ...(rows.length > limit ? { note: `${rows.length} ads; the ${limit} with most spend are shown.` } : {}),
    basis: rep.basis,
    caution: "Ads that ran in different ad squads reached different audiences, so a winner may owe part of its result to its audience. Look at the headline and call to action as clues, not proof.",
  };
}

// ---------- Budget advice ----------

// Pure: turns per-squad numbers into suggested budget moves that net to zero (or to extra_budget), inside the limits.
export function suggestMoves(squads, { policy, minSpend = 50, shiftUpPct = 20, shiftDownPct = 25, extraBudget = 0 }) {
  const judged = squads.filter((s) => s.spend >= minSpend && s.roas != null && s.daily_budget > 0);
  const med = median(judged.map((s) => s.roas));
  if (med == null || judged.length < 3) return { median_roas: med == null ? null : round(med), decreases: [], increases: [], note: "Fewer than 3 ad squads have enough spend to compare, so no moves are suggested." };
  const decreases = [];
  for (const s of judged.filter((x) => x.roas <= med * 0.6 || x.purchases === 0)) {
    const to = Math.max(policy.minDailyBudget, round(s.daily_budget * (1 - shiftDownPct / 100)));
    if (to < s.daily_budget) decreases.push({ ...s, to, freed: round(s.daily_budget - to), why: s.purchases === 0 ? `Spent ${s.spend} with no purchases.` : `ROAS ${s.roas} is well under the median ${round(med)}.` });
  }
  const pool = decreases.reduce((n, d) => n + d.freed, 0) + extraBudget;
  const candidates = judged.filter((x) => x.roas >= med * 1.25 && x.purchases >= 5).sort((a, b) => b.roas - a.roas);
  const increases = [];
  let left = pool;
  const step = Math.min(shiftUpPct, policy.maxIncreasePct);
  for (const s of candidates) {
    const cap = Math.min(round(s.daily_budget * (1 + step / 100)), policy.maxDailyBudget);
    const add = Math.min(round(cap - s.daily_budget), left);
    if (add >= 1) {
      increases.push({ ...s, to: round(s.daily_budget + add), added: round(add), why: `ROAS ${s.roas} is well above the median ${round(med)} with ${s.purchases} purchases.` });
      left = round(left - add);
    }
  }
  const strip = (x) => ({ adsquad: x.name, adsquad_id: x.id, campaign: x.campaign, spend: x.spend, roas: x.roas, purchases: x.purchases, from: x.daily_budget, to: x.to, why: x.why, apply_with: `snap_set_daily_budget entity=adsquad id=${x.id} daily_budget=${x.to}` });
  return {
    median_roas: round(med),
    decreases: decreases.map(strip),
    increases: increases.map(strip),
    net_daily_budget_change: round(increases.reduce((n, x) => n + x.added, 0) - decreases.reduce((n, x) => n + x.freed, 0)),
    unused_freed_budget: round(left),
  };
}

export async function budgetAdvice(client, { adAccountId, policy, offset = "+00:00", days = 7, minSpend = 50, extraBudget = 0, now = new Date() }) {
  if (!Number.isInteger(days) || days < 3 || days > 28) throw new Error("days must be a whole number from 3 to 28");
  const end = localClock(now, offset).todayStart;
  const start = shiftIso(end, -days * 86_400_000);
  const campaigns = (await client.listPaged(`/adaccounts/${adAccountId}/campaigns`, "campaign")).items.filter((c) => c.status === "ACTIVE");
  const squads = [];
  const failed = [];
  for (const c of campaigns) {
    let rows = {};
    try {
      rows = Object.fromEntries((await breakdownReport(client, { entity: "campaign", id: c.id, breakdown: "adsquad", start_time: start, end_time: end })).rows.map((r) => [r.id, r]));
    } catch (e) {
      failed.push({ campaign: c.name, error: String(e.message).slice(0, 150) });
      continue;
    }
    for (const s of await client.listChildren("campaign", c.id, "adsquad")) {
      if (s.status !== "ACTIVE" || !(s.daily_budget_micro > 0)) continue;
      const r = rows[s.id];
      squads.push({ id: s.id, name: s.name, campaign: c.name, daily_budget: s.daily_budget_micro / 1e6, spend: r?.spend ?? 0, roas: r?.roas ?? null, purchases: r?.purchases ?? 0 });
    }
  }
  return {
    window: { start_time: start, end_time: end, days },
    active_squads_with_a_daily_budget: squads.length,
    ...suggestMoves(squads, { policy, minSpend, extraBudget }),
    ...(failed.length ? { stats_unavailable_for: failed } : {}),
    how_to_use: "Suggestions only; nothing was changed. Each one names the tool that applies it, which previews and waits for your approval, and the money limits still apply. Moving budget resets learning on the ad squads you change, so make a few moves, not all.",
    basis: "Snap-attributed ROAS over the window. It can overstate results: check snap_blended_roas first.",
  };
}
