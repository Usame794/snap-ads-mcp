// Copying a campaign (with its ad squads and optionally ads). Everything is created PAUSED.
import { logChange } from "./changes.js";

const startIn = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

function retime(obj, start) {
  const o = { ...obj, start_time: start };
  if (o.end_time && new Date(o.end_time) <= new Date(start)) delete o.end_time;
  return o;
}

// Pure function: builds the objects that would be created, without touching the API.
export function planCopy({ campaign, squads, adsBySquad, newName, includeAds = true, budgetScale = 1, now = startIn(10) }) {
  if (!newName || !newName.trim()) throw new Error("new_name is required");
  if (!(budgetScale > 0 && budgetScale <= 2)) throw new Error("budget_scale must be between 0 and 2");
  const newCampaign = retime({ ...campaign, name: newName.trim(), status: "PAUSED" }, now);
  if (newCampaign.daily_budget_micro != null) newCampaign.daily_budget_micro = Math.round(newCampaign.daily_budget_micro * budgetScale);
  const plannedSquads = squads.map((s) => {
    const obj = retime({ ...s, status: "PAUSED" }, now);
    if (obj.daily_budget_micro != null) obj.daily_budget_micro = Math.round(obj.daily_budget_micro * budgetScale);
    const ads = includeAds ? (adsBySquad[s.id] ?? []).map((a) => ({ ...a, status: "PAUSED" })) : [];
    return { sourceId: s.id, obj, ads };
  });
  const totalBudget =
    (newCampaign.daily_budget_micro ?? 0) / 1e6 + plannedSquads.reduce((n, s) => n + (s.obj.daily_budget_micro ?? 0) / 1e6, 0);
  return {
    campaign: newCampaign,
    squads: plannedSquads,
    summary: {
      new_campaign_name: newCampaign.name,
      ad_squads: plannedSquads.map((s) => ({ name: s.obj.name, daily_budget: (s.obj.daily_budget_micro ?? 0) / 1e6, ads: s.ads.length })),
      total_ads: plannedSquads.reduce((n, s) => n + s.ads.length, 0),
      total_daily_budget_if_enabled: totalBudget,
      status_of_everything: "PAUSED",
    },
  };
}

export async function loadSource(client, campaignId, { includeAds = true, maxSquads = 20, maxAds = 100, squadIds } = {}) {
  const campaign = await client.getEntity("campaign", campaignId);
  let squads = await client.listChildren("campaign", campaignId, "adsquad", { return_placement_v2: true });
  if (squadIds?.length) {
    const missing = squadIds.filter((id) => !squads.some((s) => s.id === id));
    if (missing.length) throw new Error(`These ad squads are not in the source campaign: ${missing.join(", ")}`);
    squads = squads.filter((s) => squadIds.includes(s.id));
  }
  if (squads.length > maxSquads) throw new Error(`Campaign has ${squads.length} ad squads (limit ${maxSquads}). Not copying.`);
  const adsBySquad = {};
  let adCount = 0;
  if (includeAds) {
    for (const s of squads) {
      adsBySquad[s.id] = await client.listChildren("adsquad", s.id, "ad");
      adCount += adsBySquad[s.id].length;
    }
    if (adCount > maxAds) throw new Error(`Campaign has ${adCount} ads (limit ${maxAds}). Copy with include_ads=false, or raise the limit.`);
  }
  return { campaign, squads, adsBySquad };
}

// Creates everything. On any failure it stops and reports exactly what was already created (all paused).
export async function executeCopy({ client, plan, sourceCampaignId, logFile, resumeCampaignId }) {
  const created = { campaign: null, adsquads: [], ads: 0 };
  try {
    created.campaign = resumeCampaignId
      ? await client.getEntity("campaign", resumeCampaignId)
      : await client.createEntity("campaign", plan.campaign);
    // When resuming, reuse ad squads that already exist (matched by name) and only add what is missing.
    const existing = resumeCampaignId ? await client.listChildren("campaign", created.campaign.id, "adsquad") : [];
    for (const s of plan.squads) {
      const found = existing.find((x) => x.name === s.obj.name);
      const squad = found ?? (await client.createEntity("adsquad", { ...s.obj, campaign_id: created.campaign.id }));
      created.adsquads.push({ id: squad.id, name: squad.name, reused: Boolean(found) });
      const haveAds = found ? (await client.listChildren("adsquad", squad.id, "ad")).length : 0;
      if (haveAds > 0) continue;
      for (const a of s.ads) {
        await client.createEntity("ad", { ...a, ad_squad_id: squad.id });
        created.ads += 1;
      }
    }
  } catch (e) {
    logChange({ entity: "copy", id: created.campaign?.id ?? null, change: `copy of ${sourceCampaignId} FAILED: ${e.message}`, created }, logFile);
    const err = new Error(`${e.message}. Already created (all PAUSED, delete in Ads Manager if unwanted): ${JSON.stringify(created)}`);
    err.created = created;
    throw err;
  }
  logChange({ entity: "copy", id: created.campaign.id, change: `copied ${sourceCampaignId} -> "${plan.campaign.name}" (${created.adsquads.length} ad squads, ${created.ads} ads, all PAUSED)`, created }, logFile);
  return created;
}

// Copy one ad squad (optionally with its ads) into a campaign. Everything is PAUSED.
export function planCopySquad({ squad, ads = [], newName, budgetScale = 1, now = startIn(10) }) {
  if (!(budgetScale > 0 && budgetScale <= 2)) throw new Error("budget_scale must be between 0 and 2");
  const obj = retime({ ...squad, name: (newName?.trim() || squad.name), status: "PAUSED" }, now);
  if (obj.daily_budget_micro != null) obj.daily_budget_micro = Math.round(obj.daily_budget_micro * budgetScale);
  return {
    obj,
    ads: ads.map((a) => ({ ...a, status: "PAUSED" })),
    summary: { name: obj.name, daily_budget: (obj.daily_budget_micro ?? 0) / 1e6, ads: ads.length, status: "PAUSED" },
  };
}

export async function executeCopySquad({ client, plan, targetCampaignId, sourceSquadId, logFile }) {
  const created = { adsquad: null, ads: 0 };
  try {
    created.adsquad = await client.createEntity("adsquad", { ...plan.obj, campaign_id: targetCampaignId });
    for (const a of plan.ads) {
      await client.createEntity("ad", { ...a, ad_squad_id: created.adsquad.id });
      created.ads += 1;
    }
  } catch (e) {
    logChange({ entity: "copy_adsquad", id: created.adsquad?.id ?? null, change: `copy of ${sourceSquadId} FAILED: ${e.message}`, created }, logFile);
    const err = new Error(`${e.message}. Already created (PAUSED): ${JSON.stringify({ adsquad: created.adsquad?.id, ads: created.ads })}`);
    err.created = created;
    throw err;
  }
  logChange({ entity: "copy_adsquad", id: created.adsquad.id, change: `copied ${sourceSquadId} -> campaign ${targetCampaignId} as "${plan.obj.name}" (${created.ads} ads, PAUSED)`, created }, logFile);
  return created;
}
