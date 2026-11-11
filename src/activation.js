// What enabling something would really start. Budgets usually live on ad squads, so enabling a campaign starts the budgets
// of its ACTIVE ad squads, and enabling an ad can start its ad squad. Enforces the absolute limits on what one call may start.
const money = (micro) => (micro ?? 0) / 1e6;
const round2 = (n) => Math.round(n * 100) / 100;

function squadLine(squad, why) {
  return { adsquad_id: squad.id, name: squad.name, daily_budget: money(squad.daily_budget_micro), lifetime_budget: squad.lifetime_budget_micro != null ? money(squad.lifetime_budget_micro) : undefined, why };
}

// `items` are the objects about to become ACTIVE (already read). Returns the preview block; throws when over a limit.
export async function activationImpact(client, entity, items, policy) {
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
      for (const s of squads) started.set(s.id, squadLine(s, `ACTIVE ad squad of campaign "${obj.name}"`));
      if (obj.daily_budget_micro != null) campaignCaps.push({ campaign_id: obj.id, name: obj.name, campaign_daily_budget: money(obj.daily_budget_micro) });
      if (obj.lifetime_spend_cap_micro != null) campaignCaps.push({ campaign_id: obj.id, name: obj.name, campaign_lifetime_spend_cap: money(obj.lifetime_spend_cap_micro) });
    } else if (entity === "adsquad") {
      const parent = await campaign(obj.campaign_id);
      if (parent.status === "ACTIVE") started.set(obj.id, squadLine(obj, "its campaign is ACTIVE"));
      else later.push({ ...squadLine(obj, `campaign "${parent.name}" is ${parent.status}`), starts: "when the campaign is enabled" });
    } else if (entity === "ad") {
      const squad = await client.getEntity("adsquad", obj.ad_squad_id);
      const parent = await campaign(squad.campaign_id);
      if (squad.status === "ACTIVE" && parent.status === "ACTIVE") {
        const siblings = await client.listChildren("adsquad", squad.id, "ad");
        const alreadyDelivering = siblings.some((a) => a.id !== obj.id && a.status === "ACTIVE");
        if (!alreadyDelivering) started.set(squad.id, squadLine(squad, `ad "${obj.name}" would be its first ACTIVE ad`));
      } else {
        later.push({ ...squadLine(squad, `ad squad is ${squad.status}, campaign is ${parent.status}`), starts: "when its ad squad and campaign are enabled" });
      }
    }
  }
  const lines = [...started.values()];
  const total = round2(lines.reduce((n, l) => n + l.daily_budget, 0));
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
    note: "Amounts are in account currency. Ad squads that are already delivering are not counted.",
  };
}
