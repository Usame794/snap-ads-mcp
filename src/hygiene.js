// Account hygiene, all read-only: billing, unused media, audience health, the conversion funnel, and catalog feed status.
// Nothing here changes the ad account.
import { localClock } from "./insights.js";
import { accountTotals } from "./report.js";
import { shiftIso } from "./fatigue.js";

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const DAY = 86_400_000;
const daysSince = (iso, now) => (Number.isNaN(Date.parse(iso)) ? null : Math.floor((now - Date.parse(iso)) / DAY));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// ---------- Billing ----------

export function judgeFunding(source, { activeDailyBudgets = 0, now = Date.now() } = {}) {
  const f = [];
  const add = (severity, code, detail) => f.push({ severity, code, detail });
  const type = source.type;
  if (type === "CREDIT_CARD") {
    const y = Number(source.expiration_year);
    const m = Number(source.expiration_month);
    if (y && m) {
      const end = Date.UTC(y, m, 1); // the card works through the end of its expiry month
      const left = Math.floor((end - now) / DAY);
      if (left < 0) add("CRITICAL", "CARD_EXPIRED", `The card ending ${source.last_4 ?? "????"} expired (${String(m).padStart(2, "0")}/${y}).`);
      else if (left <= 60) add("WARN", "CARD_EXPIRING", `The card ending ${source.last_4 ?? "????"} expires in about ${left} days (${String(m).padStart(2, "0")}/${y}).`);
    }
    const limit = Number(source.daily_spend_limit_micro) / 1e6;
    if (limit > 0 && activeDailyBudgets > limit) add("WARN", "DAILY_LIMIT_BELOW_BUDGETS", `The card's daily spend limit is ${limit} but active ad squads add up to ${round(activeDailyBudgets)} a day; delivery can stop when the limit is reached.`);
  }
  if (type === "LINE_OF_CREDIT") {
    const avail = Number(source.available_credit_micro) / 1e6;
    const total = Number(source.total_budget_micro) / 1e6;
    if (source.status && source.status !== "ACTIVE") add("CRITICAL", "CREDIT_NOT_ACTIVE", `The line of credit is ${source.status}.`);
    if (total > 0 && avail / total < 0.1) add("WARN", "CREDIT_LOW", `Only ${round(avail)} of ${round(total)} credit is left (${round((avail / total) * 100, 0)}%).`);
    if (activeDailyBudgets > 0 && avail > 0 && avail / activeDailyBudgets < 3) add("WARN", "CREDIT_DAYS_LEFT", `The credit left covers about ${round(avail / activeDailyBudgets, 1)} days of the current daily budgets.`);
  }
  if (type === "COUPON" && source.status && source.status !== "REDEEMED" && source.status !== "ACTIVE") add("INFO", "COUPON_STATE", `Coupon status ${source.status}.`);
  return f;
}

export async function billingCheck(client, { adAccountId, now = Date.now() }) {
  const acct = (await client.request("GET", `/adaccounts/${adAccountId}`)).adaccounts?.[0]?.adaccount ?? {};
  const findings = [];
  if (acct.status && acct.status !== "ACTIVE") findings.push({ severity: "CRITICAL", code: "ACCOUNT_NOT_ACTIVE", detail: `The ad account status is ${acct.status}.` });
  // What the active ad squads could spend per day.
  let activeDailyBudgets = 0;
  const campaigns = (await client.listPaged(`/adaccounts/${adAccountId}/campaigns`, "campaign")).items.filter((c) => c.status === "ACTIVE");
  for (const c of campaigns) for (const s of await client.listChildren("campaign", c.id, "adsquad")) if (s.status === "ACTIVE" && s.daily_budget_micro > 0) activeDailyBudgets += s.daily_budget_micro / 1e6;
  const ids = new Set(acct.funding_source_ids ?? []);
  let sources = [];
  let sourcesError = null;
  if (acct.organization_id && ids.size) {
    try {
      sources = (await client.listPaged(`/organizations/${acct.organization_id}/fundingsources`, "fundingsource")).items.filter((s) => ids.has(s.id));
    } catch (e) {
      sourcesError = String(e.message).slice(0, 200);
    }
  }
  const rows = sources.map((s) => ({
    id: s.id,
    type: s.type,
    name: s.name,
    status: s.status,
    ...(s.last_4 ? { last_4: s.last_4, expires: `${String(s.expiration_month).padStart(2, "0")}/${s.expiration_year}` } : {}),
    ...(s.available_credit_micro != null ? { available_credit: s.available_credit_micro / 1e6, currency: s.currency } : {}),
    ...(s.daily_spend_limit_micro != null ? { daily_spend_limit: s.daily_spend_limit_micro / 1e6 } : {}),
    findings: judgeFunding(s, { activeDailyBudgets, now }),
  }));
  for (const r of rows) findings.push(...r.findings.map((x) => ({ ...x, funding_source: r.name ?? r.id })));
  if (!rows.length && !sourcesError) findings.push({ severity: "WARN", code: "NO_FUNDING_SOURCE_READ", detail: "No funding source was found for this ad account (or this login may not be allowed to see them)." });
  const cap = acct.lifetime_spend_cap_micro ? acct.lifetime_spend_cap_micro / 1e6 : null;
  return {
    ad_account: { name: acct.name, status: acct.status, currency: acct.currency, billing_type: acct.billing_type, ...(cap ? { lifetime_spend_cap: cap } : {}) },
    active_daily_budgets_total: round(activeDailyBudgets),
    funding_sources: rows.map(({ findings: _f, ...r }) => r),
    findings,
    verdict: findings.some((x) => x.severity === "CRITICAL") ? "CRITICAL" : findings.some((x) => x.severity === "WARN") ? "ATTENTION" : "OK",
    ...(sourcesError ? { funding_sources_unavailable: sourcesError } : {}),
    note: "Snap does not report the account's current spend against a lifetime cap here; check Ads Manager billing for invoices and payment failures.",
  };
}

// ---------- Unused media ----------

export async function unusedMedia(client, { adAccountId, now = Date.now(), limit = 100 }) {
  const media = await client.listPaged(`/adaccounts/${adAccountId}/media`, "media");
  const creatives = await client.listPaged(`/adaccounts/${adAccountId}/creatives`, "creative");
  const elements = await client.listPaged(`/adaccounts/${adAccountId}/creative_elements`, "creative_element").catch(() => ({ items: [], complete: false }));
  // Every media id that appears anywhere inside a creative or creative element counts as used (top Snap, preview tile, logo,
  // product images, button overlays...), so a new field name cannot make a used file look unused.
  const used = new Set();
  for (const o of [...creatives.items, ...elements.items]) for (const m of JSON.stringify(o).match(UUID) ?? []) used.add(m.toLowerCase());
  const rows = media.items
    .filter((m) => m.id && !used.has(String(m.id).toLowerCase()))
    .map((m) => ({ id: m.id, name: m.name, type: m.type, media_status: m.media_status, created_at: m.created_at, age_days: daysSince(m.created_at, now) }))
    .sort((a, b) => (b.age_days ?? -1) - (a.age_days ?? -1));
  const complete = media.complete && creatives.complete && elements.complete;
  return {
    media_total: media.items.length,
    unused_count: rows.length,
    unused: rows.slice(0, limit),
    ...(rows.length > limit ? { note: `${rows.length} unused; the ${limit} oldest are shown.` } : {}),
    ...(complete ? {} : { warning: "A list was INCOMPLETE, so some media shown as unused may be used. Check before deleting anything." }),
    how_to_use: "A file is listed when no creative or creative element of this ad account mentions it. This tool never deletes. Remove old files in Ads Manager if you want to.",
  };
}

// ---------- Audience health ----------

export async function audienceHealth(client, { adAccountId, now = Date.now(), staleDays = 90, minSize = 1000 }) {
  const segs = await client.listPaged(`/adaccounts/${adAccountId}/segments`, "segment");
  const campaigns = (await client.listPaged(`/adaccounts/${adAccountId}/campaigns`, "campaign")).items.filter((c) => c.status === "ACTIVE");
  const usedBy = new Map();
  let squadsRead = 0;
  for (const c of campaigns) {
    for (const s of await client.listChildren("campaign", c.id, "adsquad")) {
      if (s.status !== "ACTIVE") continue;
      squadsRead += 1;
      for (const g of s.targeting?.segments ?? []) for (const id of [].concat(g.segment_id ?? [])) usedBy.set(id, (usedBy.get(id) ?? 0) + 1);
    }
  }
  const rows = segs.items.map((s) => {
    const size = s.approximate_number_users ?? 0;
    const status = s.targetable_status ?? s.status;
    const age = daysSince(s.updated_at ?? s.created_at, now);
    const flags = [];
    if (status && status !== "READY") flags.push({ code: "NOT_TARGETABLE", detail: `Status ${status}: it cannot be used in targeting yet.` });
    if (size < minSize) flags.push({ code: "TINY", detail: `About ${size} people: too small to deliver reliably.` });
    if (s.source_type === "FIRST_PARTY" && age != null && age > staleDays) flags.push({ code: "STALE", detail: `A customer list not updated for ${age} days. Old lists miss recent buyers.` });
    const uses = usedBy.get(s.id) ?? 0;
    return { id: s.id, name: s.name, source_type: s.source_type, status, size, age_days: age, used_by_active_squads: uses, flags, ...(uses === 0 ? { unused: true } : {}) };
  });
  const problems = rows.filter((r) => r.flags.length);
  return {
    audiences: rows.length,
    with_problems: problems.length,
    used_by_active_squads: rows.filter((r) => r.used_by_active_squads > 0).length,
    unused_audiences: rows.filter((r) => r.unused).length,
    active_squads_read: squadsRead,
    problems: problems.slice(0, 50),
    ...(segs.complete ? {} : { warning: "The audience list was INCOMPLETE." }),
    note: "'Unused' means no ACTIVE ad squad includes or excludes it right now; it may serve a paused squad or a past purchase exclusion you still want.",
  };
}

// ---------- Conversion funnel ----------

const FUNNEL = [
  ["impressions", "impressions"],
  ["swipes", "swipes"],
  ["view_content", "conversion_view_content"],
  ["add_to_cart", "conversion_add_cart"],
  ["checkout", "conversion_start_checkout"],
  ["purchases", "conversion_purchases"],
];

export function buildFunnel(stats = {}) {
  const steps = FUNNEL.map(([name, field]) => ({ step: name, count: stats[field] == null ? null : Number(stats[field]) }));
  const out = [];
  let previous = null;
  for (const s of steps) {
    const row = { step: s.step, count: s.count };
    if (previous && s.count != null && previous.count > 0) {
      row.of_previous_step_pct = round((s.count / previous.count) * 100);
      row.previous_step = previous.step;
    }
    out.push(row);
    if (s.count != null && s.count > 0) previous = s;
  }
  const after = out.filter((r) => r.of_previous_step_pct != null && !["swipes"].includes(r.step));
  const weakest = [...after].sort((a, b) => a.of_previous_step_pct - b.of_previous_step_pct)[0];
  return { steps: out, weakest_step: weakest ? `${weakest.previous_step} -> ${weakest.step} (${weakest.of_previous_step_pct}%)` : null, missing_steps: steps.filter((s) => !s.count).map((s) => s.step) };
}

export async function funnelReport(client, { adAccountId, entity = "adaccount", id, offset = "+00:00", days = 7, now = new Date() }) {
  const base = { adaccount: "adaccounts", campaign: "campaigns", adsquad: "adsquads", ad: "ads" }[entity];
  if (!base) throw new Error("entity must be adaccount, campaign, adsquad or ad");
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error("days must be a whole number from 1 to 31");
  const end = localClock(now, offset).todayStart;
  const start = shiftIso(end, -days * DAY);
  const fields = FUNNEL.map(([, f]) => f).join(",");
  let stats;
  if (entity === "adaccount") stats = (await accountTotals(client, adAccountId, { start_time: start, end_time: end, fields })).stats;
  else {
    const data = await client.request("GET", `/${base}/${id}/stats`, { query: { granularity: "TOTAL", start_time: start, end_time: end, fields, omit_empty: true } });
    stats = data.total_stats?.[0]?.total_stat?.stats ?? {};
  }
  return {
    window: { start_time: start, end_time: end, days },
    ...buildFunnel(stats),
    note: "Steps appear only if your pixel sends those events. A step shown as missing is not the same as zero. Counts are Snap-attributed.",
  };
}

// ---------- Catalog feed status ----------

// How many days apart uploads are expected, from the feed's schedule (unknown: null).
export function scheduleDays(schedule) {
  if (!schedule) return null;
  const n = Number(schedule.interval_count) || 1;
  const unit = String(schedule.interval_type ?? "").toUpperCase();
  return unit === "HOURLY" ? n / 24 : unit === "DAILY" ? n : unit === "WEEKLY" ? n * 7 : unit === "MONTHLY" ? n * 30 : null;
}

export const uploadErrorCount = (u) => Object.entries(u?.summary?.issues_summary ?? {}).filter(([k]) => /error/i.test(k)).reduce((n, [, counts]) => n + Object.values(counts ?? {}).reduce((a, b) => a + Number(b || 0), 0), 0);

export function judgeUpload(u) {
  const issues = [];
  const status = u.status;
  if (status && !["COMPLETE", "INITIALIZED", "IN_PROGRESS"].includes(status)) issues.push(`Upload status ${status}.`);
  const s = u.summary ?? {};
  for (const [kind, counts] of Object.entries(s.issues_summary ?? {})) {
    if (kind === "recommendations") continue;
    for (const [code, n] of Object.entries(counts ?? {})) issues.push(`${n} x ${code}`);
  }
  return issues;
}

export async function feedStatus(client, { organizationId, now = Date.now() }) {
  const catalogs = (await client.listPaged(`/organizations/${organizationId}/catalogs`, "catalog")).items;
  const out = [];
  for (const c of catalogs) {
    const feeds = (await client.request("GET", `/catalogs/${c.id}/product_feeds`)).product_feeds ?? [];
    const entry = { catalog_id: c.id, catalog: c.name, feeds: [] };
    for (const wrap of feeds) {
      const feed = wrap.product_feed ?? wrap;
      const ups = ((await client.request("GET", `/product_feeds/${feed.id}/feed_uploads`)).feed_uploads ?? []).map((w) => w.feed_upload ?? w);
      ups.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const last = ups.find((u) => u.status === "COMPLETE");
      const latest = ups[0];
      const lastAge = last ? daysSince(last.updated_at ?? last.created_at, now) : null;
      const problems = [];
      if (!last) problems.push("No upload has completed yet.");
      else if (lastAge > Math.max(2, 2 * (scheduleDays(feed.schedule) ?? 0))) problems.push(`The last completed upload was ${lastAge} days ago.`);
      if (latest && latest.status && !["COMPLETE", "INITIALIZED", "IN_PROGRESS"].includes(latest.status)) problems.push(`The latest upload is ${latest.status}.`);
      entry.feeds.push({
        feed_id: feed.id,
        name: feed.name,
        status: feed.status,
        schedule: feed.schedule ? { interval: `${feed.schedule.interval_count} ${feed.schedule.interval_type}`, timezone: feed.schedule.timezone } : null,
        last_completed_upload: last ? { at: last.updated_at ?? last.created_at, total_items: last.summary?.total_items ?? null, items_modified: last.summary?.items_modified ?? null, days_ago: lastAge } : null,
        latest_upload_status: latest?.status ?? null,
        upload_issues: latest ? judgeUpload(latest).slice(0, 10) : [],
        upload_errors: latest ? uploadErrorCount(latest) : 0,
        problems,
      });
    }
    out.push(entry);
  }
  return {
    catalogs: out.length,
    feeds_with_problems: out.flatMap((c) => c.feeds).filter((f) => f.problems.length || f.upload_errors > 0).length,
    catalogs_detail: out,
    note: "The feed's own URL and password are never shown. Recommendations (such as missing app links) are not counted as problems.",
  };
}
