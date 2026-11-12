// Guarded delete. Only paused things with no spend in the last 30 days, and only when the caller types the exact name.
import { logChange } from "./changes.js";

const DELETABLE = ["campaign", "adsquad", "ad", "segment"];
const BASE = { campaign: "campaigns", adsquad: "adsquads", ad: "ads", segment: "segments" };
const iso = (d) => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000).toISOString();

async function spendLast30Days(client, entity, id, now) {
  if (entity === "segment") return 0;
  const data = await client.request("GET", `/${BASE[entity]}/${id}/stats`, { query: { granularity: "TOTAL", start_time: iso(new Date(now - 30 * 86_400_000)), end_time: iso(now), fields: "spend" } });
  return (data.total_stats?.[0]?.total_stat?.stats?.spend ?? 0) / 1e6;
}

// Ad squads of the account that target (include or exclude) this audience. The list must be complete, or it is an error:
// deleting an exclusion audience that live ad squads rely on silently changes who they reach.
async function squadsUsingSegment(client, adAccountId, segmentId) {
  if (!adAccountId) throw new Error("Cannot tell which ad account this audience belongs to; refusing to delete it.");
  const using = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const data = await client.request("GET", `/adaccounts/${adAccountId}/adsquads`, { query: { limit: 500, cursor } });
    for (const row of data.adsquads ?? []) {
      const s = row.adsquad ?? row;
      const hit = (s.targeting?.segments ?? []).find((g) => (g.segment_id ?? []).map(String).includes(String(segmentId)));
      if (hit) using.push({ id: s.id, name: s.name, status: s.status, operation: hit.operation ?? "INCLUDE" });
    }
    const next = data.paging?.next_link;
    if (!next) return using;
    const nextCursor = new URL(next).searchParams.get("cursor");
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  throw new Error("Could not read every ad squad of the account, so it is unknown whether this audience is in use; refusing to delete it.");
}

export async function planDelete(client, { entity, id, confirmName, now = new Date() }) {
  if (!DELETABLE.includes(entity)) throw new Error(`entity must be one of ${DELETABLE.join(", ")}`);
  const obj = await client.getEntity(entity, id);
  const blockers = [];
  if (entity !== "segment" && obj.status !== "PAUSED") blockers.push(`it is ${obj.status}; pause it first`);
  const spend = await spendLast30Days(client, entity, id, now);
  if (spend > 0) blockers.push(`it spent $${Math.round(spend * 100) / 100} in the last 30 days`);
  let children = null;
  if (entity === "campaign") {
    const squads = await client.listChildren("campaign", id, "adsquad");
    const active = squads.filter((s) => s.status === "ACTIVE");
    if (active.length) blockers.push(`${active.length} of its ad squads are ACTIVE`);
    children = { adsquads: squads.length };
  } else if (entity === "adsquad") {
    children = { ads: (await client.listChildren("adsquad", id, "ad")).length };
  }
  let usedBy;
  if (entity === "segment") {
    usedBy = await squadsUsingSegment(client, obj.ad_account_id, id);
    const live = usedBy.filter((s) => s.status === "ACTIVE");
    if (live.length) blockers.push(`${live.length} ACTIVE ad squad(s) target it (${live.slice(0, 5).map((s) => `"${s.name}" ${s.operation}`).join(", ")}); remove it from their targeting first`);
  }
  const nameOk = confirmName !== undefined && String(confirmName) === String(obj.name);
  return {
    obj,
    blockers,
    nameOk,
    summary: { entity, id, name: obj.name, status: obj.status, spend_last_30_days: Math.round(spend * 100) / 100, will_also_remove: children, blocked_because: blockers, confirm_name_matches: confirmName === undefined ? "not given" : nameOk, ...(usedBy ? { used_by_ad_squads: usedBy.length, used_by: usedBy.slice(0, 20) } : {}), warning: entity === "segment" && usedBy?.length ? "Paused ad squads still reference this audience; their targeting will change if they are enabled later." : undefined },
  };
}

export async function executeDelete({ client, entity, id, plan, logFile }) {
  if (plan.blockers.length) throw new Error(`Refusing to delete: ${plan.blockers.join("; ")}`);
  if (!plan.nameOk) throw new Error("confirm_name must be exactly the name of the item (copy it from the preview)");
  await client.request("DELETE", `/${BASE[entity]}/${id}`);
  logChange({ entity: "delete", id, name: plan.obj.name, change: `deleted ${entity} "${plan.obj.name}"`, snapshot: { type: entity, status: plan.obj.status, parent: plan.obj.campaign_id ?? plan.obj.ad_squad_id ?? plan.obj.ad_account_id } }, logFile);
  return { deleted: true, entity, id, name: plan.obj.name };
}
