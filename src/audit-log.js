// Structured audit trail for every mutating tool call, written to the same JSON-lines file as the change log.
// An "intent" record is written BEFORE anything is sent; if that write fails, the operation does not run.
import { appendFileSync, readFileSync } from "node:fs";
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

function append(file, record) {
  appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
}

// Throws when the record cannot be written: the caller must then NOT perform the operation.
export function auditIntent(file, { tool, account, targets = [], params, preview }) {
  const event_id = randomUUID();
  try {
    append(file, { at: new Date().toISOString(), kind: "audit", phase: "intent", event_id, tool, account: account ?? null, target_ids: targets, params: redact(params), expected: redact(preview) });
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
    process.stderr.write(`[snap-ads-mcp] AUDIT LOG WRITE FAILED after ${tool} (${ok ? "ok" : "failed"}), event ${event_id}: ${e.code ?? e.message}\n`);
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

// Value a field had at the start of the last 24 hours, taken from the earliest logged change of that entity in the window.
// Returns null when this server logged no change of that field in the window. Values are in micro-currency as logged.
export function windowStartMicro(file, id, field, { now = Date.now(), windowMs = 86_400_000 } = {}) {
  const since = now - windowMs;
  for (const e of readLogStrict(file)) {
    if (e.id !== id || !e.before || typeof e.before[field] !== "number") continue;
    const at = Date.parse(e.at);
    if (Number.isFinite(at) && at >= since && at <= now + 60_000) return e.before[field];
  }
  return null;
}
