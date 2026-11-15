// Delivery controls for an ad squad: frequency cap and ad schedule. Planners in the same shape as changes.js: they return
// { patch, summary } and send nothing. Rules are Snap's, from the Ad Squads guide.

export const CAP_UNITS = ["HOURS", "DAYS"];
const DAYS_OF_WEEK = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const capOf = (current) => current?.cap_and_exclusion_config?.frequency_cap_config?.[0] ?? null;
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// "Show each person an ad at most N times per interval." Applies to impressions.
export function planFrequencyCap(current, { count, every, unit = "DAYS", clear = false }) {
  const existing = capOf(current);
  const describe = (c) => (c ? `${c.frequency_cap_count} impressions per ${c.time_interval} ${String(c.frequency_cap_interval).toUpperCase()}` : "none");
  const base = { ...(current.cap_and_exclusion_config ?? {}) };
  if (clear) {
    if (!existing) throw new Error("This ad squad has no frequency cap to remove.");
    return { patch: { cap_and_exclusion_config: { ...base, frequency_cap_config: [] } }, summary: `frequency cap ${describe(existing)} -> none` };
  }
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("count must be a whole number from 1 to 100");
  if (!CAP_UNITS.includes(unit)) throw new Error("unit must be HOURS or DAYS");
  const max = unit === "HOURS" ? 720 : 30;
  if (!Number.isInteger(every) || every < 1 || every > max) throw new Error(`every must be a whole number from 1 to ${max} (Snap's maximum is 30 days)`);
  const next = { frequency_cap_count: count, frequency_cap_type: "IMPRESSIONS", time_interval: every, frequency_cap_interval: unit };
  if (existing && existing.frequency_cap_count === count && existing.time_interval === every && String(existing.frequency_cap_interval).toUpperCase() === unit) throw new Error("The frequency cap is already that value");
  return {
    patch: { cap_and_exclusion_config: { ...base, frequency_cap_config: [next] } },
    summary: `frequency cap ${describe(existing)} -> ${describe(next)}`,
    note: "Inside an auction campaign, an ad squad with a frequency cap cannot use multi-format delivery: all its ads must be of the same ad type (Snap's rule).",
  };
}

const compact = (hours) => {
  const out = [];
  let i = 0;
  const h = [...hours].sort((a, b) => a - b);
  while (i < h.length) {
    let j = i;
    while (j + 1 < h.length && h[j + 1] === h[j] + 1) j++;
    out.push(i === j ? `${h[i]}:00` : `${h[i]}:00-${h[j] + 1}:00`);
    i = j + 1;
  }
  return out.join(", ");
};

// Which hours of which days ads may run. `schedule` is { monday: [8, 9, 10], ... } (hours 0-23, in each viewer's local time),
// or `always: true` for every hour of every day.
export function planAdSchedule(current, { schedule, always = false }) {
  const lifetime = Number(current.lifetime_budget_micro) > 0;
  const daily = Number(current.daily_budget_micro) > 0;
  if (!lifetime || daily) {
    throw new Error("Snap only allows an ad schedule on an ad squad with a LIFETIME budget; this one uses a daily budget. Changing the budget type is not something this tool does. For a daily-budget squad, use frequency caps and start and end times instead.");
  }
  let next;
  if (always) {
    if (schedule) throw new Error("Give either always or schedule, not both");
    next = Object.fromEntries(DAYS_OF_WEEK.map((d) => [d, { hour_of_day: Array.from({ length: 24 }, (_, i) => i) }]));
  } else {
    if (!schedule || !Object.keys(schedule).length) throw new Error("schedule is required, for example {\"monday\": [18, 19, 20, 21]} (hours 0-23), or use always");
    next = {};
    for (const [day, hours] of Object.entries(schedule)) {
      if (!DAYS_OF_WEEK.includes(day)) throw new Error(`Unknown day ${day}. Use ${DAYS_OF_WEEK.join(", ")}`);
      if (!Array.isArray(hours) || !hours.length || hours.some((x) => !Number.isInteger(x) || x < 0 || x > 23)) throw new Error(`${day}: give a list of whole hours from 0 to 23`);
      next[day] = { hour_of_day: [...new Set(hours)].sort((a, b) => a - b) };
    }
  }
  const before = current.ad_scheduling_config ?? null;
  if (sameJson(before, next)) throw new Error("The ad schedule is already that value");
  const describe = (c) => (c ? Object.entries(c).map(([d, v]) => `${d} ${compact(v.hour_of_day ?? [])}`).join("; ") : "no schedule (runs all day)");
  return {
    patch: { ad_scheduling_config: next },
    summary: `ad schedule: ${describe(before)} -> ${always ? "every hour of every day" : describe(next)}`,
    note: "Hours are each viewer's local time. The schedule cannot conflict with the ad squad's start and end dates. Ads outside these hours do not run, so a narrow schedule lowers delivery.",
  };
}
