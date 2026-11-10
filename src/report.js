// Reporting helpers: stats broken down by child entity, with ROAS and CPA computed.
const FIELDS = ["impressions", "spend", "swipes", "conversion_purchases", "conversion_purchases_value", "frequency"];
const BASE = { campaign: "campaigns", adsquad: "adsquads", ad: "ads" };

// Breakdown stats can come in pages (paging.next_link sits inside total_stat). Follow them all.
export async function collectBreakdown(client, path, query, key, { maxPages = 40 } = {}) {
  const rows = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const data = await client.request("GET", path, { query: { ...query, cursor } });
    const ts = data.total_stats?.[0]?.total_stat;
    rows.push(...(ts?.breakdown_stats?.[key] ?? []));
    const next = ts?.paging?.next_link || data.paging?.next_link;
    if (!next) break;
    cursor = new URL(next).searchParams.get("cursor");
    if (!cursor) break;
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
    roas: spend ? r(value / spend) : null,
    cpa: purchases ? r(spend / purchases) : null,
    impressions,
    swipe_rate_pct: impressions ? r(((s.swipes ?? 0) / impressions) * 100) : null,
    frequency: r(s.frequency ?? 0),
  };
}

export async function breakdownReport(client, { entity, id, start_time, end_time, breakdown }) {
  const valid = { campaign: ["adsquad", "ad"], adsquad: ["ad"] };
  if (!valid[entity]?.includes(breakdown)) throw new Error(`breakdown for a ${entity} must be one of: ${(valid[entity] ?? []).join(", ") || "(not supported)"}`);
  const rows = await collectBreakdown(client, `/${BASE[entity]}/${id}/stats`, { granularity: "TOTAL", breakdown, start_time, end_time, fields: FIELDS.join(","), omit_empty: true }, breakdown);
  const children = await client.listChildren(entity, id, breakdown);
  const names = Object.fromEntries(children.map((c) => [c.id, c.name]));
  const creatives = Object.fromEntries(children.map((c) => [c.id, c.creative_id]));
  const out = rows.map((r) => ({ ...summarizeRow(names[r.id] ?? r.id, r.id, r.stats), ...(breakdown === "ad" ? { creative_id: creatives[r.id] } : {}) })).filter((r) => r.spend > 0 || r.purchases > 0);
  out.sort((a, b) => b.spend - a.spend);
  const total = out.reduce((n, r) => ({ spend: n.spend + r.spend, purchases: n.purchases + r.purchases }), { spend: 0, purchases: 0 });
  return { window: { start_time, end_time }, breakdown, total_spend: Math.round(total.spend * 100) / 100, total_purchases: total.purchases, rows: out };
}

export const DIMENSIONS = ["country", "gender", "age", "region", "dma", "make"];
const ENTITY_BASE = { campaign: "campaigns", adsquad: "adsquads", ad: "ads" };

// One row per day (synchronous limit: 31 days).
export async function dailyReport(client, { entity, id, start_time, end_time }) {
  if (!ENTITY_BASE[entity]) throw new Error("entity must be campaign, adsquad or ad");
  const days = (new Date(end_time) - new Date(start_time)) / 86_400_000;
  if (!(days > 0)) throw new Error("end_time must be after start_time");
  if (days > 31) throw new Error("Daily reports are limited to 31 days per request");
  const data = await client.request("GET", `/${ENTITY_BASE[entity]}/${id}/stats`, {
    query: { granularity: "DAY", start_time, end_time, fields: FIELDS.join(","), omit_empty: true },
  });
  const series = data.timeseries_stats?.[0]?.timeseries_stat?.timeseries ?? [];
  const rows = series.map((r) => ({ date: String(r.start_time).slice(0, 10), ...summarizeRow(null, null, r.stats) })).map(({ id: _i, name: _n, ...rest }) => rest);
  return { window: { start_time, end_time }, days: rows.length, rows };
}

// Totals split by country, gender, age, region, dma or make.
export async function dimensionReport(client, { entity, id, start_time, end_time, dimension }) {
  if (!ENTITY_BASE[entity]) throw new Error("entity must be campaign, adsquad or ad");
  if (!DIMENSIONS.includes(dimension)) throw new Error(`dimension must be one of ${DIMENSIONS.join(", ")}`);
  const data = await client.request("GET", `/${ENTITY_BASE[entity]}/${id}/stats`, {
    query: { granularity: "TOTAL", start_time, end_time, report_dimension: dimension, fields: FIELDS.filter((f) => f !== "frequency").join(",") },
  });
  const rows = data.total_stats?.[0]?.total_stat?.dimension_stats ?? [];
  const key = dimension === "age" ? "age_bucket" : dimension;
  const out = rows.map((r) => ({ [dimension]: r[key], ...summarizeRow(null, null, r) })).map(({ id: _i, name: _n, frequency: _f, ...rest }) => rest);
  out.sort((a, b) => b.spend - a.spend);
  return { window: { start_time, end_time }, dimension, rows: out.slice(0, 100) };
}
