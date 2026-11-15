// Several ad accounts in one answer (read-only). The server's owner lists the settings files of the accounts in
// SNAP_PORTFOLIO_FILES; the AI app cannot choose files, so it cannot point this at anything else. Each account is read with its
// own credentials and only account-level numbers are returned: no secrets, no tokens, no changes.
import { isAbsolute, basename } from "node:path";
import { existsSync } from "node:fs";
import { readEnvFile } from "./env.js";
import { dailyReport } from "./report.js";
import { judgeDays } from "./checks.js";
import { localClock } from "./insights.js";
import { shiftIso } from "./fatigue.js";
import { SnapClient } from "./snap.js";

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function parsePortfolioFiles(raw) {
  const files = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!files.length) return [];
  if (files.length > 10) throw new Error("SNAP_PORTFOLIO_FILES lists more than 10 files");
  for (const f of files) if (!isAbsolute(f)) throw new Error(`SNAP_PORTFOLIO_FILES needs absolute paths; "${f}" is not`);
  return [...new Set(files)];
}

const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);

export async function portfolioSummary({ files, defaultOffset = "+00:00", now = new Date(), makeClient = (env) => new SnapClient({ env }), report = dailyReport, exists = existsSync, readFile = readEnvFile }) {
  const accounts = [];
  for (const file of files) {
    const label = basename(file);
    try {
      if (!exists(file)) throw new Error("settings file not found");
      const env = readFile(file);
      const missing = ["SNAP_CLIENT_ID", "SNAP_CLIENT_SECRET", "SNAP_REFRESH_TOKEN", "SNAP_AD_ACCOUNT_ID"].filter((k) => !env[k]);
      if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
      const offset = env.SNAP_REPORT_UTC_OFFSET || defaultOffset;
      const client = makeClient(env);
      const acct = (await client.request("GET", `/adaccounts/${env.SNAP_AD_ACCOUNT_ID}`)).adaccounts?.[0]?.adaccount ?? {};
      const end = localClock(now, offset).todayStart;
      const start = shiftIso(end, -9 * 86_400_000);
      const rep = await report(client, { entity: "adaccount", id: env.SNAP_AD_ACCOUNT_ID, start_time: start, end_time: end });
      const rows = rep.rows.slice(-9);
      const yesterday = rows.at(-1) ?? null;
      const week = rows.slice(-7);
      const spend = sum(week, "spend");
      const value = sum(week, "purchase_value");
      const purchases = sum(week, "purchases");
      const judged = judgeDays(rows, { minSpend: 20 });
      accounts.push({
        settings_file: label,
        account: acct.name ?? null,
        status: acct.status ?? null,
        currency: acct.currency ?? null,
        read_only_server_setting: ["1", "true", "yes", "on"].includes(String(env.SNAP_READ_ONLY ?? "").toLowerCase()),
        yesterday: yesterday ? { date: yesterday.date, spend: yesterday.spend, purchases: yesterday.purchases, roas: yesterday.roas } : null,
        last_7_days: { spend: round(spend), purchases, purchase_value: round(value), roas: spend ? round(value / spend) : null, cpa: purchases ? round(spend / purchases) : null },
        attention: judged.verdict === "NORMAL" || judged.verdict === "NOT_ENOUGH_DATA" || judged.verdict === "TOO_LITTLE_SPEND" ? null : { verdict: judged.verdict, findings: judged.findings.map((f) => `${f.code}: ${f.detail}`) },
        ...(acct.status && acct.status !== "ACTIVE" ? { attention_status: `Ad account status ${acct.status}` } : {}),
      });
    } catch (e) {
      accounts.push({ settings_file: label, error: String(e.message).slice(0, 200) });
    }
  }
  // Money is only added up within one currency.
  const totals = {};
  for (const a of accounts.filter((x) => x.currency && x.last_7_days)) {
    const t = (totals[a.currency] ??= { accounts: 0, spend: 0, purchase_value: 0, purchases: 0 });
    t.accounts += 1;
    t.spend += a.last_7_days.spend;
    t.purchase_value += a.last_7_days.purchase_value;
    t.purchases += a.last_7_days.purchases;
  }
  for (const t of Object.values(totals)) {
    t.spend = round(t.spend);
    t.purchase_value = round(t.purchase_value);
    t.roas = t.spend ? round(t.purchase_value / t.spend) : null;
  }
  return {
    accounts,
    last_7_days_totals_by_currency: totals,
    needs_attention: accounts.filter((a) => a.attention || a.error || a.attention_status).map((a) => a.account ?? a.settings_file),
    note: "Last 7 full local days per account, Snap-attributed purchases. Currencies are never mixed. Each account was read with its own credentials; nothing was changed.",
  };
}
