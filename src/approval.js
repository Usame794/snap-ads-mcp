// Preview-then-execute approvals. A preview hands out a single-use token bound to the exact tool, account, parameters and
// the state of the targets at preview time. Executing needs that token; anything stale, changed, reused or expired is refused.
// NOTE: this proves "this exact change was previewed and nothing moved since". It does NOT prove a human looked at it:
// the AI client sees the token. Human authorization is the MCP client's permission prompt (or SNAP_HUMAN_APPROVAL=elicit).
import { createHash, randomBytes } from "node:crypto";

const canonical = (x) =>
  JSON.stringify(x, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v === undefined ? null : v));

export const digest = (x) => createHash("sha256").update(canonical(x)).digest("hex");

// Fields Snap works out by itself (delivery state, review state). They can change, or come back in another order, between two
// reads of an item nobody edited, so they must not decide whether a preview is still valid. An edit through the API changes
// `updated_at`, which is kept; anything that matters for spending is covered by the arguments and, for enabling, by the
// budgets of the children (which are part of the state).
const DERIVED = new Set(["delivery_status", "delivery_properties_version", "targeting_reach_status", "review_status", "review_status_reasons"]);
const keyOf = (v) => (v && typeof v === "object" ? String(v.id ?? v.adsquad_id ?? v.segment_id ?? canonical(v)) : canonical(v));

// The state as it is bound to an approval: derived fields removed, and lists compared without regard to their order
// (a list of ids or ad squads is the same list whichever way Snap sorted it).
export function stabilizeState(value) {
  if (Array.isArray(value)) return value.map(stabilizeState).sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !DERIVED.has(k)).map(([k, v]) => [k, stabilizeState(v)]));
  }
  return value;
}

// A map of path -> short hash for the parts of a state (objects are walked, arrays are walked by id or index). It holds no values,
// so it can be kept and compared to say WHICH fields differ between a preview and its confirmation, without ever printing them.
const MAX_PATHS = 400;
export function fingerprintOf(value, prefix = "", out = {}, depth = 0) {
  if (value && typeof value === "object" && depth < 7 && Object.keys(out).length < MAX_PATHS) {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [`[${v && typeof v === "object" && v.id != null ? v.id : i}]`, v])
      : Object.entries(value).map(([k, v]) => [prefix ? `.${k}` : k, v]);
    for (const [k, v] of entries) {
      if (Object.keys(out).length >= MAX_PATHS) {
        out["(more)"] = "cut"; // the full digest still detects changes in the rest; only the explanation is shortened
        break;
      }
      fingerprintOf(v, prefix + k, out, depth + 1);
    }
    return out;
  }
  out[prefix || "(root)"] = digest(value ?? null).slice(0, 10);
  return out;
}

// Which parts differ, by name only.
export function explainChange(before, after) {
  if (!before || !after) return "";
  if (before.request !== after.request) return " Reason: the arguments of this call are not the same as the previewed ones.";
  const names = new Set([...Object.keys(before.state ?? {}), ...Object.keys(after.state ?? {})]);
  const changed = [...names].filter((k) => (before.state ?? {})[k] !== (after.state ?? {})[k]);
  if (!changed.length) return " Reason: the previewed state could not be compared.";
  return ` Reason: the target changed in ${changed.length} place(s): ${changed.slice(0, 12).join(", ")}${changed.length > 12 ? ", ..." : ""}.`;
}

export class ApprovalStore {
  constructor({ ttlMs = 600_000, repeatWindowMs = 600_000, now = Date.now, max = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.repeatWindowMs = repeatWindowMs;
    this.now = now;
    this.max = max;
    this.tokens = new Map();
    this.executed = new Map(); // request digest -> { at, summary }
  }

  prune() {
    const t = this.now();
    for (const [k, v] of this.tokens) if (v.expires < t - 60_000) this.tokens.delete(k);
    while (this.tokens.size > this.max) this.tokens.delete(this.tokens.keys().next().value);
    for (const [k, v] of this.executed) if (v.at < t - this.repeatWindowMs) this.executed.delete(k);
  }

  issue(tool, binding, detail = null) {
    this.prune();
    const token = `apr_${randomBytes(18).toString("base64url")}`;
    this.tokens.set(token, { tool, binding, detail, expires: this.now() + this.ttlMs, used: false });
    return { token, expires_in_seconds: Math.round(this.ttlMs / 1000) };
  }

  // Cheap check before any work is done for a confirm call: is this a live token of this tool? Does not burn it.
  precheck(tool, token) {
    if (!token) throw new Error("confirm=true needs the approval_token of a preview of this exact request. Call the tool with confirm=false first, show the preview to the user, then repeat the same arguments with confirm=true and that approval_token.");
    const rec = this.tokens.get(token);
    if (!rec) throw new Error("Unknown approval_token (it was never issued, or the server restarted). Preview again.");
    if (rec.used) throw new Error("This approval_token was already used. The operation is not repeated. Check the result of the first call; preview again only if a new change is really wanted.");
    if (this.now() > rec.expires) {
      rec.used = true;
      throw new Error("This approval_token has expired. Preview again.");
    }
    if (rec.tool !== tool) {
      rec.used = true;
      throw new Error("This approval_token belongs to a different tool. Preview again.");
    }
    return rec;
  }

  // Validates and burns the token. Throws with the reason when it cannot be used.
  consume(tool, token, binding, detail = null) {
    const rec = this.precheck(tool, token);
    rec.used = true; // burned on any attempt, so a failed or interrupted execution is never blindly retried
    if (rec.binding !== binding) throw new Error(`The request or the state of its target changed since the preview (different arguments, or the item was modified in the meantime). Nothing was sent. Preview again.${explainChange(rec.detail, detail)}`);
  }

  // Duplicate protection for tools whose effect does not show up in the target's state (creates, claims, copies).
  recentRepeat(requestDigest) {
    this.prune();
    const hit = this.executed.get(requestDigest);
    return hit ? { seconds_ago: Math.round((this.now() - hit.at) / 1000), ...hit } : null;
  }

  recordExecuted(requestDigest, summary) {
    this.executed.set(requestDigest, { at: this.now(), summary });
  }
}
