// Reporting helpers: stats broken down by child entity, with ROAS and CPA computed.
const FIELDS = ["impressions", "spend", "swipes", "conversion_purchases", "conversion_purchases_value", "frequency"];
const BASE = { campaign: "campaigns", adsquad: "adsquads", ad: "ads" };

const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/;
const offsetMinutes = (iso) => {
  const m = String(iso).match(OFFSET_RE);
  if (!m || m[1] === "Z") return 0;
  return (m[1][0] === "-" ? -1 : 1) * (parseInt(m[1].slice(1, 3), 10) * 60 + parseInt(m[1].slice(-2), 10));
};

// A reporting window must be two real instants with an explicit UTC offset, in order. Anything else is ambiguous.
export function checkWindow(start_time, end_time) {
  for (const [name, v] of [["start_time", start_time], ["end_time", end_time]]) {
    if (typeof v !== "string" || !OFFSET_RE.test(v) || Number.isNaN(Date.parse(v))) throw new Error(`${name} must be an ISO date-time with an offset, e.g. 2026-10-19T00:00:00+00:00`);
  }
  if (!(Date.parse(end_time) > Date.parse(start_time))) throw new Error("end_time must be after start_time");
}

// Calendar date of an instant in the reporting timezone (the offset the caller asked in), whatever offset Snap answers in.
export function localDate(instant, requestedIso) {
  const t = Date.parse(instant);
  if (Number.isNaN(t)) return String(instant).slice(0, 10);
  return new Date(t + offsetMinutes(requestedIso) * 60_000).toISOString().slice(0, 10);
}

export const SWIPE_WINDOWS = ["1_DAY", "7_DAY", "28_DAY"];
export const VIEW_WINDOWS = ["1_HOUR", "3_HOUR", "6_HOUR", "1_DAY", "7_DAY"];
function attributionQuery({ swipe_up_attribution_window, view_attribution_window } = {}) {
  if (swipe_up_attribution_window && !SWIPE_WINDOWS.includes(swipe_up_attribution_window)) throw new Error(`swipe_up_attribution_window must be one of ${SWIPE_WINDOWS.join(", ")}`);
  if (view_attribution_window && !VIEW_WINDOWS.includes(view_attribution_window)) throw new Error(`view_attribution_window must be one of ${VIEW_WINDOWS.join(", ")}`);
  return { swipe_up_attribution_window: swipe_up_attribution_window || undefined, view_attribution_window: view_attribution_window || undefined };
}
// What the numbers mean, stated with every report so they are not read as store revenue.
export function basisOf(a = {}) {
  return {
    money: "account currency (Snap micro-currency divided by 1,000,000; no conversion)",
    attribution: a.swipe_up_attribution_window || a.view_attribution_window ? `swipe ${a.swipe_up_attribution_window ?? "account default"}, view ${a.view_attribution_window ?? "account default"}` : "Snap's default attribution windows for this account (not pinned by this request)",
    purchases: "Snap-attributed conversions, not store orders",
  };
}

// Totals are computed from the raw micro values, never from rounded rows.
export function totalsOf(statsList) {
  const sum = (k) => statsList.reduce((n, s) => n + (s?.[k] ?? 0), 0);
  const [spendMicro, valueMicro, purchases, impressions, swipes] = ["spend", "conversion_purchases_value", "conversion_purchases", "impressions", "swipes"].map(sum);
  const r = (x) => Math.round(x * 100) / 100;
  return {
    total_spend: r(spendMicro / 1e6),
    total_purchases: purchases,
    total_purchase_value: r(valueMicro / 1e6),
    total_roas: spendMicro ? r(valueMicro / spendMicro) : null,
    total_cpa: purchases ? r(spendMicro / 1e6 / purchases) : null,
    total_impressions: impressions,
    total_swipe_rate_pct: impressions ? r((swipes / impressions) * 100) : null,
  };
}

// Breakdown stats can come in pages (paging.next_link sits inside total_stat). Follow them all.
// When the page limit is hit with more pages left, the returned array has `incomplete = true`.
export async function collectBreakdown(client, path, query, key, { maxPages = 40 } = {}) {
  const rows = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const data = await client.request("GET", path, { query: { ...query, cursor } });
    const ts = data.total_stats?.[0]?.total_stat;
    rows.push(...(ts?.breakdown_stats?.[key] ?? []));
    const next = ts?.paging?.next_link || data.paging?.next_link;
    if (!next) break;
    const nextCursor = new URL(next).searchParams.get("cursor");
    if (!nextCursor || nextCursor === cursor) {
      rows.incomplete = true;
      break;
    }
    cursor = nextCursor;
    if (i === maxPages - 1) rows.incomplete = true;
  }
  return rows;
}

export function summarizeRow(name, id, s = {}) {
  const spend = (s.spend ?? 0) / 1e6;
  const value = (s.conversion_purchases_value ?? 0) / 1e6;
  const purchases = s.conversion_purchases ?? 0;
  const impressions = s.impressions ?? 0;
  const r = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    id,
    name,
    spend: r(spend),
    purchases,
    purchase_value: r(value),
    roas: spend ? r(value / spend) : null,
    cpa: purchases ? r(spend / purchases) : null,
    impressions,
    swipe_rate_pct: impressions ? r(((s.swipes ?? 0) / impressions) * 100) : null,
    // not reported is not the same as zero
    frequency: s.frequency == null ? null : r(s.frequency),
  };
}

export async function breakdownReport(client, { entity, id, start_time, end_time, breakdown, swipe_up_attribution_window, view_attribution_window }) {
  const valid = { campaign: ["adsquad", "ad"], adsquad: ["ad"] };
  if (!valid[entity]?.includes(breakdown)) throw new Error(`breakdown for a ${entity} must be one of: ${(valid[entity] ?? []).join(", ") || "(not supported)"}`);
  checkWindow(start_time, end_time);
  const attribution = attributionQuery({ swipe_up_attribution_window, view_attribution_window });
  const rows = await collectBreakdown(client, `/${BASE[entity]}/${id}/stats`, { granularity: "TOTAL", breakdown, start_time, end_time, fields: FIELDS.join(","), omit_empty: true, ...attribution }, breakdown);
  const children = await client.listChildren(entity, id, breakdown);
  const names = Object.fromEntries(children.map((c) => [c.id, c.name]));
  const creatives = Object.fromEntries(children.map((c) => [c.id, c.creative_id]));
  const out = rows.map((r) => ({ ...summarizeRow(names[r.id] ?? r.id, r.id, r.stats), ...(breakdown === "ad" ? { creative_id: creatives[r.id] } : {}) })).filter((r) => r.spend > 0 || r.purchases > 0);
  out.sort((a, b) => b.spend - a.spend);
  return {
    window: { start_time, end_time },
    breakdown,
    ...totalsOf(rows.map((r) => r.stats)),
    basis: basisOf(attribution),
    ...(rows.incomplete ? { incomplete: true, warning: "Snap returned more pages than this report reads; totals are a lower bound. Narrow the window or use snap_report_async_start." } : {}),
    rows: out,
  };
}

export const DIMENSIONS = ["country", "gender", "age", "region", "dma", "make"];
const ENTITY_BASE = { adaccount: "adaccounts", campaign: "campaigns", adsquad: "adsquads", ad: "ads" };

// ---------- Account-level numbers ----------
// Snap's account-level stats endpoint only accepts the `spend` field when no breakdown is asked for ("Only field 'spend' should be
// used when querying AdAccount stats", found on a live account). Account totals are therefore built from the per-campaign
// breakdown, the query the weekly report already uses. Time series per hour or day are merged from the same breakdown; if Snap
// does not answer that, from the ACTIVE campaigns' own series. The result is checked against Snap's own spend total.
const NUMERIC = ["impressions", "spend", "swipes", "conversion_purchases", "conversion_purchases_value", "conversion_view_content", "conversion_add_cart", "conversion_start_checkout"];
const addStats = (into, s = {}) => {
  for (const k of NUMERIC) if (s[k] != null) into[k] = (into[k] ?? 0) + Number(s[k]);
  return into;
};

export async function accountTotals(client, adAccountId, { start_time, end_time, fields = FIELDS.join(",") }) {
  checkWindow(start_time, end_time);
  const rows = await collectBreakdown(client, `/adaccounts/${adAccountId}/stats`, { granularity: "TOTAL", breakdown: "campaign", start_time, end_time, fields, omit_empty: true, limit: 200 }, "campaign");
  const stats = {};
  for (const r of rows) addStats(stats, r.stats);
  return { stats, campaigns: rows.length, incomplete: Boolean(rows.incomplete) };
}

function mergeSeries(into, timeseries = []) {
  for (const t of timeseries) addStats((into[t.start_time] ??= { start_time: t.start_time, end_time: t.end_time, stats: {} }).stats, t.stats);
}
const sortedSeries = (m) => Object.values(m).sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));

export async function accountSeries(client, adAccountId, { granularity, start_time, end_time, fields = FIELDS.filter((f) => f !== "frequency").join(",") }) {
  checkWindow(start_time, end_time);
  const merged = {};
  let source = "campaign breakdown";
  try {
    let cursor;
    for (let page = 0; page < 40; page++) {
      const data = await client.request("GET", `/adaccounts/${adAccountId}/stats`, { query: { granularity, breakdown: "campaign", start_time, end_time, fields, omit_empty: true, limit: 200, cursor } });
      for (const ts of data.timeseries_stats ?? []) mergeSeries(merged, ts.timeseries_stat?.timeseries);
      const next = data.paging?.next_link;
      const nextCursor = next ? new URL(next).searchParams.get("cursor") : null;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
  } catch (e) {
    if (!/\(400\)|Unsupported/i.test(String(e.message))) throw e;
    for (const k of Object.keys(merged)) delete merged[k];
  }
  // The check: the series must add up to the spend Snap reports for the account over the same window.
  const accountSpend = await client.request("GET", `/adaccounts/${adAccountId}/stats`, { query: { granularity: "TOTAL", start_time, end_time, fields: "spend" } })
    .then((d) => Number(d.total_stats?.[0]?.total_stat?.stats?.spend ?? 0))
    .catch(() => null);
  const seriesSpend = () => Object.values(merged).reduce((n, t) => n + (t.stats.spend ?? 0), 0);
  if (accountSpend > 0 && seriesSpend() < accountSpend * 0.95) {
    // Not the whole account (or an unexpected answer): rebuild from the ACTIVE campaigns' own series.
    for (const k of Object.keys(merged)) delete merged[k];
    source = "active campaigns only";
    const campaigns = (await client.listPaged(`/adaccounts/${adAccountId}/campaigns`, "campaign")).items.filter((c) => c.status === "ACTIVE");
    for (const c of campaigns) {
      const d = await client.request("GET", `/campaigns/${c.id}/stats`, { query: { granularity, start_time, end_time, fields, omit_empty: true } });
      mergeSeries(merged, d.timeseries_stats?.[0]?.timeseries_stat?.timeseries);
    }
  }
  const covered = accountSpend > 0 ? Math.min(1, seriesSpend() / accountSpend) : 1;
  return { series: sortedSeries(merged), source, coverage_pct: Math.round(covered * 100), ...(covered < 0.95 ? { warning: `These numbers cover about ${Math.round(covered * 100)}% of the account's spend (${source}); the rest could not be broken down.` } : {}) };
}

// One row per day (synchronous limit: 31 days).
export async function dailyReport(client, { entity, id, start_time, end_time, swipe_up_attribution_window, view_attribution_window }) {
  if (!ENTITY_BASE[entity]) throw new Error("entity must be adaccount, campaign, adsquad or ad");
  checkWindow(start_time, end_time);
  const days = (new Date(end_time) - new Date(start_time)) / 86_400_000;
  if (days > 31) throw new Error("Daily reports are limited to 31 days per request");
  const attribution = attributionQuery({ swipe_up_attribution_window, view_attribution_window });
  let series;
  let accountNote = {};
  if (entity === "adaccount") {
    const acc = await accountSeries(client, id, { granularity: "DAY", start_time, end_time });
    series = acc.series;
    accountNote = { source: acc.source, coverage_pct: acc.coverage_pct, ...(acc.warning ? { warning: acc.warning } : {}) };
  } else {
    const data = await client.request("GET", `/${ENTITY_BASE[entity]}/${id}/stats`, {
      query: { granularity: "DAY", start_time, end_time, fields: FIELDS.join(","), omit_empty: true, ...attribution },
    });
    series = data.timeseries_stats?.[0]?.timeseries_stat?.timeseries ?? [];
  }
  // The date is the local day in the requested offset, whether Snap answers in that offset or in UTC.
  const rows = series.map((r) => ({ date: localDate(r.start_time, start_time), ...summarizeRow(null, null, r.stats) })).map(({ id: _i, name: _n, ...rest }) => rest);
  return { window: { start_time, end_time }, days: rows.length, ...totalsOf(series.map((r) => r.stats)), basis: basisOf(attribution), ...accountNote, rows };
}

// Totals split by country, gender, age, region, dma or make.
export async function dimensionReport(client, { entity, id, start_time, end_time, dimension }) {
  if (!ENTITY_BASE[entity]) throw new Error("entity must be campaign, adsquad or ad");
  if (!DIMENSIONS.includes(dimension)) throw new Error(`dimension must be one of ${DIMENSIONS.join(", ")}`);
  checkWindow(start_time, end_time);
  const data = await client.request("GET", `/${ENTITY_BASE[entity]}/${id}/stats`, {
    query: { granularity: "TOTAL", start_time, end_time, report_dimension: dimension, fields: FIELDS.filter((f) => f !== "frequency").join(",") },
  });
  const rows = data.total_stats?.[0]?.total_stat?.dimension_stats ?? [];
  const key = dimension === "age" ? "age_bucket" : dimension;
  const out = rows.map((r) => ({ [dimension]: r[key], ...summarizeRow(null, null, r) })).map(({ id: _i, name: _n, frequency: _f, ...rest }) => rest);
  out.sort((a, b) => b.spend - a.spend);
  return { window: { start_time, end_time }, dimension, ...totalsOf(rows), basis: basisOf(), rows_total: out.length, ...(out.length > 100 ? { truncated: true, warning: "Only the 100 highest-spend rows are listed; the totals cover all rows returned." } : {}), rows: out.slice(0, 100) };
}
