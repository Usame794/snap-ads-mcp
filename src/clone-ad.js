// Cloning an existing ad into other ad squads. New ads are always created PAUSED.
import { logChange } from "./changes.js";

export const MAX_TARGETS = 20;

// Pure planner. `targets` is [{ squad, existingAds }]. Squads that already hold an ad with the same creative are skipped.
export function planCloneAd({ sourceAd, targets, newName, sourceSquad }) {
  if (!targets.length) throw new Error("Provide at least one target ad squad");
  if (targets.length > MAX_TARGETS) throw new Error(`Too many target ad squads (${targets.length}, limit ${MAX_TARGETS})`);
  const toCreate = [];
  const skipped = [];
  for (const { squad, existingAds } of targets) {
    if (squad.id === sourceAd.ad_squad_id) {
      skipped.push({ squad: squad.name, reason: "this is the ad's own ad squad" });
      continue;
    }
    const srcSet = sourceSquad?.product_properties?.product_set_id;
    const dstSet = squad.product_properties?.product_set_id;
    if (srcSet && dstSet && srcSet !== dstSet) {
      skipped.push({ squad: squad.name, reason: "different product set (Snap rejects a creative whose product set differs from the ad squad's)" });
      continue;
    }
    if (existingAds.some((a) => a.creative_id === sourceAd.creative_id)) {
      skipped.push({ squad: squad.name, reason: "already has an ad with this creative" });
      continue;
    }
    toCreate.push({ squadId: squad.id, squadName: squad.name, obj: { ...sourceAd, name: newName?.trim() || sourceAd.name, ad_squad_id: squad.id, status: "PAUSED" } });
  }
  return {
    toCreate,
    skipped,
    summary: {
      source_ad: sourceAd.name,
      creative_id: sourceAd.creative_id,
      ad_type: sourceAd.type,
      render_type: sourceAd.render_type,
      will_create_in: toCreate.map((t) => t.squadName),
      skipped,
      status_of_new_ads: "PAUSED",
    },
  };
}

export async function loadTargets(client, squadIds) {
  const targets = [];
  for (const id of squadIds) {
    const squad = await client.getEntity("adsquad", id);
    const existingAds = await client.listChildren("adsquad", id, "ad");
    targets.push({ squad, existingAds });
  }
  return targets;
}

export async function executeCloneAd({ client, plan, sourceAdId, logFile }) {
  const created = [];
  try {
    for (const t of plan.toCreate) {
      const ad = await client.createEntity("ad", t.obj);
      created.push({ id: ad.id, adsquad: t.squadName });
    }
  } catch (e) {
    logChange({ entity: "clone_ad", id: sourceAdId, change: `clone FAILED after ${created.length}: ${e.message}`, created }, logFile);
    const err = new Error(`${e.message}. Already created (all PAUSED): ${JSON.stringify(created)}`);
    err.created = created;
    throw err;
  }
  logChange({ entity: "clone_ad", id: sourceAdId, change: `cloned into ${created.length} ad squads (PAUSED)`, created }, logFile);
  return created;
}
