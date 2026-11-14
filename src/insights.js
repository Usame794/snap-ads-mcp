// Read-only helpers added in 0.6.0: audience size before launch, spend pacing, and ad previews. None of them changes anything.
import { buildTargeting } from "./create.js";
import { collectBreakdown } from "./report.js";
import { shiftIso } from "./fatigue.js";

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ---------- Audience size ----------

// Snap's own reach estimate. Snap says an estimate is not a promise of delivery.
export function judgeAudience(min, max) {
  if (!(max > 0)) return { verdict: "UNKNOWN", note: "Snap returned no estimate for this targeting." };
  if (max < 50_000) return { verdict: "VERY_SMALL", note: "Under 50,000 people: delivery will likely be slow and costly. Widen the targeting." };
  if (max < 300_000) return { verdict: "SMALL", note: "Under 300,000 people: fine for retargeting, narrow for prospecting." };
  if (min > 50_000_000) return { verdict: "VERY_BROAD", note: "Very broad: fine with purchase optimization; check the countries are the ones you mean." };
  return { verdict: "OK", note: "A workable size." };
}

const sizeOf = (data) => {
  const a = data.audience_size ?? {};
  const min = Number(a.audience_size_minimum ?? a.audience_size ?? 0);
  const max = Number(a.audience_size_maximum ?? a.audience_size ?? 0);
  return { audience_size_min: min, audience_size_max: max, ...judgeAudience(min, max) };
};

export async function audienceSizeForSquad(client, adSquadId) {
  const data = await client.request("GET", `/adsquads/${adSquadId}/audience_size_v2`);
  return { source: "ad squad", adsquad_id: adSquadId, ...sizeOf(data) };
}

// For targeting that does not exist yet. Nothing is created: Snap only evaluates the spec.
export async function audienceSizeForTargeting(client, adAccountId, spec) {
  const targeting = buildTargeting(spec);
  const body = {
    name: "Audience size check (not created)",
    status: "PAUSED",
    type: "SNAP_ADS",
    targeting,
    placement_v2: { config: "AUTOMATIC" },
    billing_event: "IMPRESSION",
    optimization_goal: "SWIPES",
    auto_bid: true,
    delivery_constraint: "DAILY_BUDGET",
    daily_budget_micro: 20_000_000,
  };
  const data = await client.request("POST", `/adaccounts/${adAccountId}/audience_size_v2`, { body });
  return { source: "targeting", targeting, ...sizeOf(data) };
}

// ---------- Spend pacing ----------

const offsetMs = (offset) => (offset[0] === "-" ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4))) * 60_000;

// Local calendar facts for `now` in the report offset: today's midnight, tomorrow's, the 1st of the month, and how far along we are.
export function localClock(now, offset) {
  const local = new Date(now.getTime() + offsetMs(offset));
  const ymd = local.toISOString().slice(0, 10);
  const [y, m] = ymd.split("-").map(Number);
  const todayStart = `${ymd}T00:00:00${offset}`;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dayOfMonth = Number(ymd.slice(8, 10));
  const dayFraction = (local.getUTCHours() * 60 + local.getUTCMinutes()) / 1440;
  return {
    today: ymd,
    todayStart,
    tomorrowStart: shiftIso(todayStart, 86_400_000),
    monthStart: `${ymd.slice(0, 8)}01T00:00:00${offset}`,
    daysInMonth,
    dayOfMonth,
    dayFraction,
    monthElapsedDays: dayOfMonth - 1 + dayFraction,
  };
}

// How one ad squad is pacing today. Early in the day almost nothing has spent, so nothing is judged before 3 hours.
export function judgePace({ dailyBudget, spentToday, dayFraction }) {
  if (!(dailyBudget > 0)) return { pace: "NO_DAILY_BUDGET", note: "Lifetime budget or no budget: not judged per day." };
  const used = spentToday / dailyBudget;
  if (used >= 0.9) return { pace: "BUDGET_NEARLY_USED", note: `${Math.round(used * 100)}% of today's budget already spent; it may stop delivering before the day ends.` };
  if (dayFraction < 0.125) return { pace: "TOO_EARLY", note: "Less than 3 hours into the day." };
  const expected = dailyBudget * dayFraction;
  if (spentToday > expected * 1.3) return { pace: "AHEAD", note: `Spending faster than the day: ${round(spentToday)} spent vs ${round(expected)} expected by now.` };
  if (spentToday < expected * 0.5) return { pace: spentToday === 0 ? "NOT_SPENDING" : "BEHIND", note: `${round(spentToday)} spent vs ${round(expected)} expected by now: under-delivering (small audience, low bid, or creative/review issues).` };
  return { pace: "ON_TRACK", note: "Spending in line with the time of day." };
}

export async function pacingReport(client, { adAccountId, offset = "+00:00", monthlyBudget, now = new Date() }) {
  const clock = localClock(now, offset);
  const fields = "spend";
  const today = await collectBreakdown(client, `/adaccounts/${adAccountId}/stats`, { granularity: "TOTAL", breakdown: "adsquad", start_time: clock.todayStart, end_time: clock.tomorrowStart, fields, omit_empty: true }, "adsquad");
  const month = await collectBreakdown(client, `/adaccounts/${adAccountId}/stats`, { granularity: "TOTAL", breakdown: "campaign", start_time: clock.monthStart, end_time: clock.tomorrowStart, fields, omit_empty: true }, "campaign");
  const spendToday = Object.fromEntries(today.map((r) => [r.id, (r.stats?.spend ?? 0) / 1e6]));
  const monthToDate = month.reduce((n, r) => n + (r.stats?.spend ?? 0) / 1e6, 0);

  // Active ad squads under active campaigns: what can still spend today.
  const campaigns = (await client.listPaged(`/adaccounts/${adAccountId}/campaigns`, "campaign")).items.filter((c) => c.status === "ACTIVE");
  const squads = [];
  for (const c of campaigns) {
    for (const s of await client.listChildren("campaign", c.id, "adsquad")) {
      if (s.status !== "ACTIVE") continue;
      const dailyBudget = s.daily_budget_micro != null ? s.daily_budget_micro / 1e6 : null;
      const spentToday = round(spendToday[s.id] ?? 0);
      squads.push({ adsquad: s.name, adsquad_id: s.id, campaign: c.name, daily_budget: dailyBudget, spent_today: spentToday, ...judgePace({ dailyBudget, spentToday, dayFraction: clock.dayFraction }) });
    }
  }
  const order = ["BUDGET_NEARLY_USED", "AHEAD", "NOT_SPENDING", "BEHIND", "ON_TRACK", "TOO_EARLY", "NO_DAILY_BUDGET"];
  squads.sort((a, b) => order.indexOf(a.pace) - order.indexOf(b.pace) || (b.daily_budget ?? 0) - (a.daily_budget ?? 0));
  const activeDaily = squads.reduce((n, s) => n + (s.daily_budget ?? 0), 0);
  const projected = clock.monthElapsedDays > 0 ? (monthToDate / clock.monthElapsedDays) * clock.daysInMonth : 0;
  const remainingDays = clock.daysInMonth - clock.monthElapsedDays;
  const monthOut = {
    month_to_date_spend: round(monthToDate),
    days_elapsed: round(clock.monthElapsedDays, 1),
    days_in_month: clock.daysInMonth,
    projected_month_spend: round(projected),
    most_it_could_spend_this_month: round(monthToDate + activeDaily * remainingDays),
    note: "Projection = spend so far / days elapsed x days in the month. The maximum assumes every active ad squad spends its full daily budget every remaining day.",
  };
  if (monthlyBudget > 0) {
    const diff = projected - monthlyBudget;
    monthOut.monthly_budget = monthlyBudget;
    monthOut.projected_vs_budget_pct = round((diff / monthlyBudget) * 100, 1);
    monthOut.verdict = Math.abs(diff) <= monthlyBudget * 0.05 ? "ON_TRACK" : diff > 0 ? "OVERSPENDING" : "UNDERSPENDING";
    monthOut.daily_spend_to_hit_budget = remainingDays > 0 ? round(Math.max(0, monthlyBudget - monthToDate) / remainingDays) : null;
  }
  const counts = {};
  for (const s of squads) counts[s.pace] = (counts[s.pace] ?? 0) + 1;
  return {
    local_time: { date: clock.today, day_elapsed_pct: round(clock.dayFraction * 100, 1), utc_offset: offset },
    today: { spend_so_far: round(Object.values(spendToday).reduce((a, b) => a + b, 0)), active_daily_budgets_total: round(activeDaily), active_squads: squads.length, by_pace: counts },
    month: monthOut,
    ...(today.incomplete || month.incomplete ? { warning: "Snap returned more pages than were read; spend figures are a lower bound." } : {}),
    squads,
    basis: "Spend as reported by Snap now; today's figure can lag by a few hours.",
  };
}

// ---------- Ad preview ----------

// A link anyone can open (no login) for 90 days, plus a Snapcode to scan on a phone for 7 days.
export async function adPreview(client, { creativeId, adId }) {
  let cid = creativeId;
  if (!cid && adId) {
    const ad = await client.getEntity("ad", adId);
    cid = ad.creative_id;
    if (!cid) throw new Error(`Ad ${adId} has no creative_id`);
  }
  if (!cid) throw new Error("Give creative_id or ad_id");
  const data = await client.request("GET", `/creatives/${cid}/creative_preview`);
  const link = data.creative_preview_link;
  if (!link) throw new Error("Snap returned no preview for this creative.");
  const q = new URL(link).searchParams;
  const preview = new URL("https://ad-preview.snapchat.com/");
  preview.search = new URLSearchParams({ creative_id: q.get("creative_id") ?? cid, expires_at: q.get("expires_at") ?? "", signature: q.get("signature") ?? "" }).toString();
  const out = { creative_id: cid, preview_url: preview.toString(), preview_expires_at: data.expires_at ?? null, note: "Anyone with this link can see the ad (no login) until it expires. Share it only with people who should." };
  try {
    const code = await client.request("GET", `/creatives/${cid}/snapcode`);
    if (code.snapcode_link) Object.assign(out, { snapcode_image: code.snapcode_link, snapcode_expires_at: code.expires_at ?? null, snapcode_note: "Scan it with the Snapchat camera to see the ad on a phone (7 days)." });
  } catch {
    // The Snapcode is a bonus; the preview link is enough.
  }
  return out;
}
