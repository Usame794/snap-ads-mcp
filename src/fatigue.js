// Creative fatigue: compare each ad this window against the one before it.
import { compareReport } from "./audit.js";

// Move an ISO date-time by deltaMs and keep its UTC offset (so day boundaries stay at local midnight).
export function shiftIso(iso, deltaMs) {
  const m = String(iso).match(/(Z|[+-]\d{2}:?\d{2})$/);
  if (!m) throw new Error("Times need an offset, e.g. 2026-10-27T00:00:00+00:00");
  const off = m[1];
  const mins = off === "Z" ? 0 : (off[0] === "-" ? -1 : 1) * (parseInt(off.slice(1, 3), 10) * 60 + parseInt(off.slice(-2), 10));
  const local = new Date(new Date(iso).getTime() + deltaMs + mins * 60_000);
  if (isNaN(local)) throw new Error(`Bad time: ${iso}`);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}`;
  return stamp + (off === "Z" ? "Z" : `${off.slice(0, 3)}:${off.slice(-2)}`);
}

const RANK = { FATIGUED: 0, WATCH: 1, STOPPED: 2, NEW: 3, HEALTHY: 4, LOW_SPEND: 5 };

export function judgeFatigue(row, { minSpend = 50 } = {}) {
  const now = row.spend.now ?? 0;
  const before = row.spend.before ?? 0;
  if (before >= minSpend && now < 1) return { status: "STOPPED", reason: `spent $${before} the week before and nothing this week (paused or replaced)` };
  if (before < 1 && now >= minSpend) return { status: "NEW", reason: `no spend the week before, $${now} now` };
  if (now < minSpend) return { status: "LOW_SPEND", reason: `$${now} this week is below the $${minSpend} needed to judge` };
  const rNow = row.roas.now;
  const rBefore = row.roas.before;
  const drop = rBefore > 0 && rNow != null ? (rBefore - rNow) / rBefore : 0;
  const freqUp = (row.frequency.now ?? 0) > (row.frequency.before ?? 0) * 1.15 && (row.frequency.now ?? 0) > 1.5;
  const sNow = row.swipe_rate_pct.now;
  const sBefore = row.swipe_rate_pct.before;
  const swipeDown = sBefore > 0 && sNow != null && sNow < sBefore * 0.75;
  const bits = [];
  if (drop > 0) bits.push(`ROAS ${rBefore} -> ${rNow} (${Math.round(drop * 100)}% lower)`);
  if (freqUp) bits.push(`frequency ${row.frequency.before} -> ${row.frequency.now}`);
  if (swipeDown) bits.push(`swipe rate ${sBefore}% -> ${sNow}%`);
  if (drop >= 0.3 && (freqUp || swipeDown)) return { status: "FATIGUED", reason: bits.join("; ") };
  if (drop >= 0.2 || (swipeDown && (row.frequency.now ?? 0) >= 4)) return { status: "WATCH", reason: bits.join("; ") || "swipe rate falling at high frequency" };
  return { status: "HEALTHY", reason: bits.join("; ") || "stable" };
}

export async function fatigueReport(client, { entity, id, end_time, days = 7, minSpend = 50 }) {
  if (!["campaign", "adsquad"].includes(entity)) throw new Error("entity must be campaign or adsquad");
  const span = days * 86_400_000;
  const current = { start_time: shiftIso(end_time, -span), end_time };
  const previous = { start_time: shiftIso(end_time, -2 * span), end_time: current.start_time };
  const cmp = await compareReport(client, { entity, id, breakdown: "ad", current, previous });
  const items = cmp.rows
    .map((r) => ({ ad_id: r.id, name: r.name, spend_now: r.spend.now, spend_before: r.spend.before, roas_now: r.roas.now, roas_before: r.roas.before, frequency_now: r.frequency.now, swipe_rate_now: r.swipe_rate_pct.now, ...judgeFatigue(r, { minSpend }) }))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || b.spend_now - a.spend_now);
  const counts = items.reduce((m, i) => ((m[i.status] = (m[i.status] ?? 0) + 1), m), {});
  return { window: { current, previous }, counts, replace_first: items.filter((i) => i.status === "FATIGUED").map((i) => i.ad_id), items: items.slice(0, 60) };
}
