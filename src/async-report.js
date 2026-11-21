// Async (large) reports: start, check, download the CSV.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./env.js";

const BASE = { adaccount: "adaccounts", campaign: "campaigns", adsquad: "adsquads", ad: "ads" };
const DEFAULT_FIELDS = ["impressions", "spend", "swipes", "conversion_purchases", "conversion_purchases_value", "frequency"];

export async function startAsyncReport(client, { entity, id, start_time, end_time, granularity = "DAY", breakdown, fields = DEFAULT_FIELDS }) {
  if (!BASE[entity]) throw new Error("entity must be adaccount, campaign, adsquad or ad");
  const query = { async: true, async_format: "csv", granularity, start_time, end_time, fields: fields.join(",") };
  if (breakdown) query.breakdown = breakdown;
  const data = await client.request("GET", `/${BASE[entity]}/${id}/stats`, { query });
  const run = data.async_stats_reports?.[0]?.async_stats_report;
  if (!run?.report_run_id) throw new Error(`No report_run_id returned: ${JSON.stringify(data).slice(0, 200)}`);
  return { report_run_id: run.report_run_id, status: run.async_status };
}

export async function asyncReportStatus(client, { entity, id, report_run_id }) {
  if (!BASE[entity]) throw new Error("entity must be adaccount, campaign, adsquad or ad");
  const data = await client.request("GET", `/${BASE[entity]}/${id}/stats_report`, { query: { report_run_id } });
  const r = data.async_stats_report_results?.[0]?.async_stats_report_result ?? data.async_stats_report ?? data.async_stats_reports?.[0]?.async_stats_report ?? data;
  return { status: r.async_status ?? r.status, download_url: r.result ?? r.download_link ?? null, raw_keys: r.async_status ? undefined : Object.keys(r) };
}

// The download link comes from an API response. Only a public https address is followed: no plain http, no localhost,
// no IP literals, no internal names.
export function checkDownloadUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error("The report download link from Snap is not a valid URL; not downloading.");
  }
  const host = u.hostname.toLowerCase();
  const ipLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
  if (u.protocol !== "https:" || ipLiteral || host === "localhost" || !host.includes(".") || /\.(local|internal|localhost)$/.test(host)) {
    throw new Error("The report download link from Snap is not a public https address; not downloading.");
  }
  return u;
}

// A report file larger than this is refused (a CSV of a very big account is well below it).
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

// Reads at most `max` bytes of a response body as text; throws if there is more.
async function readLimited(res, max) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error(`The report file is ${Math.round(declared / 1048576)} MB, over the ${Math.round(max / 1048576)} MB limit; not downloaded.`);
  if (!res.body?.getReader) {
    const text = await res.text();
    if (text.length > max) throw new Error(`The report file is over the ${Math.round(max / 1048576)} MB limit; not saved.`);
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`The report file is over the ${Math.round(max / 1048576)} MB limit; stopped downloading.`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function downloadAsyncReport(client, { entity, id, report_run_id, fileName, fetchImpl = fetch, dir = join(DATA_DIR, "exports"), maxBytes = MAX_DOWNLOAD_BYTES }) {
  const st = await asyncReportStatus(client, { entity, id, report_run_id });
  if (st.status !== "COMPLETED" || !st.download_url) return { downloaded: false, status: st.status, note: "Not ready yet. Check again in a minute." };
  checkDownloadUrl(st.download_url);
  // Redirects are not followed: the address was checked, a redirect target would not be.
  const res = await fetchImpl(st.download_url, { redirect: "manual" });
  if (res.status >= 300 && res.status < 400) throw new Error(`The download address redirected (${res.status}); redirects are not followed.`);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const text = await readLimited(res, maxBytes);
  mkdirSync(dir, { recursive: true });
  const safe = String(fileName ?? `report-${Date.now()}.csv`).replace(/[^A-Za-z0-9._-]/g, "_");
  const path = join(dir, safe.endsWith(".csv") ? safe : safe + ".csv");
  writeFileSync(path, text);
  const lines = text.split(/\r?\n/).filter(Boolean);
  return { downloaded: true, path, rows: Math.max(lines.length - 1, 0), header: lines[0]?.slice(0, 300) };
}
