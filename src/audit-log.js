// Structured audit trail for every mutating tool call, written to the same JSON-lines file as the change log.
// An "intent" record is written BEFORE anything is sent; if that write fails, the operation does not run.
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";

const SECRET_KEY = /secret|token|password|authorization|cookie|credential/i;
const AD_CODE = /adcode_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{8})([0-9a-f]{4})/gi;
const BEARER = /Bearer\s+[A-Za-z0-9._~+\/=-]{8,}/g;

const scrub = (s) => s.replace(AD_CODE, (_m, _a, last) => `adcode_…${last}`).replace(BEARER, "Bearer [redacted]");

// Deep copy with credentials removed and single-use ad codes masked. Long strings are cut.
export function redact(value, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = scrub(value);
    return s.length > 2000 ? `${s.slice(0, 2000)}…(${s.length} chars)` : s;
  }
  if (depth > 8) return "[too deep]";
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1)]));
  }
  return String(value);
}

// Everything this process recorded, per log file, kept in memory as well. Safety decisions read the file AND this copy,
// so deleting or truncating the file while the server runs does not reset the 24-hour limits.
// Only the last 24 hours matter for the limits, so older records are dropped (25 h, to cover clock skew).
const SESSION = new Map();
const KEEP_MS = 25 * 3_600_000;
export function remember(file, record) {
  if (!SESSION.has(file)) SESSION.set(file, []);
  const list = SESSION.get(file);
  list.push(record);
  const cutoff = Date.now() - KEEP_MS;
  while (list.length && (Date.parse(list[0].at) || 0) < cutoff) list.shift();
}
const keyOf = (e) => `${e.at}|${e.event_id ?? e.id ?? ""}|${e.phase ?? ""}|${e.change ?? ""}`;

function append(file, record) {
  remember(file, record);
  appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
}

// Throws when the record cannot be written: the caller must then NOT perform the operation.
export function auditIntent(file, { tool, account, targets = [], params, preview, addedDailyBudget = 0 }) {
  const event_id = randomUUID();
  try {
    append(file, { at: new Date().toISOString(), kind: "audit", phase: "intent", event_id, tool, account: account ?? null, target_ids: targets, ...(addedDailyBudget > 0 ? { added_daily_budget: addedDailyBudget } : {}), params: redact(params), expected: redact(preview) });
  } catch (e) {
    throw new Error(`Audit log is not writable (${e.code ?? e.message}); refusing to run ${tool}. Nothing was sent to Snap.`);
  }
  return event_id;
}

// Never throws: the operation already happened. Returns whether the outcome was recorded.
export function auditResult(file, { event_id, tool, account, targets = [], ok, result, error }) {
  try {
    append(file, { at: new Date().toISOString(), kind: "audit", phase: "result", event_id, tool, account: account ?? null, target_ids: targets, status: ok ? "ok" : "failed", ...(ok ? { result: redact(result) } : { error: redact(String(error)) }) });
    return { logged: true };
  } catch (e) {
    process.stderr.write(`[ads-mcp-for-snapchat] AUDIT LOG WRITE FAILED after ${tool} (${ok ? "ok" : "failed"}), event ${event_id}: ${e.code ?? e.message}\n`);
    return { logged: false, error: String(e.code ?? e.message) };
  }
}

// Strict reader for safety decisions: a missing file is an empty log, anything else unreadable is an error.
export function readLogStrict(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw new Error(`Change log cannot be read (${e.code ?? e.message}); refusing changes that depend on it.`);
  }
  return text.split("\n").filter((l) => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`Change log line ${i + 1} is damaged; refusing changes that depend on it. Move the file aside (keep it) and retry.`);
    }
  });
}

// The log as safety decisions see it: the file plus anything this process recorded that is no longer in the file, oldest first.
// The parsed log, re-read only when the file changed (size or modification time). A bulk edit of 20 items then parses the
// file once instead of once per item.
const PARSED = new Map();
function readLogCached(file) {
  let st;
  try {
    st = statSync(file);
  } catch (e) {
    if (e.code === "ENOENT") {
      PARSED.delete(file);
      return [];
    }
    throw new Error(`Change log cannot be read (${e.code ?? e.message}); refusing changes that depend on it.`);
  }
  const hit = PARSED.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.entries;
  const entries = readLogStrict(file);
  PARSED.set(file, { size: st.size, mtimeMs: st.mtimeMs, entries });
  return entries;
}

export function safetyEntries(file) {
  const fromFile = readLogCached(file);
  const seen = new Set(fromFile.map(keyOf));
  const missing = (SESSION.get(file) ?? []).filter((e) => !seen.has(keyOf(e)));
  if (!missing.length) return fromFile;
  return [...fromFile, ...missing].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
}

const inWindow = (e, now, windowMs) => {
  const at = Date.parse(e.at);
  return Number.isFinite(at) && at >= now - windowMs && at <= now + 60_000;
};

// Value a field had at the start of the last 24 hours, taken from the earliest logged change of that entity in the window.
// Returns null when this server logged no change of that field in the window. Values are in micro-currency as logged.
export function windowStartMicro(file, id, field, { now = Date.now(), windowMs = 86_400_000 } = {}) {
  for (const e of safetyEntries(file)) {
    if (e.id !== id || !e.before || typeof e.before[field] !== "number") continue;
    if (inWindow(e, now, windowMs)) return e.before[field];
  }
  return null;
}

// Daily budget this server already added to the account in the last 24 hours (budgets it started plus budget increases),
// summed from the intent records. An intent counts even if its execution failed: part of it may have been applied.
export function addedDailyBudgetInWindow(file, { now = Date.now(), windowMs = 86_400_000 } = {}) {
  let total = 0;
  for (const e of safetyEntries(file)) {
    if (e.kind === "audit" && e.phase === "intent" && typeof e.added_daily_budget === "number" && e.added_daily_budget > 0 && inWindow(e, now, windowMs)) total += e.added_daily_budget;
  }
  return Math.round(total * 100) / 100;
}
