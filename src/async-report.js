// Async (large) reports: start, check, download the CSV.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.js";

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

export async function downloadAsyncReport(client, { entity, id, report_run_id, fileName, fetchImpl = fetch, dir = join(ROOT, "exports") }) {
  const st = await asyncReportStatus(client, { entity, id, report_run_id });
  if (st.status !== "COMPLETED" || !st.download_url) return { downloaded: false, status: st.status, note: "Not ready yet. Check again in a minute." };
  const res = await fetchImpl(st.download_url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const text = await res.text();
  mkdirSync(dir, { recursive: true });
  const safe = String(fileName ?? `report-${Date.now()}.csv`).replace(/[^A-Za-z0-9._-]/g, "_");
  const path = join(dir, safe.endsWith(".csv") ? safe : safe + ".csv");
  writeFileSync(path, text);
  const lines = text.split(/\r?\n/).filter(Boolean);
  return { downloaded: true, path, rows: Math.max(lines.length - 1, 0), header: lines[0]?.slice(0, 300) };
}
