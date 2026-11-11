// Read-only helpers: any GET (allow-listed), segments, pixels, catalogs, product sets, targeting lookups.
const ALLOWED = ["/adaccounts/", "/campaigns/", "/adsquads/", "/ads/", "/creatives/", "/media/", "/pixels/", "/organizations/", "/catalogs/", "/segments/", "/targeting/", "/me", "/members/", "/billingcenters/", "/fundingsources/", "/mobile-apps/"];

export function checkReadPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("..") || path.includes("//") || path.includes("?")) {
    throw new Error("path must start with / and have no '..', '//' or '?'. Put query values in `query`.");
  }
  // Prefixes end in "/" and match as prefixes; "/me" is one exact endpoint, not a prefix for anything that starts with it.
  if (!ALLOWED.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p))) throw new Error(`path not allowed. It must start with one of: ${ALLOWED.join(" ")}`);
  return path;
}

export async function rawGet(client, { path, query = {}, maxChars = 20000 }) {
  checkReadPath(path);
  const data = await client.request("GET", path, { query });
  const text = JSON.stringify(data);
  return text.length <= maxChars ? data : { truncated: true, total_chars: text.length, shown_chars: maxChars, preview: text.slice(0, maxChars), note: "Narrow the request (limit, filters) or raise max_chars." };
}

async function allPages(client, path, entity, { limit = 200, maxPages = 10 } = {}) {
  const out = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const data = await client.request("GET", path, { query: { limit, cursor } });
    for (const row of data[entity] ?? []) out.push(row[entity.slice(0, -1)] ?? row);
    const next = data.paging?.next_link;
    if (!next) break;
    cursor = new URL(next).searchParams.get("cursor");
    if (!cursor) break;
  }
  return out;
}

export async function listSegments(client, adAccountId, { sourceType, minSize = 0 } = {}) {
  const rows = await allPages(client, `/adaccounts/${adAccountId}/segments`, "segments");
  return rows
    .filter((s) => (!sourceType || s.source_type === sourceType) && (s.approximate_number_users ?? 0) >= minSize)
    .map((s) => ({ id: s.id, name: s.name, source_type: s.source_type, status: s.targetable_status ?? s.status, size: s.approximate_number_users ?? 0, retention_days: s.retention_in_days }))
    .sort((a, b) => b.size - a.size);
}

export async function listPixels(client, adAccountId) {
  const rows = await allPages(client, `/adaccounts/${adAccountId}/pixels`, "pixels");
  return rows.map((p) => ({ id: p.id, name: p.name, status: p.status }));
}

export async function listCatalogs(client, orgId) {
  const data = await client.request("GET", `/organizations/${orgId}/catalogs`);
  return (data.catalogs ?? []).map((r) => r.catalog ?? r).map((c) => ({ id: c.id, name: c.name, vertical: c.vertical, status: c.status, default_product_set_id: c.default_product_set_id }));
}

export async function listProductSets(client, catalogId) {
  const data = await client.request("GET", `/catalogs/${catalogId}/product_sets`);
  return (data.product_sets ?? []).map((r) => r.product_set ?? r).map((s) => ({ id: s.id, name: s.name, status: s.status, filter: s.filter }));
}

export const TARGETING_KINDS = {
  interests_lifestyle: { path: () => "/targeting/v1/interests/scls", needsCountry: true },
  interests_shopper: { path: () => "/targeting/v1/interests/shp", needsCountry: true },
  interests_visitation: { path: () => "/targeting/v1/interests/vac", needsCountry: true },
  regions: { path: (cc) => `/targeting/v1/geo/${cc}/region` },
  languages: { path: () => "/targeting/v1/demographics/languages" },
  age_groups: { path: () => "/targeting/v1/demographics/age_group" },
};

export async function targetingOptions(client, { kind, country = "sa", search }) {
  const k = TARGETING_KINDS[kind];
  if (!k) throw new Error(`kind must be one of ${Object.keys(TARGETING_KINDS).join(", ")}`);
  const cc = String(country).toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) throw new Error("country must be a 2-letter code");
  const data = await client.request("GET", k.path(cc), { query: k.needsCountry ? { country_code: cc } : {} });
  const rows = (data.targeting_dimensions ?? []).map((r) => Object.values(r).find((v) => v && typeof v === "object" && !Array.isArray(v) && ("id" in v || "name" in v))).filter(Boolean);
  const q = search?.toLowerCase();
  return rows.filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q)).slice(0, 200).map((r) => ({ id: r.id, name: r.name ?? r.languageName ?? r.id, path: r.path }));
}

// Lookalike audience from a first-party (customer list) seed segment.
export function buildLookalike({ adAccountId, seedSegmentId, name, countries = ["SA"], type = "BALANCE", retentionDays = 180 }) {
  const n = String(name ?? "").trim();
  if (n.length < 3) throw new Error("name must be at least 3 characters");
  if (!seedSegmentId) throw new Error("seed_segment_id is required");
  const list = countries.map((c) => String(c).trim().toUpperCase());
  if (!list.length || list.some((c) => !/^[A-Z]{2}$/.test(c))) throw new Error("countries must be 2-letter codes");
  if (!["BALANCE", "SIMILARITY", "REACH"].includes(type)) throw new Error("type must be BALANCE, SIMILARITY or REACH");
  if (!(Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 180)) throw new Error("retention_days must be a whole number from 1 to 180");
  return {
    ad_account_id: adAccountId,
    name: n,
    source_type: "LOOKALIKE",
    retention_in_days: retentionDays,
    creation_spec: { seed_segment_id: seedSegmentId, country: list[0], countries: list, type },
  };
}

const PIXEL_EVENTS = ["PURCHASE", "ADD_CART", "VIEW_CONTENT", "PAGE_VIEW", "SIGN_UP", "START_CHECKOUT", "ADD_BILLING", "SEARCH", "SAVE"];

// Audience of people who fired any of the given pixel events within the retention window.
export function buildPixelAudience({ adAccountId, pixelId, name, events, retentionDays = 30 }) {
  const n = String(name ?? "").trim();
  if (n.length < 3) throw new Error("name must be at least 3 characters");
  if (!pixelId) throw new Error("pixel_id is required (or set SNAP_PIXEL_ID)");
  if (!events?.length) throw new Error("Give at least one event");
  const bad = events.filter((e) => !PIXEL_EVENTS.includes(e));
  if (bad.length) throw new Error(`Unknown event(s): ${bad.join(", ")}. Use: ${PIXEL_EVENTS.join(", ")}`);
  if (!(Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 180)) throw new Error("retention_days must be a whole number from 1 to 180");
  const spec = { or: { event: events.map((e) => ({ eq: e })) } };
  return { ad_account_id: adAccountId, name: n, source_type: "PIXEL", pixel_id: pixelId, retention_in_days: retentionDays, prefill: true, pixel_spec: JSON.stringify(spec) };
}
export { PIXEL_EVENTS };
