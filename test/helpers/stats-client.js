// A small stand-in for SnapClient that answers the stats queries the dashboard and board make, with known numbers.
// Days are spend 10, 20, ... in account currency (micro-currency in the answers), purchases 1, 2, ...; value is 3x spend.
export function statsClient({ days = 7, campaigns = [{ id: "c1", name: "Alpha", status: "ACTIVE" }, { id: "c2", name: "Beta", status: "PAUSED" }] } = {}) {
  const day = (i) => `2026-11-${String(14 + i).padStart(2, "0")}T00:00:00.000+00:00`;
  const series = Array.from({ length: days }, (_, i) => ({ start_time: day(i), end_time: day(i + 1), stats: { spend: (i + 1) * 10e6, impressions: 1000 * (i + 1), swipes: 50 * (i + 1), conversion_purchases: i + 1, conversion_purchases_value: (i + 1) * 30e6 } }));
  const totalSpend = series.reduce((n, s) => n + s.stats.spend, 0);
  return {
    calls: [],
    async request(method, path, { query = {} } = {}) {
      this.calls.push({ method, path, query });
      if (path.endsWith("/stats") && query.granularity === "DAY") return { timeseries_stats: [{ timeseries_stat: { timeseries: series } }] };
      if (path.endsWith("/stats") && query.breakdown === "campaign") return { total_stats: [{ total_stat: { breakdown_stats: { campaign: [{ id: "c1", stats: { spend: 70e6, conversion_purchases_value: 210e6 } }, { id: "c2", stats: { spend: 0 } }] } } }] };
      if (path.endsWith("/stats") && query.breakdown === "adsquad") return { total_stats: [{ total_stat: { breakdown_stats: { adsquad: [{ id: "s1", stats: { spend: 5e6 } }] } } }] };
      if (path.endsWith("/stats")) return { total_stats: [{ total_stat: { stats: { spend: totalSpend } } }] };
      throw new Error(`unexpected ${method} ${path}`);
    },
    async listPaged(path, entity) {
      if (entity === "campaign") return { items: campaigns, complete: true };
      if (entity === "adsquad") return { items: [{ id: "s1", name: "Squad", status: "ACTIVE", campaign_id: "c1", daily_budget_micro: 25e6 }], complete: true };
      return { items: [], complete: true };
    },
    async listChildren(parent, id, child) {
      return child === "adsquad" && id === "c1" ? [{ id: "s1", name: "Squad", status: "ACTIVE", campaign_id: "c1", daily_budget_micro: 25e6 }] : [];
    },
  };
}
