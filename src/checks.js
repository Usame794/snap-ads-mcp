// Read-only checks added in 0.7.0: do the ads' landing pages work, did something change sharply, and how much of Snap's
// reported revenue does the store confirm. None of them changes anything in the ad account.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { dailyReport } from "./report.js";
import { localClock } from "./insights.js";
import { shiftIso } from "./fatigue.js";

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ---------- Landing pages ----------

// Addresses a link checker must never contact: this machine, private networks, link-local (cloud metadata), reserved ranges.
export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

async function assertPublic(hostname, lookup) {
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("points to a private address");
    return;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) throw new Error("points to a private address");
  const addrs = await lookup(hostname, { all: true });
  if (!addrs.length) throw new Error("did not resolve");
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error("resolves to a private address");
}

// One link, followed through redirects by hand so every hop is checked. Only https, only public addresses.
export async function checkUrl(url, { fetchImpl = fetch, lookup = dnsLookup, timeoutMs = 8000, maxRedirects = 5, now = () => Date.now() } = {}) {
  const started = now();
  let current = url;
  const chain = [];
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const u = new URL(current);
      if (u.protocol !== "https:") return { url, verdict: "NOT_HTTPS", detail: `${hop ? "A redirect leads to" : "The link is"} ${u.protocol}//, not https`, chain };
      try {
        await assertPublic(u.hostname, lookup);
      } catch (e) {
        return { url, verdict: "UNSAFE_TARGET", detail: `${u.hostname} ${e.message}; not contacted`, chain };
      }
      const res = await fetchImpl(u, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "ads-mcp-for-snapchat link check", Accept: "text/html,*/*" } });
      await res.body?.cancel?.().catch?.(() => {});
      const status = res.status;
      chain.push(status);
      if (status >= 300 && status < 400) {
        const next = res.headers?.get?.("location");
        if (!next) return { url, verdict: "BROKEN", status, detail: "A redirect without a destination", chain };
        current = new URL(next, u).toString();
        continue;
      }
      const ms = now() - started;
      const base = { url, final_url: current === url ? undefined : current, status, ms, chain };
      if (status >= 200 && status < 300) return { ...base, verdict: ms > 5000 ? "SLOW" : "OK", detail: ms > 5000 ? `Opened, but took ${round(ms / 1000, 1)}s` : "Opens" };
      if (status === 404 || status === 410) return { ...base, verdict: "BROKEN", detail: `Page not found (${status})` };
      if (status === 401 || status === 403 || status === 429) return { ...base, verdict: "UNCHECKED", detail: `The site answered ${status} (it may block automatic checks); open it yourself` };
      if (status >= 500) return { ...base, verdict: "SERVER_ERROR", detail: `The site answered ${status}` };
      return { ...base, verdict: "BROKEN", detail: `Unexpected answer ${status}` };
    }
    return { url, verdict: "BROKEN", detail: `More than ${maxRedirects} redirects`, chain };
  } catch (e) {
    return { url, verdict: e?.name === "TimeoutError" ? "TIMEOUT" : "UNREACHABLE", detail: e?.name === "TimeoutError" ? `No answer within ${round(timeoutMs / 1000)}s` : `Could not connect (${e?.cause?.code ?? e?.message ?? "error"})`, chain };
  }
}

// The web page(s) a creative sends people to. Catalog, Story, Snap-only and app creatives have none that can be checked here.
export function urlsOfCreative(c = {}) {
  const urls = [];
  if (c.web_view_properties?.url) urls.push(c.web_view_properties.url);
  if (c.collection_properties?.web_view_properties?.url) urls.push(c.collection_properties.web_view_properties.url);
  return urls.filter((u) => typeof u === "string");
}

const sameHost = (a, b) => {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
};

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export async function landingPageReport(client, { adAccountId, requiredParams = [], maxUrls = 100, check = checkUrl, checkOptions = {} }) {
  const ads = await client.listPaged(`/adaccounts/${adAccountId}/ads`, "ad");
  const creatives = await client.listPaged(`/adaccounts/${adAccountId}/creatives`, "creative");
  const byCreative = new Map(creatives.items.map((c) => [c.id, c]));
  const active = ads.items.filter((a) => a.status === "ACTIVE");
  const byUrl = new Map();
  let withoutLink = 0;
  for (const ad of active) {
    const urls = urlsOfCreative(byCreative.get(ad.creative_id));
    if (!urls.length) withoutLink += 1;
    for (const url of urls) {
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push({ ad_id: ad.id, ad: ad.name, adsquad_id: ad.ad_squad_id });
    }
  }
  const all = [...byUrl.keys()];
  const toCheck = all.slice(0, maxUrls);
  const results = await pool(toCheck, 5, (u) => check(u, checkOptions));
  const rows = results.map((r) => {
    const missing = requiredParams.filter((p) => { try { return !new URL(r.url).searchParams.has(p); } catch { return true; } });
    return { ...r, ads: byUrl.get(r.url), ...(r.final_url && !sameHost(r.url, r.final_url) ? { lands_on_other_site: new URL(r.final_url).hostname } : {}), ...(missing.length ? { missing_params: missing } : {}) };
  });
  const problems = rows.filter((r) => !["OK"].includes(r.verdict) || r.missing_params || r.lands_on_other_site);
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  return {
    active_ads: active.length,
    ads_without_a_web_link: withoutLink,
    links_checked: rows.length,
    ...(all.length > toCheck.length ? { links_not_checked: all.length - toCheck.length, warning: `Only the first ${maxUrls} distinct links were checked.` } : {}),
    ...(ads.complete && creatives.complete ? {} : { warning_incomplete: "The ad or creative list was INCOMPLETE; some ads were not looked at." }),
    by_verdict: counts,
    problems,
    all_links_ok: !problems.length,
    not_checked: "Only whether the page opens is checked. A page that opens but shows 'out of stock' or an error message inside is not detected. Catalog, Story, Snap-only and app creatives have no web link to check.",
  };
}

// ---------- Anomalies ----------

// rows: one per full local day, oldest first, as dailyReport returns them. The last row is judged against the days before the
// last two. Thresholds are plain ratios, stated in the answer.
export function judgeDays(rows, { minSpend = 20 } = {}) {
  if (rows.length < 5) return { verdict: "NOT_ENOUGH_DATA", findings: [], note: "Needs at least 5 full days." };
  const last = rows.at(-1);
  const prev = rows.at(-2);
  const base = rows.slice(0, -2);
  const sum = (k) => base.reduce((n, r) => n + (r[k] ?? 0), 0);
  const n = base.length;
  const b = { spend: sum("spend") / n, purchases: sum("purchases") / n, value: sum("purchase_value") / n };
  b.roas = b.spend ? b.value / b.spend : null;
  b.cpa = b.purchases ? b.spend / b.purchases : null;
  if (b.spend < minSpend) return { verdict: "TOO_LITTLE_SPEND", findings: [], baseline: b, note: `The usual daily spend (${round(b.spend)}) is under ${minSpend}; too small to judge.` };
  const f = [];
  const add = (severity, code, detail) => f.push({ severity, code, detail });
  if (last.spend > b.spend * 2) add("WARN", "SPEND_SPIKE", `Spend ${round(last.spend)} vs about ${round(b.spend)} on a normal day (${round(last.spend / b.spend, 1)}x).`);
  if (last.spend < b.spend * 0.5) add("WARN", "SPEND_DROP", `Spend ${round(last.spend)} vs about ${round(b.spend)} on a normal day. Ads may have stopped (budget, review, schedule).`);
  const spending = last.spend >= b.spend * 0.5;
  if (spending && b.purchases >= 2) {
    if (last.purchases === 0 && prev.purchases === 0 && prev.spend >= b.spend * 0.5) add("CRITICAL", "TRACKING_SILENT", `Zero purchases for two days in a row while spending ${round(last.spend)} and ${round(prev.spend)} (normally about ${round(b.purchases, 1)} a day). Check the pixel and the store before spending more.`);
    else if (last.purchases === 0) add("WARN", "NO_PURCHASES", `Zero purchases yesterday (normally about ${round(b.purchases, 1)} a day). One day can be chance; look again tomorrow.`);
    else if (b.purchases >= 3 && last.purchases < b.purchases * 0.5 && last.spend >= b.spend * 0.7) add("WARN", "PURCHASES_DROP", `${last.purchases} purchases vs about ${round(b.purchases, 1)} on a normal day at similar spend.`);
  }
  if (spending && b.roas && last.roas != null && last.spend >= b.spend * 0.5 && last.roas < b.roas * 0.6 && last.purchases > 0) add("WARN", "ROAS_DROP", `ROAS ${last.roas} vs about ${round(b.roas)} normally.`);
  if (b.cpa && last.cpa != null && last.cpa > b.cpa * 1.6) add("WARN", "CPA_SPIKE", `Cost per purchase ${last.cpa} vs about ${round(b.cpa)} normally.`);
  return {
    verdict: f.some((x) => x.severity === "CRITICAL") ? "CRITICAL" : f.length ? "ATTENTION" : "NORMAL",
    findings: f,
    baseline: { days: n, avg_daily_spend: round(b.spend), avg_daily_purchases: round(b.purchases, 1), roas: b.roas == null ? null : round(b.roas), cpa: b.cpa == null ? null : round(b.cpa) },
    thresholds: "Spend over 2x or under 0.5x normal; purchases under 0.5x at similar spend, or zero; ROAS under 0.6x; cost per purchase over 1.6x. Normal = the average of the days before the last two.",
  };
}

export async function anomalyCheck(client, { adAccountId, offset = "+00:00", baselineDays = 7, minSpend = 20, now = new Date(), report = dailyReport }) {
  if (!Number.isInteger(baselineDays) || baselineDays < 3 || baselineDays > 29) throw new Error("baseline_days must be a whole number from 3 to 29");
  const clock = localClock(now, offset);
  const end = clock.todayStart;
  const start = shiftIso(end, -(baselineDays + 2) * 86_400_000);
  const rep = await report(client, { entity: "adaccount", id: adAccountId, start_time: start, end_time: end });
  const rows = rep.rows.slice(-(baselineDays + 2));
  return {
    judged_day: rows.at(-1)?.date ?? null,
    window: { start_time: start, end_time: end },
    ...judgeDays(rows, { minSpend }),
    days: rows.map((r) => ({ date: r.date, spend: r.spend, purchases: r.purchases, purchase_value: r.purchase_value, roas: r.roas, cpa: r.cpa })),
    note: "Only full local days are judged (SNAP_REPORT_UTC_OFFSET); today is left out because it is not finished. Purchases are Snap-attributed and can arrive a day late, so a single low day is a hint, not proof.",
  };
}

// ---------- Blended ROAS ----------

export async function blendedRoas(client, { adAccountId, offset = "+00:00", storeRevenue, storeOrders, days = 7, startDate, endDate, now = new Date(), report = dailyReport }) {
  let start;
  let end;
  if (startDate || endDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(endDate ?? "")) throw new Error("Give both start_date and end_date as YYYY-MM-DD (local days, both included)");
    start = `${startDate}T00:00:00${offset}`;
    end = shiftIso(`${endDate}T00:00:00${offset}`, 86_400_000);
    if (!(Date.parse(end) > Date.parse(start))) throw new Error("end_date must not be before start_date");
    if ((Date.parse(end) - Date.parse(start)) / 86_400_000 > 31) throw new Error("The window can be at most 31 days");
  } else {
    if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error("days must be a whole number from 1 to 31");
    end = localClock(now, offset).todayStart;
    start = shiftIso(end, -days * 86_400_000);
  }
  if (!(storeRevenue > 0)) throw new Error("store_revenue must be more than 0: the revenue your store (Shopify, GA, your own report) credits to Snapchat in the same days");
  const rep = await report(client, { entity: "adaccount", id: adAccountId, start_time: start, end_time: end });
  const spend = rep.total_spend;
  const snapValue = rep.total_purchase_value;
  const out = {
    window: { start_time: start, end_time: end },
    spend,
    snap_reported: { purchases: rep.total_purchases, revenue: snapValue, roas: rep.total_roas, cpa: rep.total_cpa },
    store_reported: { revenue: storeRevenue, roas: spend ? round(storeRevenue / spend) : null, ...(storeOrders > 0 ? { orders: storeOrders, cpa: spend ? round(spend / storeOrders) : null } : {}) },
  };
  if (!(spend > 0)) return { ...out, verdict: "NO_SPEND", note: "No Snap spend in this window." };
  if (!(snapValue > 0)) return { ...out, verdict: "SNAP_REPORTS_NO_REVENUE", note: "Snap reported no purchase value in this window, so there is nothing to compare. Check the pixel." };
  const ratio = snapValue / storeRevenue;
  out.snap_claims_vs_store = round(ratio);
  out.verdict = ratio > 1.15 ? "SNAP_OVERSTATES" : ratio < 0.85 ? "SNAP_UNDERSTATES" : "CONSISTENT";
  out.note =
    out.verdict === "SNAP_OVERSTATES"
      ? `Snap claims ${round(ratio, 2)}x the revenue the store confirms. Judge campaigns on the store's ROAS (${out.store_reported.roas}), not Snap's (${rep.total_roas}). Snap counts view-through and overlaps with other channels.`
      : out.verdict === "SNAP_UNDERSTATES"
        ? `The store confirms more revenue than Snap reports (Snap is ${round(ratio, 2)}x). Some Snap-driven sales are not being attributed; check the pixel and the attribution window.`
        : "Snap's revenue is within about 15% of what the store confirms.";
  out.caveat = "Only as good as the store figure you give: it must be the revenue your store credits to Snapchat (for example by utm_source) for exactly the same local days and currency.";
  return out;
}
