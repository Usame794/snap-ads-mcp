// What enabling something would really start. Budgets usually live on ad squads, so enabling a campaign starts the budgets
// of its ACTIVE ad squads, and enabling an ad can start its ad squad. Enforces the absolute limits on what one call may start.
const money = (micro) => (micro ?? 0) / 1e6;
const round2 = (n) => Math.round(n * 100) / 100;

// A squad with only a lifetime budget is counted at the pace that budget implies: spread over the days left until its
// end_time, or all of it in one day when it has no end.
export function countedDaily(squad, now = Date.now()) {
  if (squad.daily_budget_micro != null && squad.daily_budget_micro > 0) return money(squad.daily_budget_micro);
  if (squad.lifetime_budget_micro == null) return 0;
  const end = squad.end_time ? Date.parse(squad.end_time) : NaN;
  const start = squad.start_time ? Date.parse(squad.start_time) : NaN;
  const from = Math.max(now, Number.isFinite(start) ? start : now);
  const days = Number.isFinite(end) && end > from ? Math.max(1, Math.ceil((end - from) / 86_400_000)) : 1;
  return round2(money(squad.lifetime_budget_micro) / days);
}

function squadLine(squad, why, now) {
  const lifetimeOnly = !(squad.daily_budget_micro > 0) && squad.lifetime_budget_micro != null;
  return { adsquad_id: squad.id, name: squad.name, daily_budget: money(squad.daily_budget_micro), lifetime_budget: squad.lifetime_budget_micro != null ? money(squad.lifetime_budget_micro) : undefined, ...(lifetimeOnly ? { counted_per_day: countedDaily(squad, now) } : {}), why };
}

const openNow = (start, end, now) => (!start || Date.parse(start) <= now) && (!end || Date.parse(end) > now);

// Does this schedule edit let an ACTIVE item start (or resume) delivering sooner than it would have? Then it is an
// activation in everything but name, and is checked like one.
export function scheduleOpensDelivery(current, patch, now = Date.now()) {
  if (current.status !== "ACTIVE") return false;
  const start = patch.start_time ?? current.start_time;
  const end = "end_time" in patch ? patch.end_time : current.end_time;
  const was = openNow(current.start_time, current.end_time, now);
  const will = openNow(start, end, now);
  const pulledEarlier = Boolean(patch.start_time && current.start_time && Date.parse(current.start_time) > now && Date.parse(patch.start_time) < Date.parse(current.start_time));
  const revived = Boolean(current.end_time && Date.parse(current.end_time) <= now && end && Date.parse(end) > now) || Boolean(current.end_time && Date.parse(current.end_time) <= now && !end);
  return (!was && will) || pulledEarlier || revived;
}

// `items` are the objects about to become ACTIVE (already read). Returns the preview block; throws when over a limit.
export async function activationImpact(client, entity, items, policy, { now = Date.now() } = {}) {
  const line = (squad, why) => squadLine(squad, why, now);
  const started = new Map(); // squad id -> line
  const later = [];
  const campaignCaps = [];
  const campaigns = new Map();
  const campaign = async (id) => {
    if (!campaigns.has(id)) campaigns.set(id, await client.getEntity("campaign", id));
    return campaigns.get(id);
  };
  for (const obj of items) {
    if (entity === "campaign") {
      campaigns.set(obj.id, obj);
      const squads = (await client.listChildren("campaign", obj.id, "adsquad")).filter((s) => s.status === "ACTIVE");
      for (const s of squads) started.set(s.id, line(s, `ACTIVE ad squad of campaign "${obj.name}"`));
      if (obj.daily_budget_micro != null) campaignCaps.push({ campaign_id: obj.id, name: obj.name, campaign_daily_budget: money(obj.daily_budget_micro) });
      if (obj.lifetime_spend_cap_micro != null) campaignCaps.push({ campaign_id: obj.id, name: obj.name, campaign_lifetime_spend_cap: money(obj.lifetime_spend_cap_micro) });
    } else if (entity === "adsquad") {
      const parent = await campaign(obj.campaign_id);
      if (parent.status === "ACTIVE") started.set(obj.id, line(obj, "its campaign is ACTIVE"));
      else later.push({ ...line(obj, `campaign "${parent.name}" is ${parent.status}`), starts: "when the campaign is enabled" });
    } else if (entity === "ad") {
      const squad = await client.getEntity("adsquad", obj.ad_squad_id);
      const parent = await campaign(squad.campaign_id);
      if (squad.status === "ACTIVE" && parent.status === "ACTIVE") {
        const siblings = await client.listChildren("adsquad", squad.id, "ad");
        const alreadyDelivering = siblings.some((a) => a.id !== obj.id && a.status === "ACTIVE");
        if (!alreadyDelivering) started.set(squad.id, line(squad, `ad "${obj.name}" would be its first ACTIVE ad`));
      } else {
        later.push({ ...line(squad, `ad squad is ${squad.status}, campaign is ${parent.status}`), starts: "when its ad squad and campaign are enabled" });
      }
    }
  }
  const lines = [...started.values()];
  const total = round2(lines.reduce((n, l) => n + (l.counted_per_day ?? l.daily_budget), 0));
  const lifetime = round2(lines.reduce((n, l) => n + (l.lifetime_budget ?? 0), 0));
  const over = lines.filter((l) => l.daily_budget > policy.maxDailyBudget);
  if (over.length) {
    throw new Error(`Refusing to enable: ${over.map((l) => `"${l.name}" has a daily budget of ${l.daily_budget}`).join("; ")}, above the absolute limit of ${policy.maxDailyBudget} (SNAP_MAX_DAILY_BUDGET). Lower the budget first, or have the account owner raise the limit.`);
  }
  const overLife = lines.filter((l) => (l.lifetime_budget ?? 0) > policy.maxLifetimeBudget);
  if (overLife.length) {
    throw new Error(`Refusing to enable: ${overLife.map((l) => `"${l.name}" has a lifetime budget of ${l.lifetime_budget}`).join("; ")}, above the limit of ${policy.maxLifetimeBudget} (SNAP_MAX_LIFETIME_BUDGET).`);
  }
  if (total > policy.maxActivationDailyBudget) {
    throw new Error(`Refusing to enable: this would start ${total} of daily budget across ${lines.length} ad squads, above the limit of ${policy.maxActivationDailyBudget} per call (SNAP_MAX_ACTIVATION_DAILY_BUDGET). Enable fewer at a time, or have the account owner raise the limit.`);
  }
  return {
    daily_budget_that_starts_delivering: total,
    lifetime_budget_that_starts_delivering: lifetime || undefined,
    ad_squads_that_start_delivering: lines,
    starts_later: later.length ? later : undefined,
    campaign_level_budgets: campaignCaps.length ? campaignCaps : undefined,
    limit_per_call: policy.maxActivationDailyBudget,
    note: "Amounts are in account currency. Ad squads that are already delivering are not counted. A squad with only a lifetime budget is counted at its pace per day (counted_per_day).",
  };
}
