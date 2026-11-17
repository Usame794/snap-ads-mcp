// A soft warning (not a limit): tells the person when a change adds a daily budget that is large compared with what this ad
// account normally runs. The hard limits in policy.js still apply; this only makes an unusual amount hard to miss in the preview.
const round = (n) => Math.round(n * 100) / 100;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Pure. `added` is the daily budget this change adds (a new ad squad's budget, or the size of an increase).
// `squadBudgets` are the daily budgets of the ad squads that are running now.
export function judgeBudget({ added, squadBudgets = [], maxDailyBudget, warnAbove = null, currency = "" }) {
  if (!(added > 0)) return null;
  const unit = currency ? ` ${currency}` : "";
  const budgets = squadBudgets.filter((b) => b > 0);
  const largest = budgets.length ? Math.max(...budgets) : null;
  const typical = budgets.length ? round(median(budgets)) : null;
  const reasons = [];
  if (warnAbove && added > warnAbove) reasons.push(`it is above your own warning level of ${warnAbove}${unit} a day (SNAP_WARN_DAILY_BUDGET)`);
  if (largest && added > 2 * largest) reasons.push(`it is more than twice your largest running ad squad (${round(largest)}${unit} a day; typical ${typical}${unit})`);
  if (!largest && maxDailyBudget && added > maxDailyBudget / 2) reasons.push(`it is more than half of your limit of ${maxDailyBudget}${unit} a day and this account has no running ad squad to compare with`);
  if (!reasons.length) return null;
  return {
    level: "HIGHER_THAN_NORMAL",
    message: `This change adds ${round(added)}${unit} of daily budget, and ${reasons.join("; ")}. Check the amount before you approve.`,
    added_daily_budget: round(added),
    largest_running_daily_budget: largest == null ? null : round(largest),
    typical_running_daily_budget: typical,
  };
}

// Reads the running ad squads' daily budgets and judges. Never blocks a preview: if the account cannot be read, there is no warning.
export async function budgetWarning(client, adAccountId, { added, policy }) {
  if (!(added > 0)) return null;
  let squadBudgets = [];
  try {
    const { items } = await client.listPaged(`/adaccounts/${adAccountId}/adsquads`, "adsquad", { maxPages: 2 });
    squadBudgets = items.filter((s) => s.status === "ACTIVE" && s.daily_budget_micro > 0).map((s) => s.daily_budget_micro / 1e6);
  } catch {
    squadBudgets = [];
  }
  return judgeBudget({ added, squadBudgets, maxDailyBudget: policy.maxDailyBudget, warnAbove: policy.warnDailyBudget, currency: policy.currency ?? "" });
}
