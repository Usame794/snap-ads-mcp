// Planning, guarding and logging of write operations.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.js";

export const LOG_FILE = join(ROOT, "changes.log.jsonl");

const micro = (n) => Math.round(n * 1_000_000);
const unmicro = (m) => m / 1_000_000;

export function limits(env = process.env) {
  return {
    maxIncreasePct: Number(env.SNAP_MAX_BUDGET_INCREASE_PCT ?? 100),
    minDailyBudget: Number(env.SNAP_MIN_DAILY_BUDGET ?? 5),
  };
}

// Each planner returns { patch, summary } or throws when the change is not allowed.
export function planStatus(current, status) {
  if (!["ACTIVE", "PAUSED"].includes(status)) throw new Error("status must be ACTIVE or PAUSED (deleting is not supported)");
  if (current.status === status) throw new Error(`Already ${status}; nothing to change`);
  return { patch: { status }, summary: `status ${current.status} -> ${status}` };
}

export function planBudget(current, dailyBudget, env = process.env) {
  const { maxIncreasePct, minDailyBudget } = limits(env);
  if (current.daily_budget_micro == null) {
    throw new Error("This entity has no daily_budget_micro (budget may be set on the campaign, or it uses a lifetime budget). Not changing it.");
  }
  if (!(dailyBudget >= minDailyBudget)) throw new Error(`Daily budget must be at least ${minDailyBudget} (account currency)`);
  const before = unmicro(current.daily_budget_micro);
  const incPct = ((dailyBudget - before) / before) * 100;
  if (incPct > maxIncreasePct) {
    throw new Error(`Refusing a ${incPct.toFixed(0)}% increase (limit ${maxIncreasePct}%). Raise in smaller steps or change SNAP_MAX_BUDGET_INCREASE_PCT.`);
  }
  if (dailyBudget === before) throw new Error("Budget is already that value");
  return {
    patch: { daily_budget_micro: micro(dailyBudget) },
    summary: `daily budget ${before} -> ${dailyBudget} (${incPct >= 0 ? "+" : ""}${incPct.toFixed(0)}%)`,
  };
}

export function planExcludeSegments(current, segmentIds) {
  if (!segmentIds.length) throw new Error("Provide at least one segment id");
  const targeting = structuredClone(current.targeting ?? {});
  const segments = targeting.segments ?? [];
  const already = new Set(segments.filter((s) => s.operation === "EXCLUDE").flatMap((s) => s.segment_id ?? []));
  const toAdd = segmentIds.filter((id) => !already.has(id));
  if (!toAdd.length) throw new Error("All given segments are already excluded on this ad squad");
  segments.push({ segment_id: toAdd, operation: "EXCLUDE" });
  targeting.segments = segments;
  return { patch: { targeting }, summary: `exclude segments ${toAdd.join(", ")}` };
}

export function planRename(current, newName) {
  const n = String(newName ?? "").trim();
  if (n.length < 3) throw new Error("New name must be at least 3 characters");
  if (n === current.name) throw new Error("Name is already that value");
  return { patch: { name: n }, summary: `rename "${current.name}" -> "${n}"` };
}

// Only for ad squads that use a max bid (bid_micro). Increases are capped; auto-bid squads are refused.
export function planBid(current, bid, env = process.env) {
  const maxIncreasePct = Number(env.SNAP_MAX_BID_INCREASE_PCT ?? 50);
  if (current.bid_micro == null) throw new Error("This ad squad has no bid_micro (it uses auto-bid). Not changing it.");
  if (!(bid > 0)) throw new Error("bid must be greater than 0");
  const before = unmicro(current.bid_micro);
  const incPct = ((bid - before) / before) * 100;
  if (incPct > maxIncreasePct) throw new Error(`Refusing a ${incPct.toFixed(0)}% bid increase (limit ${maxIncreasePct}%). Raise in smaller steps.`);
  if (bid === before) throw new Error("Bid is already that value");
  return { patch: { bid_micro: micro(bid) }, summary: `max bid ${before} -> ${bid} (${incPct >= 0 ? "+" : ""}${incPct.toFixed(0)}%)` };
}

const GENDERS = ["MALE", "FEMALE", "OTHER"];

const OS_TYPES = ["iOS", "ANDROID"];

// Edits one targeting dimension at a time and keeps everything else (segments, exclusions, expansion options).
export function planTargeting(current, o) {
  const { countries, minAge, maxAge, gender, interests, clearInterests, osType, clearDevices, includeSegments, removeExclusions } = o;
  const touched = [countries, minAge, maxAge, gender, interests, clearInterests, osType, clearDevices, includeSegments, removeExclusions].some((x) => x != null && x !== false && !(Array.isArray(x) && !x.length));
  if (!touched) throw new Error("Give at least one change: countries, min_age, max_age, gender, interests, clear_interests, os_type, clear_devices, include_segments or remove_exclusions");
  const targeting = structuredClone(current.targeting ?? {});
  const parts = [];
  if (countries) {
    const list = countries.map((c) => String(c).trim().toLowerCase());
    if (!list.length || list.some((c) => !/^[a-z]{2}$/.test(c))) throw new Error("countries must be 2-letter codes, e.g. [\"sa\", \"ae\"]");
    targeting.geos = list.map((country_code) => ({ country_code }));
    parts.push(`countries ${list.join(",")}`);
  }
  if (minAge != null || maxAge != null || gender) {
    if (gender && !GENDERS.includes(gender)) throw new Error(`gender must be one of ${GENDERS.join(", ")}`);
    for (const a of [minAge, maxAge]) if (a != null && !(Number.isInteger(a) && a >= 13 && a <= 50)) throw new Error("ages must be whole numbers between 13 and 50");
    if (minAge != null && maxAge != null && maxAge < minAge) throw new Error("max_age must be at least min_age");
    const existing = (targeting.demographics ?? [])[0] ?? {};
    const demo = { ...existing, operation: existing.operation ?? "INCLUDE" };
    if (minAge != null) demo.min_age = String(minAge);
    if (maxAge != null) demo.max_age = String(maxAge);
    if (gender) demo.gender = gender;
    targeting.demographics = [demo, ...(targeting.demographics ?? []).slice(1)];
    parts.push(`age/gender ${[demo.min_age && "min " + demo.min_age, demo.max_age && "max " + demo.max_age, demo.gender].filter(Boolean).join(" ")}`);
  }
  if (clearInterests && interests?.length) throw new Error("Use either interests or clear_interests, not both");
  if (clearInterests) {
    delete targeting.interests;
    parts.push("interests cleared");
  } else if (interests?.length) {
    if (interests.some((i) => !/^[A-Z]{2,4}_\d+$/.test(i))) throw new Error("interest ids look like SLC_11 (use snap_targeting_options to find them)");
    targeting.interests = [{ category_id: interests, operation: "INCLUDE" }];
    parts.push(`interests ${interests.join(",")}`);
  }
  if (clearDevices && osType) throw new Error("Use either os_type or clear_devices, not both");
  if (clearDevices) {
    delete targeting.devices;
    parts.push("device targeting cleared");
  } else if (osType) {
    if (!OS_TYPES.includes(osType)) throw new Error(`os_type must be one of ${OS_TYPES.join(", ")}`);
    targeting.devices = [{ os_type: osType, operation: "INCLUDE" }];
    parts.push(`devices ${osType} only`);
  }
  if (includeSegments?.length) {
    const segs = targeting.segments ?? [];
    const have = new Set(segs.filter((s) => (s.operation ?? "INCLUDE") === "INCLUDE").flatMap((s) => s.segment_id ?? []));
    const add = includeSegments.filter((id) => !have.has(id));
    if (!add.length) throw new Error("All given segments are already included on this ad squad");
    segs.push({ segment_id: add, operation: "INCLUDE" });
    targeting.segments = segs;
    parts.push(`include segments ${add.join(",")}`);
  }
  if (removeExclusions?.length) {
    const rm = new Set(removeExclusions);
    let removed = 0;
    targeting.segments = (targeting.segments ?? [])
      .map((s) => {
        if (s.operation !== "EXCLUDE") return s;
        const keep = (s.segment_id ?? []).filter((id) => !rm.has(id));
        removed += (s.segment_id ?? []).length - keep.length;
        return { ...s, segment_id: keep };
      })
      .filter((s) => s.operation !== "EXCLUDE" || s.segment_id.length);
    if (!removed) throw new Error("None of those segments are excluded on this ad squad");
    if (!targeting.segments.length) delete targeting.segments;
    parts.push(`removed ${removed} exclusion(s)`);
  }
  return { patch: { targeting }, summary: `targeting: ${parts.join("; ")}` };
}

export function planSchedule(current, { startTime, endTime }, now = new Date()) {
  if (!startTime && !endTime) throw new Error("Give start_time and/or end_time");
  const patch = {};
  const start = startTime ? new Date(startTime) : null;
  const end = endTime ? new Date(endTime) : null;
  if ((start && isNaN(start)) || (end && isNaN(end))) throw new Error("Times must be ISO date-times, e.g. 2026-11-01T00:00:00+03:00");
  if (start) patch.start_time = start.toISOString();
  if (end) {
    if (end <= now) throw new Error("end_time must be in the future");
    patch.end_time = end.toISOString();
  }
  const effStart = start ?? (current.start_time ? new Date(current.start_time) : null);
  if (end && effStart && end <= effStart) throw new Error("end_time must be after start_time");
  return { patch, summary: `schedule: ${Object.entries(patch).map(([k, v]) => `${k} ${current[k] ?? "-"} -> ${v}`).join("; ")}` };
}

export function logChange(entry, file = LOG_FILE) {
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

export function readLog(limit = 20, file = LOG_FILE) {
  try {
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// True when everything in `patch` is present in `actual`. Objects: patch keys must match recursively; arrays: every patch
// element must match some element of the actual array. Extra fields or reordering in `actual` are fine.
export function containsDeep(actual, patch) {
  if (patch === null || typeof patch !== "object") return JSON.stringify(actual) === JSON.stringify(patch);
  if (Array.isArray(patch)) return Array.isArray(actual) && patch.every((p) => actual.some((a) => containsDeep(a, p)));
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(patch).every(([k, v]) => containsDeep(actual[k], v));
}

const canonical = (x) => JSON.stringify(x, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

// Runs a planned change. Without confirm it only previews; with confirm it sends the update and re-reads to verify.
export async function applyChange({ client, entity, id, plan, confirm, logFile, logExtra }) {
  const current = await client.getEntity(entity, id);
  const { patch, summary } = plan(current);
  const label = `${entity} ${id} (${current.name ?? "unnamed"})`;
  if (!confirm) {
    return { applied: false, dry_run: true, target: label, change: summary, note: "Nothing was sent. Re-run with confirm=true to apply." };
  }
  const updated = await client.updateEntity(entity, { ...current, ...patch });
  const after = await client.getEntity(entity, id);
  const verified = Object.keys(patch).every((k) => containsDeep(after[k], patch[k]));
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, current[k] === undefined ? null : current[k]]));
  const afterState = Object.fromEntries(Object.keys(patch).map((k) => [k, after[k] === undefined ? null : after[k]]));
  logChange({ entity, id, name: current.name, change: summary, verified, patch, before, after: afterState, ...(logExtra ?? {}) }, logFile);
  return { applied: true, target: label, change: summary, verified, returned_status: updated?.status ?? after.status };
}

// Undo support: only entries that recorded `before` can be reverted, and only if nothing changed the fields since.
export function undoableEntries(file = LOG_FILE) {
  const log = readLog(5000, file);
  const undone = new Set(log.filter((e) => e.undoes).map((e) => e.undoes));
  return log.filter((e) => e.before && e.patch && e.id && e.entity && e.verified !== false && !e.undoes && !undone.has(e.at) && !String(e.change).startsWith("undo:"));
}

export function planUndo(entry, current, { force = false } = {}) {
  const keys = Object.keys(entry.patch);
  if (!force) {
    const moved = keys.filter((k) => {
      // Best check: the field must still equal what Snap returned right after this edit.
      if (entry.after && k in entry.after) return canonical(current[k]) !== canonical(entry.after[k]);
      // Older log entries have no snapshot: scalars can be compared exactly, objects cannot be trusted.
      if (typeof entry.patch[k] !== "object") return canonical(current[k]) !== canonical(entry.patch[k]);
      return true;
    });
    if (moved.length) throw new Error(`${moved.join(", ")} was changed again after this edit (or cannot be checked), so undoing it could overwrite newer work. Use force=true only if that is what you want.`);
  }
  const missing = keys.filter((k) => entry.before[k] === null || entry.before[k] === undefined);
  if (missing.length) throw new Error(`${missing.join(", ")} did not exist before this edit, so it cannot be undone automatically`);
  const patch = Object.fromEntries(keys.map((k) => [k, entry.before[k]]));
  return { patch, summary: `undo: ${entry.change}` };
}
