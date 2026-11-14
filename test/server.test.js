import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT } from "../src/env.js";

const READ_ONLY = ["snap_creative_fatigue", "snap_report_async_start", "snap_report_async_status", "snap_report_async_download", "snap_health_check", "snap_review_issues", "snap_pixel_health", "snap_report_compare", "snap_api_get", "snap_list_catalogs", "snap_list_pixels", "snap_list_product_sets", "snap_list_segments", "snap_targeting_options", "snap_change_log", "snap_get_entity", "snap_get_media", "snap_get_stats", "snap_list_ads", "snap_list_adsquads", "snap_list_campaigns", "snap_list_creatives", "snap_ping", "snap_report", "snap_report_audience", "snap_report_daily"];
const WRITES = ["snap_upload_customer_list", "snap_delete", "snap_bulk_exclude_segments", "snap_bulk_set_budget", "snap_bulk_set_schedule", "snap_bulk_rename", "snap_influencer_batch", "snap_clone_creative", "snap_undo", "snap_create_pixel_audience", "snap_claim_ad_code", "snap_clone_ad", "snap_copy_campaign", "snap_create_ad", "snap_create_creative", "snap_create_story_creative", "snap_create_collection_creative", "snap_exclude_segments", "snap_copy_adsquad", "snap_create_adsquad", "snap_create_campaign", "snap_create_lookalike", "snap_influencer_ad", "snap_upload_media", "snap_rename", "snap_set_bid", "snap_set_daily_budget", "snap_set_schedule", "snap_set_status", "snap_set_status_bulk", "snap_set_targeting"];

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
