import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT } from "../src/env.js";

const READ_ONLY = ["snap_dashboard", "snap_campaign_board", "snap_portfolio_summary", "snap_billing_check", "snap_unused_media", "snap_audience_health", "snap_funnel", "snap_catalog_feed_status", "snap_creative_compare", "snap_budget_advice", "snap_audience_insights", "snap_competitor_ads", "snap_capi_status", "snap_check_landing_pages", "snap_anomaly_check", "snap_blended_roas", "snap_list_dynamic_templates", "snap_audience_size", "snap_spend_pacing", "snap_ad_preview", "snap_connect", "snap_list_media", "snap_creative_fatigue", "snap_report_async_start", "snap_report_async_status", "snap_report_async_download", "snap_health_check", "snap_review_issues", "snap_pixel_health", "snap_api_get", "snap_list_catalogs", "snap_list_pixels", "snap_list_product_sets", "snap_list_segments", "snap_targeting_options", "snap_change_log", "snap_get_entity", "snap_get_media", "snap_get_stats", "snap_list_ads", "snap_list_adsquads", "snap_list_campaigns", "snap_list_creatives", "snap_ping", "snap_report"];
const WRITES = ["snap_set_bid_strategy", "snap_set_placement", "snap_set_frequency_cap", "snap_set_ad_schedule", "snap_capi_test_event", "snap_create_product_set", "snap_create_dynamic_template", "snap_upload_customer_list", "snap_delete", "snap_exclude_segments", "snap_set_daily_budget", "snap_set_schedule", "snap_rename", "snap_influencer_batch", "snap_clone_creative", "snap_undo", "snap_create_pixel_audience", "snap_claim_ad_code", "snap_clone_ad", "snap_copy_campaign", "snap_create_ad", "snap_create_creative", "snap_create_story_creative", "snap_create_collection_creative", "snap_copy_adsquad", "snap_create_adsquad", "snap_create_campaign", "snap_create_lookalike", "snap_influencer_ad", "snap_upload_media", "snap_set_bid", "snap_set_status", "snap_set_targeting"];

test("server starts over stdio, lists the tools, and every write tool previews by default", async () => {
  const transport = new StdioClientTransport({ command: "node", args: ["src/index.js"], cwd: ROOT, env: { PATH: process.env.PATH, SNAP_ENV_FILE: "/nonexistent/snap-test.env" } });
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...READ_ONLY, ...WRITES].sort());
    assert.ok(names.filter((n) => /delete|remove/.test(n)).every((n) => n === "snap_delete"), "the only delete tool is the guarded snap_delete");
    for (const name of WRITES) {
      const confirm = tools.find((t) => t.name === name).inputSchema.properties.confirm;
      assert.equal(confirm?.default, false, `${name} must default to confirm=false`);
    }
    const r = await client.callTool({ name: "snap_ping", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Missing SNAP_CLIENT_ID/);
  } finally {
    await client.close();
  }
});
