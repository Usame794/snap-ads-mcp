// Enable or pause several campaigns / ad squads / ads in one confirmed step.
import { applyChange, planStatus } from "./changes.js";

export const MAX_BULK = 20;
const PARENT = { adsquad: ["campaign", "campaign_id"], ad: ["adsquad", "ad_squad_id"] };

// Reads every item (and its parent's status, so we can warn about no-op enables).
export async function loadBulkItems(client, entity, ids) {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new Error("Provide at least one id");
  if (unique.length > MAX_BULK) throw new Error(`Too many ids (${unique.length}, limit ${MAX_BULK})`);
  const items = [];
  const parentCache = new Map();
  for (const id of unique) {
    const obj = await client.getEntity(entity, id);
    let parent = null;
    if (PARENT[entity]) {
      const [pEntity, key] = PARENT[entity];
      const pid = obj[key];
      if (!parentCache.has(pid)) parentCache.set(pid, await client.getEntity(pEntity, pid));
      parent = parentCache.get(pid);
    }
    items.push({ obj, parent });
  }
  return items;
}

// Pure planner: what would change, what is skipped, and what enabling would actually start.
export function planBulkStatus({ entity, items, status }) {
  if (!["ACTIVE", "PAUSED"].includes(status)) throw new Error("status must be ACTIVE or PAUSED (deleting is not supported)");
  const toChange = [];
  const skipped = [];
  const warnings = [];
  for (const { obj, parent } of items) {
    const label = obj.name ?? obj.id;
    if (obj.status === status) {
      skipped.push({ name: label, reason: `already ${status}` });
      continue;
    }
    toChange.push({ id: obj.id, name: label, from: obj.status, to: status, budget: (obj.daily_budget_micro ?? 0) / 1e6 });
    if (status === "ACTIVE" && parent && parent.status !== "ACTIVE") {
      warnings.push(`"${label}" will be ACTIVE but its ${PARENT[entity][0]} "${parent.name}" is ${parent.status}, so it will not deliver until that is enabled too`);
    }
  }
  const startsSpending =
    status === "ACTIVE" ? items.filter(({ obj, parent }) => obj.status !== "ACTIVE" && (!parent || parent.status === "ACTIVE")).reduce((n, { obj }) => n + (obj.daily_budget_micro ?? 0) / 1e6, 0) : 0;
  return {
    toChange,
    skipped,
    warnings,
    summary: {
      entity,
      target_status: status,
      will_change: toChange,
      skipped,
      warnings,
      daily_budget_that_would_start_delivering: status === "ACTIVE" ? startsSpending : undefined,
    },
  };
}

// Applies one by one. Stops at the first failure and reports exactly what was and was not changed.
export async function executeBulkStatus({ client, entity, plan, status, logFile }) {
  const done = [];
  for (const item of plan.toChange) {
    try {
      const r = await applyChange({ client, entity, id: item.id, confirm: true, plan: (cur) => planStatus(cur, status), logFile });
      done.push({ name: item.name, from: item.from, to: status, verified: r.verified });
      if (!r.verified) throw new Error(`"${item.name}" was sent but could not be verified (${(r.warnings ?? []).join(" ")}) Stopping`);
    } catch (e) {
      const at = plan.toChange.indexOf(item);
      const notAttempted = plan.toChange.slice(at + 1).map((x) => x.name);
      const err = new Error(`${e.message}. Changed so far: ${JSON.stringify(done)}. Failed on: "${item.name}". Not attempted: ${JSON.stringify(notAttempted)}`);
      err.done = done;
      throw err;
    }
  }
  return done;
}
