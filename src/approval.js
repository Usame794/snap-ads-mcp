// Preview-then-execute approvals. A preview hands out a single-use token bound to the exact tool, account, parameters and
// the state of the targets at preview time. Executing needs that token; anything stale, changed, reused or expired is refused.
// NOTE: this proves "this exact change was previewed and nothing moved since". It does NOT prove a human looked at it:
// the AI client sees the token. Human authorization is the MCP client's permission prompt (or SNAP_HUMAN_APPROVAL=elicit).
import { createHash, randomBytes } from "node:crypto";

const canonical = (x) =>
  JSON.stringify(x, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v === undefined ? null : v));

export const digest = (x) => createHash("sha256").update(canonical(x)).digest("hex");

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

  issue(tool, binding) {
    this.prune();
    const token = `apr_${randomBytes(18).toString("base64url")}`;
    this.tokens.set(token, { tool, binding, expires: this.now() + this.ttlMs, used: false });
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
  consume(tool, token, binding) {
    const rec = this.precheck(tool, token);
    rec.used = true; // burned on any attempt, so a failed or interrupted execution is never blindly retried
    if (rec.binding !== binding) throw new Error("The request or the state of its target changed since the preview (different arguments, or the item was modified in the meantime). Nothing was sent. Preview again.");
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
