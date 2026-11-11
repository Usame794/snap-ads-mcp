// Apply one kind of edit to many ad squads (or campaigns/ads) with a per-item preview. Stops at the first failure.
import { applyChange, planBudget, planExcludeSegments, planRename, planSchedule } from "./changes.js";
import { MAX_BULK } from "./bulk.js";

// Reads every item and plans its change. Returns the items (with the objects read) so the caller can bind an approval to them.
export async function prepareBulkEdit({ client, entity, ids, buildPlan }) {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new Error("Provide at least one id");
  if (unique.length > MAX_BULK) throw new Error(`Too many ids (${unique.length}, limit ${MAX_BULK})`);
  const items = [];
  for (const id of unique) {
    const cur = await client.getEntity(entity, id);
    try {
      const plan = buildPlan(cur);
      items.push({ id, name: cur.name, change: plan.summary, ok: true, current: cur });
    } catch (e) {
      items.push({ id, name: cur.name, skip: e.message, ok: false, current: cur });
    }
  }
  const will = items.filter((i) => i.ok);
  const skipped = items.filter((i) => !i.ok).map((i) => ({ id: i.id, name: i.name, reason: i.skip }));
  const preview = { applied: false, dry_run: true, will_change: will.map(({ id, name, change }) => ({ id, name, change })), skipped, note: "Nothing was changed. Re-run with confirm=true to apply (stops at the first failure)." };
  return { items, will, skipped, preview };
}

export async function executeBulkEdit({ client, entity, prepared, buildPlan, logFile }) {
  const { will, skipped } = prepared;
  if (!will.length) return { applied: false, note: "Nothing to change.", skipped };
  const done = [];
  for (const item of will) {
    try {
      const r = await applyChange({ client, entity, id: item.id, confirm: true, plan: buildPlan, logFile });
      done.push({ name: item.name, change: r.change, verified: r.verified });
      if (!r.verified) throw new Error(`"${item.name}" was sent but could not be verified (${(r.warnings ?? []).join(" ")}) Stopping`);
    } catch (e) {
      const notAttempted = will.slice(will.indexOf(item) + 1).map((x) => x.name);
      const err = new Error(`${e.message}. Changed so far: ${JSON.stringify(done)}. Failed on: "${item.name}". Not attempted: ${JSON.stringify(notAttempted)}`);
      err.done = done;
      throw err;
    }
  }
  return { applied: true, changed: done, skipped };
}

// Preview or apply in one call. Used by tests and scripts; the MCP tools use prepare/execute with an approval.
export async function bulkEdit({ client, entity, ids, buildPlan, confirm, logFile }) {
  const prepared = await prepareBulkEdit({ client, entity, ids, buildPlan });
  if (!confirm) return prepared.preview;
  return executeBulkEdit({ client, entity, prepared, buildPlan, logFile });
}

export const plans = {
  exclude: (segmentIds) => (cur) => planExcludeSegments(cur, segmentIds),
  budgetSet: (value, env, opts) => (cur) => planBudget(cur, value, env, opts),
  budgetScale: (factor, env, opts) => (cur) => {
    if (cur.daily_budget_micro == null) throw new Error("no daily_budget_micro");
    if (!(Number.isFinite(factor) && factor > 0)) throw new Error("scale value must be a positive number");
    return planBudget(cur, Math.round((cur.daily_budget_micro / 1e6) * factor * 100) / 100, env, opts);
  },
  schedule: (o) => (cur) => planSchedule(cur, o),
  rename: (find, replace) => (cur) => {
    if (!find) throw new Error("find is required");
    if (!String(cur.name).includes(find)) throw new Error(`name does not contain "${find}"`);
    return planRename(cur, String(cur.name).split(find).join(replace ?? ""));
  },
};
