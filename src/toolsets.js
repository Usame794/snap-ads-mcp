// Tool groups. With 80+ tools some AI apps get slower or pick the wrong tool, so SNAP_TOOLSETS can limit which groups are
// offered, e.g. SNAP_TOOLSETS=setup,reports,checks for a read-only analyst. Unset means every group. Choosing fewer groups
// only hides tools; it never makes a tool less safe.
export const TOOLSETS = {
  setup: ["snap_ping", "snap_connect", "snap_change_log", "snap_setup_check", "snap_change_history"],
  read: ["snap_campaign_board", "snap_list_campaigns", "snap_list_adsquads", "snap_list_ads", "snap_list_creatives", "snap_list_media", "snap_list_segments", "snap_list_pixels", "snap_list_catalogs", "snap_list_product_sets", "snap_list_dynamic_templates", "snap_get_entity", "snap_get_media", "snap_targeting_options", "snap_api_get"],
  reports: ["snap_dashboard", "snap_get_stats", "snap_report", "snap_report_async_start", "snap_report_async_status", "snap_report_async_download", "snap_funnel", "snap_blended_roas", "snap_spend_pacing", "snap_creative_compare", "snap_portfolio_summary"],
  checks: ["snap_health_check", "snap_review_issues", "snap_pixel_health", "snap_creative_fatigue", "snap_anomaly_check", "snap_check_landing_pages", "snap_billing_check", "snap_unused_media", "snap_audience_health", "snap_catalog_feed_status", "snap_capi_status", "snap_budget_advice", "snap_audience_size", "snap_audience_insights", "snap_competitor_ads", "snap_ad_preview"],
  changes: ["snap_set_status", "snap_set_daily_budget", "snap_set_bid", "snap_set_targeting", "snap_set_schedule", "snap_set_frequency_cap", "snap_set_ad_schedule", "snap_set_bid_strategy", "snap_set_placement", "snap_exclude_segments", "snap_rename", "snap_undo", "snap_delete"],
  create: ["snap_create_campaign", "snap_create_adsquad", "snap_create_creative", "snap_create_ad", "snap_create_story_creative", "snap_create_collection_creative", "snap_create_product_set", "snap_create_dynamic_template", "snap_create_lookalike", "snap_create_pixel_audience", "snap_upload_media", "snap_upload_customer_list", "snap_copy_campaign", "snap_copy_adsquad", "snap_clone_ad", "snap_clone_creative", "snap_claim_ad_code", "snap_influencer_ad", "snap_influencer_batch", "snap_capi_test_event"],
};

const OF = new Map(Object.entries(TOOLSETS).flatMap(([group, names]) => names.map((n) => [n, group])));
// Old names that still work with SNAP_LEGACY_TOOLS=1 belong to the group of the tool that replaced them.
export const LEGACY_ALIASES = { snap_set_status_bulk: "snap_set_status", snap_bulk_rename: "snap_rename", snap_bulk_set_schedule: "snap_set_schedule", snap_bulk_exclude_segments: "snap_exclude_segments", snap_bulk_set_budget: "snap_set_daily_budget", snap_report_daily: "snap_report", snap_report_hourly: "snap_report", snap_report_compare: "snap_report", snap_report_audience: "snap_report" };
export const toolsetOf = (name) => OF.get(name) ?? OF.get(LEGACY_ALIASES[name]) ?? null;

// "core": the everyday tools for reading, checking and launching campaigns (about 40), for apps that do better with fewer tools.
// Everything else stays available: SNAP_TOOLSETS=core,reports adds a group, and the default (all) shows every tool.
export const CORE_TOOLS = [
  "snap_ping", "snap_connect", "snap_list_campaigns", "snap_list_adsquads", "snap_list_ads", "snap_list_creatives", "snap_list_media", "snap_list_segments", "snap_get_entity",
  "snap_dashboard", "snap_campaign_board", "snap_report", "snap_get_stats", "snap_spend_pacing", "snap_health_check", "snap_review_issues", "snap_anomaly_check", "snap_budget_advice", "snap_creative_fatigue",
  "snap_set_status", "snap_set_daily_budget", "snap_set_bid", "snap_set_targeting", "snap_set_schedule", "snap_rename", "snap_exclude_segments", "snap_undo", "snap_change_log", "snap_change_history", "snap_setup_check",
  "snap_create_campaign", "snap_create_adsquad", "snap_create_creative", "snap_create_ad", "snap_upload_media", "snap_copy_campaign", "snap_copy_adsquad", "snap_clone_ad",
  "snap_targeting_options", "snap_ad_preview", "snap_delete",
  // used by the playbooks, so every playbook can run with only the core tools
  "snap_check_landing_pages", "snap_audience_size", "snap_pixel_health", "snap_blended_roas", "snap_capi_status", "snap_competitor_ads", "snap_clone_creative",
];
const CORE = new Set(CORE_TOOLS);

// null = everything. Throws on an unknown group, so a typo cannot silently hide (or show) the wrong tools.
export function parseToolsets(raw) {
  if (raw === undefined || String(raw).trim() === "" || String(raw).trim().toLowerCase() === "all") return null;
  const wanted = String(raw).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = wanted.filter((w) => w !== "core" && !(w in TOOLSETS));
  if (bad.length) throw new Error(`SNAP_TOOLSETS has unknown group ${bad.join(", ")}. Groups: core, ${Object.keys(TOOLSETS).join(", ")}, or all.`);
  return [...new Set(wanted)];
}

// A tool that belongs to no group (a future tool someone forgot to list) is shown only when every group is shown.
export const toolAllowed = (toolsets, name) => toolsets === null || toolsets.includes(toolsetOf(name)) || (toolsets.includes("core") && CORE.has(name));
