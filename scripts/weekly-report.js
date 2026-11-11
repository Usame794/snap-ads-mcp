#!/usr/bin/env node
// Weekly Snapchat report (read-only): spend and results vs last week, health issues, tired ads, review problems, pixel issues.
// Usage: node scripts/weekly-report.js [end-date YYYY-MM-DD]   (end date = day after the last day to include; default today, Asia/Riyadh)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, ROOT } from "../src/env.js";
import { SnapClient } from "../src/snap.js";
import { healthCheck, pixelHealth, reviewIssues } from "../src/audit.js";
import { fatigueReport, shiftIso } from "../src/fatigue.js";
import { collectBreakdown, summarizeRow } from "../src/report.js";

loadEnv();
const client = new SnapClient();
const acct = process.env.SNAP_AD_ACCOUNT_ID;
const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const endDate = process.argv[2] ?? today;
if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new Error("end date must look like 2026-10-27");
const end = `${endDate}T00:00:00+03:00`;
const week = { start_time: shiftIso(end, -7 * 86_400_000), end_time: end };
const prevWeek = { start_time: shiftIso(end, -14 * 86_400_000), end_time: week.start_time };

async function byCampaign(w) {
  const rows = await collectBreakdown(client, `/adaccounts/${acct}/stats`, { granularity: "TOTAL", breakdown: "campaign", ...w, fields: "impressions,spend,swipes,conversion_purchases,conversion_purchases_value,frequency", omit_empty: true, limit: 200 }, "campaign");
  return rows.map((r) => ({ id: r.id, ...summarizeRow(null, r.id, r.stats) }));
}
const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
// ROAS of the whole account = total purchase value / total spend (not an average of per-campaign ROAS).
const roasOf = (rows) => { const s = sum(rows, "spend"); const v = sum(rows, "purchase_value"); return s ? Math.round((v / s) * 100) / 100 : null; };
const money = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
const arrow = (a, b) => (b ? `${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%` : "n/a");

const [now, before] = [await byCampaign(week), await byCampaign(prevWeek)];
const names = {};
for (let cursor, i = 0; i < 15; i++) {
  const d = await client.request("GET", `/adaccounts/${acct}/campaigns`, { query: { limit: 200, cursor } });
  for (const r of d.campaigns ?? []) names[r.campaign.id] = r.campaign.name;
  const next = d.paging?.next_link;
  if (!next) break;
  cursor = new URL(next).searchParams.get("cursor");
}
const prev = Object.fromEntries(before.map((r) => [r.id, r]));
const top = [...now].sort((a, b) => b.spend - a.spend).slice(0, 10);

const health = await healthCheck(client, { adAccountId: acct, ...week });
const review = await reviewIssues(client, { adAccountId: acct, onlyActive: true });
const pixel = await pixelHealth(client, process.env.SNAP_PIXEL_ID);
const fatigue = [];
for (const c of top.slice(0, 4)) {
  try { const f = await fatigueReport(client, { entity: "campaign", id: c.id, end_time: end, days: 7 }); fatigue.push({ name: names[c.id] ?? c.id, ...f }); } catch { /* skip campaigns whose ad stats fail */ }
}

const L = [];
L.push(`# Snapchat weekly report`, `Account: ${process.env.SNAP_AD_ACCOUNT_ID} | ${week.start_time.slice(0, 10)} to ${shiftIso(end, -86_400_000).slice(0, 10)} (vs the 7 days before)`, "");
L.push("## Totals", `- Spend: ${money(sum(now, "spend"))} (${arrow(sum(now, "spend"), sum(before, "spend"))})`, `- Purchases (Snap-attributed): ${sum(now, "purchases")} (${arrow(sum(now, "purchases"), sum(before, "purchases"))})`, `- ROAS (Snap-attributed, includes 1-day view): ${roasOf(now)} (before: ${roasOf(before)})`, "- Snap's numbers overstate results; use them to compare, not as revenue.", "");
L.push("## Top campaigns by spend", "| Campaign | Spend | vs before | ROAS | before | Frequency |", "|---|---|---|---|---|---|");
for (const c of top) { const p = prev[c.id]; L.push(`| ${(names[c.id] ?? c.id).slice(0, 52)} | ${money(c.spend)} | ${arrow(c.spend, p?.spend ?? 0)} | ${c.roas ?? "-"} | ${p?.roas ?? "-"} | ${c.frequency ?? "-"} |`); }
L.push("", "## Account health", `- Active squads checked: ${health.active_squads_checked} (${health.active_squads_with_no_spend_in_window} had no spend this week)`, `- Squads with issues: ${health.squads_with_issues}; by type: ${JSON.stringify(health.issue_counts)}`);
const noEx = health.findings.filter((f) => f.issues.some((i) => i.code === "NO_BUYER_EXCLUSION"));
if (noEx.length) L.push(`- Spending squads with no buyer exclusion: ${noEx.length} (many may be intentional catalog retargeting)`);
for (const f of health.findings.filter((x) => x.issues.some((i) => i.code !== "NO_BUYER_EXCLUSION")).slice(0, 8)) L.push(`  - ${f.adsquad.trim()} [${f.campaign.slice(0, 30)}]: ${f.issues.filter((i) => i.code !== "NO_BUYER_EXCLUSION").map((i) => i.detail).join("; ")}`);
L.push("", "## Tired ads (top campaigns)");
for (const f of fatigue) { L.push(`- ${f.name.slice(0, 50)}: ${JSON.stringify(f.counts)}`); for (const i of f.items.filter((x) => x.status === "FATIGUED").slice(0, 4)) L.push(`  - replace: ${i.name} ($${i.spend_now}): ${i.reason}`); }
L.push("", "## Ads with review problems (active squads)", `- ${review.shown} ads: ${JSON.stringify(review.by_status)} account-wide non-approved`);
for (const i of review.items.slice(0, 5)) L.push(`  - ${i.name.slice(0, 50)}: ${String(i.reasons[0] ?? i.review_status).slice(0, 110)}`);
L.push("", "## Pixel", `- Top-priority issues: ${pixel.top_priority_issues.length ? pixel.top_priority_issues.join("; ") : "none"}`, `- Spending use cases: ${pixel.spending_use_cases.map((u) => `${u.use_case}:${u.status}`).join(", ")}`, "");
const dir = join(ROOT, "exports");
mkdirSync(dir, { recursive: true });
const file = join(dir, `weekly-${endDate}.md`);
writeFileSync(file, L.join("\n"));
console.log(`Report saved: ${file}`);
console.log(L.slice(0, 12).join("\n"));
