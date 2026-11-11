// Safety policy: every limit that protects money is parsed and validated here, once, at startup.
// Anything invalid throws, so a typo can never silently switch a limit off (fail closed).

const NUMBER_RE = /^\d+(\.\d+)?$/;

function readNumber(env, key, fallback, { min, max, integer = false, exclusiveMin = false }, errors) {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const text = String(raw).trim();
  if (text === "") {
    errors.push(`${key} is empty. Remove the line to use the default (${fallback}) or set a plain number.`);
    return fallback;
  }
  if (!NUMBER_RE.test(text)) {
    errors.push(`${key} must be a plain number such as ${fallback} (no %, currency sign, separators or exponent).`);
    return fallback;
  }
  const n = Number(text);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) {
    errors.push(`${key} must be a ${integer ? "whole" : "finite"} number.`);
    return fallback;
  }
  if (n < min || (exclusiveMin && n === min) || n > max) {
    errors.push(`${key}=${text} is outside the allowed range (${exclusiveMin ? "more than" : "at least"} ${min}, at most ${max}).`);
    return fallback;
  }
  return n;
}

function readChoice(env, key, fallback, choices, errors) {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const text = String(raw).trim().toLowerCase();
  if (!(text in choices)) {
    errors.push(`${key} must be one of: ${Object.keys(choices).join(", ")}.`);
    return fallback;
  }
  return choices[text];
}

// Policies made by loadPolicy. Only these are trusted as "already validated"; no property of an object can fake it.
const POLICIES = new WeakSet();
const BOOL = { 1: true, true: true, yes: true, on: true, 0: false, false: false, no: false, off: false };
const HARD_MAX = 1_000_000_000; // sanity bound for any amount, in account currency

// Parses the safety settings. Throws one error listing every problem.
export function loadPolicy(env = process.env) {
  if (env && typeof env === "object" && POLICIES.has(env)) return env;
  const errors = [];
  const minDailyBudget = readNumber(env, "SNAP_MIN_DAILY_BUDGET", 5, { min: 0, max: HARD_MAX, exclusiveMin: true }, errors);
  const maxDailyBudget = readNumber(env, "SNAP_MAX_DAILY_BUDGET", 1000, { min: 0, max: HARD_MAX, exclusiveMin: true }, errors);
  const maxBid = readNumber(env, "SNAP_MAX_BID", 50, { min: 0, max: HARD_MAX, exclusiveMin: true }, errors);
  const maxActivationDailyBudget = readNumber(env, "SNAP_MAX_ACTIVATION_DAILY_BUDGET", maxDailyBudget * 5, { min: 0, max: HARD_MAX, exclusiveMin: true }, errors);
  const policy = {
    minDailyBudget,
    maxDailyBudget,
    maxBid,
    maxIncreasePct: readNumber(env, "SNAP_MAX_BUDGET_INCREASE_PCT", 100, { min: 0, max: 1000 }, errors),
    maxBidIncreasePct: readNumber(env, "SNAP_MAX_BID_INCREASE_PCT", 50, { min: 0, max: 1000 }, errors),
    maxLifetimeBudget: readNumber(env, "SNAP_MAX_LIFETIME_BUDGET", maxDailyBudget * 30, { min: 0, max: HARD_MAX, exclusiveMin: true }, errors),
    maxActivationDailyBudget,
    // Everything this server may add to the account's daily spend in any 24 hours: budgets it starts plus budget increases.
    maxAddedDailyBudget24h: readNumber(env, "SNAP_MAX_ADDED_DAILY_BUDGET_24H", maxActivationDailyBudget * 2, { min: 0, max: HARD_MAX, exclusiveMin: true }, errors),
    approvalTtlSeconds: readNumber(env, "SNAP_APPROVAL_TTL_SECONDS", 600, { min: 30, max: 3600, integer: true }, errors),
    repeatWindowSeconds: readNumber(env, "SNAP_REPEAT_WINDOW_SECONDS", 600, { min: 0, max: 86400, integer: true }, errors),
    httpTimeoutMs: readNumber(env, "SNAP_HTTP_TIMEOUT_MS", 60000, { min: 1000, max: 600000, integer: true }, errors),
    readOnly: readChoice(env, "SNAP_READ_ONLY", false, BOOL, errors),
    humanApproval: readChoice(env, "SNAP_HUMAN_APPROVAL", "off", { off: "off", elicit: "elicit" }, errors),
    currency: null,
  };
  if (env.SNAP_ACCOUNT_CURRENCY !== undefined && String(env.SNAP_ACCOUNT_CURRENCY).trim() !== "") {
    const c = String(env.SNAP_ACCOUNT_CURRENCY).trim();
    if (/^[A-Z]{3}$/.test(c)) policy.currency = c;
    else errors.push("SNAP_ACCOUNT_CURRENCY must be a 3-letter ISO code in capitals, e.g. USD.");
  }
  if (!errors.length && maxDailyBudget < minDailyBudget) errors.push("SNAP_MAX_DAILY_BUDGET must not be below SNAP_MIN_DAILY_BUDGET.");
  if (errors.length) throw new Error(`Unsafe configuration, refusing to continue:\n- ${errors.join("\n- ")}`);
  Object.freeze(policy);
  POLICIES.add(policy);
  return policy;
}

// Public, non-secret view of the limits (shown in previews and errors).
export function describePolicy(policy) {
  return { ...policy };
}

// A money amount in account currency: a finite, positive number with at most micro precision.
export function assertAmount(label, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number in account currency (e.g. 25 or 25.5)`);
  if (!(value > 0)) throw new Error(`${label} must be greater than 0`);
  if (value > HARD_MAX) throw new Error(`${label} is not a plausible amount`);
  const micro = value * 1_000_000;
  if (Math.abs(micro - Math.round(micro)) > 1e-3) throw new Error(`${label} has more precision than the API accepts (micro-currency)`);
  return value;
}

const pct = (before, value) => ((value - before) / before) * 100;

// Rules for a daily budget. `before` is the current value (null when creating). `windowStart` is the value this entity had at the
// start of the last 24 hours according to the change log (null when it has no logged change in that window).
//   R1 absolute ceiling  R2 minimum  R3 one step may raise by at most maxIncreasePct  R4 so may all steps of the last 24h together.
export function checkDailyBudget(policy, { before = null, value, windowStart = null, restoring = false, what = "Daily budget" }) {
  assertAmount(what, value);
  if (!(value >= policy.minDailyBudget)) throw new Error(`${what} must be at least ${policy.minDailyBudget} (account currency)`);
  const increase = before == null || value > before;
  if (increase && value > policy.maxDailyBudget) {
    throw new Error(`${what} ${value} is above the absolute limit of ${policy.maxDailyBudget} (SNAP_MAX_DAILY_BUDGET). Only the account owner can raise that limit, in .env, followed by a restart.`);
  }
  if (before == null || !increase) return;
  relativeRules({ before, value, windowStart, restoring, maxPct: policy.maxIncreasePct, what, knob: "SNAP_MAX_BUDGET_INCREASE_PCT" });
}

export function checkBid(policy, { before = null, value, windowStart = null, restoring = false, what = "Max bid" }) {
  assertAmount(what, value);
  const increase = before == null || value > before;
  if (increase && value > policy.maxBid) {
    throw new Error(`${what} ${value} is above the absolute limit of ${policy.maxBid} (SNAP_MAX_BID). Only the account owner can raise that limit, in .env, followed by a restart.`);
  }
  if (before == null || !increase) return;
  relativeRules({ before, value, windowStart, restoring, maxPct: policy.maxBidIncreasePct, what, knob: "SNAP_MAX_BID_INCREASE_PCT" });
}

function relativeRules({ before, value, windowStart, restoring, maxPct, what, knob }) {
  if (!(before > 0)) throw new Error(`${what} is currently ${before}; a relative limit cannot be checked, so the change is refused. Set it in Ads Manager.`);
  // Putting back a value the entity already had inside the window (an undo) is not a new increase.
  const isRestore = restoring && windowStart != null && value <= windowStart;
  const step = pct(before, value);
  if (!isRestore && !(step <= maxPct)) {
    throw new Error(`Refusing a ${step.toFixed(0)}% increase of ${what.toLowerCase()} (limit ${maxPct}% per step, ${knob}). Raise in smaller steps.`);
  }
  if (windowStart != null && windowStart > 0) {
    const ceiling = windowStart * (1 + maxPct / 100);
    if (!(value <= ceiling + 1e-9)) {
      throw new Error(`Refusing: ${what.toLowerCase()} was ${windowStart} at the start of the last 24 hours, so it may reach at most ${Math.round(ceiling * 100) / 100} today (limit ${maxPct}% per 24h, ${knob}). Requested ${value}.`);
    }
  }
}

export function checkLifetimeBudget(policy, value, what = "Lifetime budget") {
  assertAmount(what, value);
  if (value > policy.maxLifetimeBudget) throw new Error(`${what} ${value} is above the absolute limit of ${policy.maxLifetimeBudget} (SNAP_MAX_LIFETIME_BUDGET).`);
}
