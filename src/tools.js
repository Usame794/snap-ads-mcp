import { z } from "zod";
import { SnapClient } from "./snap.js";
import { applyChange, planBid, planBudget, planExcludeSegments, planRename, planSchedule, planStatus, planTargeting, planUndo, readLog, undoableEntries } from "./changes.js";
import { bulkEdit, plans } from "./bulk-edit.js";
import { runBatch, checkBatch } from "./influencer-batch.js";
import { createWithAutoStrip, planCloneCreative } from "./creative-tools.js";
import { buildCustomerSegment, readIdentifiers, uploadCustomerList } from "./customer-list.js";
import { asyncReportStatus, downloadAsyncReport, startAsyncReport } from "./async-report.js";
import { executeDelete, planDelete } from "./delete.js";
import { breakdownReport, dailyReport, dimensionReport, DIMENSIONS } from "./report.js";
import { compareReport, healthCheck, pixelHealth, reviewIssues } from "./audit.js";
import { fatigueReport } from "./fatigue.js";
import { buildLookalike, buildPixelAudience, PIXEL_EVENTS, listCatalogs, listPixels, listProductSets, listSegments, rawGet, targetingOptions, TARGETING_KINDS } from "./readers.js";
import { buildAdSquad, buildCampaign, createAdSquad, createCampaign, inspectMediaFile, uploadMedia } from "./create.js";
import { executeCopy, executeCopySquad, loadSource, planCopy, planCopySquad } from "./copy.js";
import { executeCloneAd, loadTargets, planCloneAd } from "./clone-ad.js";
import { executeBulkStatus, loadBulkItems, planBulkStatus } from "./bulk.js";
import { buildAd, buildCreative, claimAdCode, getMedia, runInfluencerFlow, validateAdCode } from "./influencer.js";

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] });
const wrap = (fn) => async (args) => {
  try {
    return text(await fn(args));
  } catch (e) {
    return fail(e);
  }
};

const brief = (o) => ({
  id: o.id,
  name: o.name,
  status: o.status,
  daily_budget: o.daily_budget_micro != null ? o.daily_budget_micro / 1e6 : undefined,
  campaign_id: o.campaign_id,
  ad_squad_id: o.ad_squad_id,
  optimization_goal: o.optimization_goal,
  bid_strategy: o.bid_strategy,
  updated_at: o.updated_at,
});

export function registerTools(server, client, env = process.env) {
  const defaultAccount = () => env.SNAP_AD_ACCOUNT_ID;
  const account = (id) => {
    const a = id ?? defaultAccount();
    if (!a) throw new Error("ad_account_id missing and SNAP_AD_ACCOUNT_ID not set");
    return a;
  };
  const entityEnum = z.enum(["campaign", "adsquad", "ad"]);

  server.registerTool(
    "snap_ping",
    { description: "Check the Snap credentials work and show who is authorized.", inputSchema: {} },
    wrap(async () => {
      const me = await client.request("GET", "/me");
      return { ok: true, me: me.me ?? me };
    }),
  );

  server.registerTool(
    "snap_list_campaigns",
    {
      description: "List campaigns in an ad account (read-only). Uses SNAP_AD_ACCOUNT_ID if no account is given.",
      inputSchema: { ad_account_id: z.string().optional(), status: z.enum(["ACTIVE", "PAUSED"]).optional(), limit: z.number().int().min(1).max(500).default(100) },
    },
    wrap(async ({ ad_account_id, status, limit }) => {
      const data = await client.request("GET", `/adaccounts/${account(ad_account_id)}/campaigns`, { query: { limit } });
      const rows = SnapClient.unwrap(data, "campaign").map(brief);
      return rows.filter((r) => !status || r.status === status);
    }),
  );

  server.registerTool(
    "snap_list_adsquads",
    {
      description: "List ad squads for a campaign, or for the whole ad account when only the account is given (read-only).",
      inputSchema: { campaign_id: z.string().optional(), ad_account_id: z.string().optional(), status: z.enum(["ACTIVE", "PAUSED"]).optional(), limit: z.number().int().min(1).max(500).default(100) },
    },
    wrap(async ({ campaign_id, ad_account_id, status, limit }) => {
      const path = campaign_id ? `/campaigns/${campaign_id}/adsquads` : `/adaccounts/${account(ad_account_id)}/adsquads`;
      const data = await client.request("GET", path, { query: { limit } });
      return SnapClient.unwrap(data, "adsquad").map(brief).filter((r) => !status || r.status === status);
    }),
  );

  server.registerTool(
    "snap_list_ads",
    { description: "List ads in an ad squad (read-only).", inputSchema: { adsquad_id: z.string() } },
    wrap(async ({ adsquad_id }) => {
      const data = await client.request("GET", `/adsquads/${adsquad_id}/ads`);
      return SnapClient.unwrap(data, "ad").map(brief);
    }),
  );

  server.registerTool(
    "snap_get_entity",
    { description: "Get one campaign, ad squad or ad in full, including targeting (read-only).", inputSchema: { entity: entityEnum, id: z.string() } },
    wrap(({ entity, id }) => client.getEntity(entity, id)),
  );

  server.registerTool(
    "snap_get_stats",
    {
      description: "Stats for one campaign, ad squad or ad over a window (read-only). Times must fall on the hour; spend is in micro-currency.",
      inputSchema: {
        entity: entityEnum,
        id: z.string(),
        start_time: z.string().describe("ISO date-time on the hour, with offset, e.g. 2026-10-19T00:00:00+03:00"),
        end_time: z.string(),
        granularity: z.enum(["TOTAL", "DAY", "HOUR"]).default("TOTAL"),
        fields: z.array(z.string()).default(["impressions", "spend", "swipes", "conversion_purchases", "conversion_purchases_value", "frequency"]),
      },
    },
    wrap(async ({ entity, id, start_time, end_time, granularity, fields }) => {
      const base = { campaign: "campaigns", adsquad: "adsquads", ad: "ads" }[entity];
      return client.request("GET", `/${base}/${id}/stats`, {
        query: { granularity, start_time, end_time, fields: fields.join(",") },
      });
    }),
  );

  const confirmField = z.boolean().default(false).describe("false = preview only (nothing sent). true = apply the change.");

  server.registerTool(
    "snap_set_status",
    {
      description: "Pause (PAUSED) or enable (ACTIVE) a campaign, ad squad or ad. Previews unless confirm=true. Never deletes.",
      inputSchema: { entity: entityEnum, id: z.string(), status: z.enum(["ACTIVE", "PAUSED"]), confirm: confirmField },
    },
    wrap(({ entity, id, status, confirm }) =>
      applyChange({ client, entity, id, confirm, plan: (cur) => planStatus(cur, status) }),
    ),
  );

  server.registerTool(
    "snap_set_status_bulk",
    {
      description:
        "Enable (ACTIVE) or pause (PAUSED) up to 20 campaigns, ad squads or ads in one go. Previews unless confirm=true: shows each change, skips ones already in that state, warns when a parent is paused, and for ACTIVE shows the daily budget that would start delivering. Stops at the first failure and reports exactly what changed. Never deletes.",
      inputSchema: { entity: entityEnum, ids: z.array(z.string()).min(1).max(20), status: z.enum(["ACTIVE", "PAUSED"]), confirm: confirmField },
    },
    wrap(async ({ entity, ids, status, confirm }) => {
      const items = await loadBulkItems(client, entity, ids);
      const plan = planBulkStatus({ entity, items, status });
      if (!confirm) return { applied: false, dry_run: true, preview: plan.summary, note: "Nothing was changed. Re-run with confirm=true to apply." };
      if (!plan.toChange.length) return { applied: false, note: "Nothing to change.", skipped: plan.skipped };
      const done = await executeBulkStatus({ client, entity, plan, status });
      return { applied: true, changed: done, skipped: plan.skipped, warnings: plan.warnings };
    }),
  );

  server.registerTool(
    "snap_set_daily_budget",
    {
      description:
        "Set the daily budget (in account currency, e.g. USD) on a campaign or ad squad. Refuses large jumps (default max +100%) and budgets below the minimum. Previews unless confirm=true.",
      inputSchema: { entity: z.enum(["campaign", "adsquad"]), id: z.string(), daily_budget: z.number().positive(), confirm: confirmField },
    },
    wrap(({ entity, id, daily_budget, confirm }) =>
      applyChange({ client, entity, id, confirm, plan: (cur) => planBudget(cur, daily_budget, env) }),
    ),
  );

  server.registerTool(
    "snap_exclude_segments",
    {
      description: "Add audience segments (e.g. past buyers) as EXCLUDE targeting on an ad squad, keeping existing targeting. Previews unless confirm=true.",
      inputSchema: { adsquad_id: z.string(), segment_ids: z.array(z.string()).min(1), confirm: confirmField },
    },
    wrap(({ adsquad_id, segment_ids, confirm }) =>
      applyChange({ client, entity: "adsquad", id: adsquad_id, confirm, plan: (cur) => planExcludeSegments(cur, segment_ids) }),
    ),
  );

  server.registerTool(
    "snap_copy_campaign",
    {
      description:
        "Copy a campaign with its ad squads (and optionally ads) into a NEW campaign. Everything is created PAUSED and re-timed to start shortly after enabling. Previews unless confirm=true. Review in Ads Manager, then enable with snap_set_status.",
      inputSchema: {
        campaign_id: z.string(),
        new_name: z.string().min(3),
        include_ads: z.boolean().default(true),
        budget_scale: z.number().positive().max(2).default(1).describe("Multiply every daily budget, e.g. 0.5 for half"),
        squad_ids: z.array(z.string()).optional().describe("Copy only these ad squads of the source campaign"),
        resume_campaign_id: z.string().optional().describe("Reuse an empty campaign left by a failed copy instead of creating a new one"),
        confirm: confirmField,
      },
    },
    wrap(async ({ campaign_id, new_name, include_ads, budget_scale, squad_ids, resume_campaign_id, confirm }) => {
      const src = await loadSource(client, campaign_id, { includeAds: include_ads, squadIds: squad_ids });
      if (src.campaign.name === new_name.trim()) throw new Error("new_name must differ from the source campaign name");
      const plan = planCopy({ ...src, newName: new_name, includeAds: include_ads, budgetScale: budget_scale });
      if (!confirm) return { applied: false, dry_run: true, source: src.campaign.name, would_create: plan.summary, note: "Nothing was created. Re-run with confirm=true to create it (all PAUSED)." };
      const created = await executeCopy({ client, plan, sourceCampaignId: campaign_id, resumeCampaignId: resume_campaign_id });
      return { applied: true, created, note: "Everything is PAUSED. Review in Ads Manager, then enable the campaign, ad squads and ads." };
    }),
  );

  server.registerTool(
    "snap_list_creatives",
    {
      description: "List creatives in an ad account (read-only), so you can see what can be reused.",
      inputSchema: { ad_account_id: z.string().optional(), limit: z.number().int().min(1).max(500).default(50) },
    },
    wrap(async ({ ad_account_id, limit }) => {
      const data = await client.request("GET", `/adaccounts/${account(ad_account_id)}/creatives`, { query: { limit } });
      return (data.creatives ?? []).map((r) => r.creative ?? r).map((c) => ({ id: c.id, name: c.name, type: c.type, render_type: c.render_type, status: c.status, updated_at: c.updated_at }));
    }),
  );

  server.registerTool(
    "snap_clone_ad",
    {
      description:
        "Clone an existing ad (same creative) into other ad squads. New ads are created PAUSED. Skips squads that already have an ad with that creative. Previews unless confirm=true.",
      inputSchema: {
        ad_id: z.string(),
        target_adsquad_ids: z.array(z.string()).min(1).max(20),
        new_name: z.string().optional().describe("Name for the new ads; defaults to the source ad name"),
        confirm: confirmField,
      },
    },
    wrap(async ({ ad_id, target_adsquad_ids, new_name, confirm }) => {
      const sourceAd = await client.getEntity("ad", ad_id);
      const targets = await loadTargets(client, target_adsquad_ids);
      const sourceSquad = await client.getEntity("adsquad", sourceAd.ad_squad_id);
      const plan = planCloneAd({ sourceAd, targets, newName: new_name, sourceSquad });
      if (!confirm) return { applied: false, dry_run: true, would_create: plan.summary, note: "Nothing was created. Re-run with confirm=true (new ads are PAUSED)." };
      if (!plan.toCreate.length) return { applied: false, note: "Nothing to create: every target was skipped.", skipped: plan.skipped };
      const created = await executeCloneAd({ client, plan, sourceAdId: ad_id });
      return { applied: true, created, skipped: plan.skipped, note: "New ads are PAUSED. Review in Ads Manager, then enable with snap_set_status." };
    }),
  );

  const brandProfile = (id) => {
    const p = id ?? env.SNAP_BRAND_PROFILE_ID;
    if (!p) throw new Error("profile_id missing and SNAP_BRAND_PROFILE_ID not set");
    return p;
  };

  server.registerTool(
    "snap_get_media",
    { description: "Get a media asset and its processing status (read-only). Use after claiming an ad code.", inputSchema: { media_id: z.string() } },
    wrap(async ({ media_id }) => {
      const m = await getMedia(client, media_id);
      return { id: m.id, type: m.type, media_status: m.media_status, duration_in_seconds: m.duration_in_seconds, content_source_type: m.content_source_type, video_metadata: m.video_metadata };
    }),
  );

  server.registerTool(
    "snap_claim_ad_code",
    {
      description:
        "Claim a creator's ad code (adcode_<uuid>) into the ad account. ONE-WAY: the code is single-use and cannot be unclaimed. Previews (format check only, nothing sent) unless confirm=true.",
      inputSchema: { ad_code: z.string(), profile_id: z.string().optional().describe("Brand profile id; defaults to SNAP_BRAND_PROFILE_ID"), confirm: confirmField },
    },
    wrap(async ({ ad_code, profile_id, confirm }) => {
      const code = validateAdCode(ad_code);
      const profileId = brandProfile(profile_id);
      if (!confirm) return { applied: false, dry_run: true, ad_code_format: "valid", ad_account: account(), brand_profile_id: profileId, warning: "Claiming uses up the creator's single-use code. Nothing was sent. Re-run with confirm=true." };
      const mediaId = await claimAdCode(client, { adAccountId: account(), adCode: code, profileId });
      return { applied: true, media_id: mediaId, next: "Poll with snap_get_media until media_status is READY, then snap_create_creative." };
    }),
  );

  server.registerTool(
    "snap_create_creative",
    {
      description: "Create a WEB_VIEW creative from a READY media asset (for example a claimed creator post). Previews unless confirm=true.",
      inputSchema: {
        media_id: z.string(),
        name: z.string(),
        headline: z.string().describe("Max 34 characters"),
        url: z.string().describe("https:// landing page"),
        call_to_action: z.string().default("SHOP_NOW"),
        profile_id: z.string().optional(),
        confirm: confirmField,
      },
    },
    wrap(async ({ media_id, name, headline, url, call_to_action, profile_id, confirm }) => {
      const obj = buildCreative({ adAccountId: account(), profileId: brandProfile(profile_id), mediaId: media_id, name, headline, callToAction: call_to_action, url });
      const media = await getMedia(client, media_id);
      if (media.media_status !== "READY") throw new Error(`Media is ${media.media_status}, not READY yet`);
      if (!confirm) return { applied: false, dry_run: true, would_create: { name: obj.name, headline: obj.headline, cta: obj.call_to_action, url: obj.web_view_properties.url, media: media_id }, note: "Nothing created. Re-run with confirm=true." };
      const created = await client.createEntity("creative", obj);
      return { applied: true, creative_id: created.id, name: created.name };
    }),
  );

  server.registerTool(
    "snap_create_ad",
    {
      description: "Create an ad from an existing creative inside an ad squad. Always created PAUSED. Previews unless confirm=true.",
      inputSchema: { creative_id: z.string(), adsquad_id: z.string(), name: z.string(), ad_type: z.string().default("REMOTE_WEBPAGE"), confirm: confirmField },
    },
    wrap(async ({ creative_id, adsquad_id, name, ad_type, confirm }) => {
      const squad = await client.getEntity("adsquad", adsquad_id);
      const obj = buildAd({ adSquadId: adsquad_id, creativeId: creative_id, name, type: ad_type });
      if (!confirm) return { applied: false, dry_run: true, would_create: { name: obj.name, in_adsquad: squad.name, squad_status: squad.status, type: obj.type, status: "PAUSED" }, note: "Nothing created. Re-run with confirm=true." };
      const created = await client.createEntity("ad", obj);
      return { applied: true, ad_id: created.id, status: "PAUSED" };
    }),
  );

  server.registerTool(
    "snap_influencer_ad",
    {
      description:
        "Full influencer flow in one step: claim a creator ad code, wait for the media, create a WEB_VIEW creative, and create a PAUSED ad in the given ad squad. Claiming is one-way (single-use code). Previews (nothing sent) unless confirm=true.",
      inputSchema: {
        ad_code: z.string(),
        adsquad_id: z.string(),
        name: z.string().describe("Used for the creative and the ad, e.g. 'Paid - handle - SKU'"),
        headline: z.string(),
        url: z.string(),
        call_to_action: z.string().default("SHOP_NOW"),
        profile_id: z.string().optional(),
        confirm: confirmField,
      },
    },
    wrap(async ({ ad_code, adsquad_id, name, headline, url, call_to_action, profile_id, confirm }) => {
      const code = validateAdCode(ad_code);
      const profileId = brandProfile(profile_id);
      const squad = await client.getEntity("adsquad", adsquad_id);
      buildCreative({ adAccountId: account(), profileId, mediaId: "preview", name, headline, callToAction: call_to_action, url });
      if (!confirm) {
        return { applied: false, dry_run: true, will_do: ["claim ad code (one-way, single-use)", "wait for media READY", "create WEB_VIEW creative", "create PAUSED ad"], in_adsquad: { name: squad.name, status: squad.status }, creative: { name, headline, cta: call_to_action, url }, note: "Nothing was sent. Re-run with confirm=true." };
      }
      const done = await runInfluencerFlow({ client, adAccountId: account(), profileId, adCode: code, adSquadId: adsquad_id, name, headline, callToAction: call_to_action, url });
      return { applied: true, ...done, status: "PAUSED" };
    }),
  );

  server.registerTool(
    "snap_rename",
    { description: "Rename a campaign, ad squad or ad. Previews unless confirm=true.", inputSchema: { entity: entityEnum, id: z.string(), new_name: z.string().min(3), confirm: confirmField } },
    wrap(({ entity, id, new_name, confirm }) => applyChange({ client, entity, id, confirm, plan: (cur) => planRename(cur, new_name) })),
  );

  server.registerTool(
    "snap_set_bid",
    {
      description: "Set the max bid (account currency) on an ad squad that uses a max bid. Refuses increases above +50% (SNAP_MAX_BID_INCREASE_PCT) and auto-bid squads. Previews unless confirm=true.",
      inputSchema: { adsquad_id: z.string(), bid: z.number().positive(), confirm: confirmField },
    },
    wrap(({ adsquad_id, bid, confirm }) => applyChange({ client, entity: "adsquad", id: adsquad_id, confirm, plan: (cur) => planBid(cur, bid, env) })),
  );

  server.registerTool(
    "snap_copy_adsquad",
    {
      description: "Copy one ad squad (optionally with its ads) into a target campaign. Created PAUSED. Previews unless confirm=true.",
      inputSchema: {
        adsquad_id: z.string(),
        target_campaign_id: z.string(),
        new_name: z.string().optional(),
        include_ads: z.boolean().default(false),
        budget_scale: z.number().positive().max(2).default(1),
        confirm: confirmField,
      },
    },
    wrap(async ({ adsquad_id, target_campaign_id, new_name, include_ads, budget_scale, confirm }) => {
      const squad = await client.getEntity("adsquad", adsquad_id, { return_placement_v2: true });
      const target = await client.getEntity("campaign", target_campaign_id);
      const ads = include_ads ? await client.listChildren("adsquad", adsquad_id, "ad") : [];
      const plan = planCopySquad({ squad, ads, newName: new_name, budgetScale: budget_scale });
      if (!confirm) return { applied: false, dry_run: true, would_create_in_campaign: target.name, would_create: plan.summary, note: "Nothing created. Re-run with confirm=true (PAUSED)." };
      const created = await executeCopySquad({ client, plan, targetCampaignId: target_campaign_id, sourceSquadId: adsquad_id });
      return { applied: true, adsquad_id: created.adsquad.id, ads_created: created.ads, status: "PAUSED" };
    }),
  );

  server.registerTool(
    "snap_report",
    {
      description: "Performance table for a campaign or ad squad broken down by ad squad or ad: spend, purchases, ROAS, CPA, swipe rate and frequency (read-only). Times must fall on the hour, with offset.",
      inputSchema: {
        entity: z.enum(["campaign", "adsquad"]),
        id: z.string(),
        breakdown: z.enum(["adsquad", "ad"]),
        start_time: z.string().describe("e.g. 2026-10-19T00:00:00+03:00"),
        end_time: z.string(),
      },
    },
    wrap((args) => breakdownReport(client, args)),
  );

  server.registerTool(
    "snap_create_campaign",
    {
      description: "Create a new, empty campaign (always PAUSED, starting shortly after you enable it). Add ad squads with snap_copy_adsquad. Previews unless confirm=true.",
      inputSchema: { name: z.string().min(3), objective: z.enum(["SALES", "TRAFFIC", "AWARENESS", "ENGAGEMENT", "LEADS", "APP_PROMOTION"]).default("SALES"), confirm: confirmField },
    },
    wrap(async ({ name, objective, confirm }) => {
      const campaign = buildCampaign({ adAccountId: account(), name, objective });
      if (!confirm) return { applied: false, dry_run: true, would_create: { name: campaign.name, objective, status: "PAUSED" }, note: "Nothing created. Re-run with confirm=true." };
      const created = await createCampaign({ client, campaign });
      return { applied: true, campaign_id: created.id, status: "PAUSED" };
    }),
  );

  server.registerTool(
    "snap_upload_media",
    {
      description: "Upload a local video (.mp4/.mov) or image (.jpg/.png), up to 1 GB (files over 32 MB go in chunks), to the ad account. It is not attached to any ad. Then poll snap_get_media until READY and use snap_create_creative. Previews (file check only) unless confirm=true.",
      inputSchema: { file_path: z.string().describe("Absolute path on this machine"), name: z.string().optional(), confirm: confirmField },
    },
    wrap(async ({ file_path, name, confirm }) => {
      const info = inspectMediaFile(file_path);
      if (!confirm) return { applied: false, dry_run: true, file: info.fileName, type: info.type, megabytes: Math.round((info.size / 1048576) * 10) / 10, note: "Nothing uploaded. Re-run with confirm=true." };
      return { applied: true, ...(await uploadMedia({ client, adAccountId: account(), filePath: file_path, name })) };
    }),
  );

  server.registerTool(
    "snap_create_adsquad",
    {
      description:
        "Create a new ad squad from a few choices (purchase-optimized web squad with a max bid). Always PAUSED. Previews unless confirm=true. Pixel defaults to SNAP_PIXEL_ID.",
      inputSchema: {
        campaign_id: z.string(),
        name: z.string().min(3),
        daily_budget: z.number().min(5),
        bid: z.number().positive().optional().describe("Max bid in account currency (required unless bid_strategy is AUTO_BID)"),
        bid_strategy: z.enum(["LOWEST_COST_WITH_MAX_BID", "AUTO_BID"]).default("LOWEST_COST_WITH_MAX_BID"),
        pixel_id: z.string().optional(),
        interests: z.array(z.string()).optional().describe("Interest ids like SLC_11 (see snap_targeting_options)"),
        os_type: z.enum(["iOS", "ANDROID"]).optional(),
        exclude_segment_ids: z.array(z.string()).optional().describe("e.g. past-buyer audiences"),
        include_segment_ids: z.array(z.string()).optional(),
        countries: z.array(z.string()).default(["sa"]),
        min_age: z.number().int().min(13).max(50).optional(),
        max_age: z.number().int().min(13).max(50).optional(),
        gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
        conversion_window: z.enum(["SWIPE_7DAY", "SWIPE_28DAY_VIEW_1DAY"]).default("SWIPE_7DAY"),
        confirm: confirmField,
      },
    },
    wrap(async (a) => {
      const campaign = await client.getEntity("campaign", a.campaign_id);
      const adsquad = buildAdSquad({ campaignId: a.campaign_id, name: a.name, dailyBudget: a.daily_budget, bid: a.bid, bidStrategy: a.bid_strategy, pixelId: a.pixel_id ?? env.SNAP_PIXEL_ID, countries: a.countries, minAge: a.min_age, maxAge: a.max_age, gender: a.gender, interests: a.interests, osType: a.os_type, excludeSegmentIds: a.exclude_segment_ids, includeSegmentIds: a.include_segment_ids, conversionWindow: a.conversion_window });
      const summary = { name: adsquad.name, in_campaign: campaign.name, daily_budget: a.daily_budget, bid_strategy: a.bid_strategy, max_bid: a.bid, countries: a.countries, excluded_segments: a.exclude_segment_ids?.length ?? 0, interests: a.interests?.length ?? 0, os_type: a.os_type, goal: adsquad.optimization_goal, conversion_window: adsquad.conversion_window, status: "PAUSED" };
      if (!a.confirm) return { applied: false, dry_run: true, would_create: summary, note: "Nothing created. Re-run with confirm=true (PAUSED)." };
      const created = await createAdSquad({ client, adsquad });
      return { applied: true, adsquad_id: created.id, status: "PAUSED" };
    }),
  );

  server.registerTool(
    "snap_set_targeting",
    {
      description: "Change an ad squad's targeting: countries, age, gender, interests, device OS, include segments, or stop excluding segments. Everything not mentioned is kept. Previews unless confirm=true.",
      inputSchema: {
        adsquad_id: z.string(),
        countries: z.array(z.string()).optional(),
        min_age: z.number().int().min(13).max(50).optional(),
        max_age: z.number().int().min(13).max(50).optional(),
        gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
        interests: z.array(z.string()).optional().describe("Replace interests with these ids (e.g. SLC_11); use snap_targeting_options to find ids"),
        clear_interests: z.boolean().optional(),
        os_type: z.enum(["iOS", "ANDROID"]).optional(),
        clear_devices: z.boolean().optional(),
        include_segments: z.array(z.string()).optional(),
        remove_exclusions: z.array(z.string()).optional().describe("Segment ids to stop excluding"),
        confirm: confirmField,
      },
    },
    wrap(({ adsquad_id, countries, min_age, max_age, gender, interests, clear_interests, os_type, clear_devices, include_segments, remove_exclusions, confirm }) =>
      applyChange({ client, entity: "adsquad", id: adsquad_id, confirm, plan: (cur) => planTargeting(cur, { countries, minAge: min_age, maxAge: max_age, gender, interests, clearInterests: clear_interests, osType: os_type, clearDevices: clear_devices, includeSegments: include_segments, removeExclusions: remove_exclusions }) }),
    ),
  );

  server.registerTool(
    "snap_set_schedule",
    {
      description: "Set start_time and/or end_time (ISO with offset) on a campaign or ad squad. end_time must be in the future and after the start. Previews unless confirm=true.",
      inputSchema: { entity: z.enum(["campaign", "adsquad"]), id: z.string(), start_time: z.string().optional(), end_time: z.string().optional(), confirm: confirmField },
    },
    wrap(({ entity, id, start_time, end_time, confirm }) =>
      applyChange({ client, entity, id, confirm, plan: (cur) => planSchedule(cur, { startTime: start_time, endTime: end_time }) }),
    ),
  );

  server.registerTool(
    "snap_api_get",
    {
      description: "Read-only GET against the Snap Marketing API for anything without a dedicated tool (allow-listed paths only, e.g. /adaccounts/{id}/..., /pixels/{id}/..., /organizations/{id}/...). Query values go in `query`. Never writes.",
      inputSchema: { path: z.string().describe("Starts with /, no query string"), query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}), max_chars: z.number().int().min(1000).max(100000).default(20000) },
    },
    wrap(({ path, query, max_chars }) => rawGet(client, { path, query, maxChars: max_chars })),
  );

  server.registerTool(
    "snap_list_segments",
    {
      description: "List audience segments (customer lists, pixel, engagement, lookalike) with size and status, largest first (read-only).",
      inputSchema: { source_type: z.enum(["FIRST_PARTY", "PIXEL", "ENGAGEMENT", "LOOKALIKE"]).optional(), min_size: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(300).default(60), ad_account_id: z.string().optional() },
    },
    wrap(async ({ source_type, min_size, limit, ad_account_id }) => (await listSegments(client, account(ad_account_id), { sourceType: source_type, minSize: min_size })).slice(0, limit)),
  );

  server.registerTool("snap_list_pixels", { description: "List the Snap pixels of the ad account (read-only).", inputSchema: { ad_account_id: z.string().optional() } }, wrap(({ ad_account_id }) => listPixels(client, account(ad_account_id))));

  server.registerTool(
    "snap_list_catalogs",
    { description: "List product catalogs of the organization (read-only). Organization id defaults to the ad account's organization.", inputSchema: { organization_id: z.string().optional() } },
    wrap(async ({ organization_id }) => {
      const org = organization_id ?? (await client.request("GET", `/adaccounts/${account()}`)).adaccounts[0].adaccount.organization_id;
      return listCatalogs(client, org);
    }),
  );

  server.registerTool("snap_list_product_sets", { description: "List product sets of a catalog (read-only).", inputSchema: { catalog_id: z.string() } }, wrap(({ catalog_id }) => listProductSets(client, catalog_id)));

  server.registerTool(
    "snap_targeting_options",
    {
      description: "Look up targeting ids (read-only): interests (lifestyle, shopper, visitation), regions, languages, age groups. Use the returned ids with snap_set_targeting.",
      inputSchema: { kind: z.enum(Object.keys(TARGETING_KINDS)), country: z.string().default("sa"), search: z.string().optional() },
    },
    wrap(({ kind, country, search }) => targetingOptions(client, { kind, country, search })),
  );

  server.registerTool(
    "snap_create_lookalike",
    {
      description: "Create a lookalike audience from a first-party (customer list) seed segment. Creates an audience only, nothing is delivered. Previews unless confirm=true.",
      inputSchema: {
        seed_segment_id: z.string(),
        name: z.string().min(3),
        countries: z.array(z.string()).default(["SA"]),
        type: z.enum(["BALANCE", "SIMILARITY", "REACH"]).default("BALANCE"),
        retention_days: z.number().int().min(1).max(180).default(180),
        confirm: confirmField,
      },
    },
    wrap(async ({ seed_segment_id, name, countries, type, retention_days, confirm }) => {
      const seed = await client.getEntity("segment", seed_segment_id);
      const obj = buildLookalike({ adAccountId: account(), seedSegmentId: seed_segment_id, name, countries, type, retentionDays: retention_days });
      if (!confirm) return { applied: false, dry_run: true, would_create: { name: obj.name, type, countries: obj.creation_spec.countries, seed: seed.name, seed_size: seed.approximate_number_users, seed_source: seed.source_type }, note: "Nothing created. Re-run with confirm=true." };
      const created = await client.createEntity("segment", obj);
      return { applied: true, segment_id: created.id, name: created.name };
    }),
  );

  server.registerTool(
    "snap_report_daily",
    {
      description: "Day-by-day performance (spend, purchases, ROAS, CPA, swipe rate) for a campaign, ad squad or ad, up to 31 days (read-only). Day boundaries must be local midnight with offset.",
      inputSchema: { entity: z.enum(["campaign", "adsquad", "ad"]), id: z.string(), start_time: z.string().describe("e.g. 2026-10-01T00:00:00+03:00"), end_time: z.string() },
    },
    wrap((args) => dailyReport(client, args)),
  );

  server.registerTool(
    "snap_report_audience",
    {
      description: "Performance split by country, gender, age, region, dma or make (read-only), for a campaign, ad squad or ad.",
      inputSchema: { entity: z.enum(["campaign", "adsquad", "ad"]), id: z.string(), dimension: z.enum(DIMENSIONS), start_time: z.string(), end_time: z.string() },
    },
    wrap((args) => dimensionReport(client, args)),
  );

  server.registerTool(
    "snap_health_check",
    {
      description: "Audit every ACTIVE campaign's ACTIVE ad squads (read-only): no buyer exclusion, high frequency, low swipe rate, low ROAS, spend with no purchases, squads under a paused campaign. Returns the ad squad ids to act on.",
      inputSchema: {
        start_time: z.string().describe("Window start, e.g. 2026-10-19T00:00:00+03:00"),
        end_time: z.string(),
        max_frequency: z.number().default(5),
        min_swipe_rate_pct: z.number().default(0.15),
        min_spend: z.number().default(100),
        min_roas: z.number().default(3),
      },
    },
    wrap(({ start_time, end_time, max_frequency, min_swipe_rate_pct, min_spend, min_roas }) =>
      healthCheck(client, { adAccountId: account(), start_time, end_time, thresholds: { maxFrequency: max_frequency, minSwipeRatePct: min_swipe_rate_pct, minSpend: min_spend, minRoas: min_roas } }),
    ),
  );

  server.registerTool(
    "snap_review_issues",
    {
      description: "Ads that are rejected or pending review, with Snap's reasons (read-only). By default only ads whose ad squad is ACTIVE.",
      inputSchema: { only_active: z.boolean().default(true) },
    },
    wrap(({ only_active }) => reviewIssues(client, { adAccountId: account(), onlyActive: only_active })),
  );

  server.registerTool(
    "snap_pixel_health",
    { description: "Pixel signal readiness and event-quality recommendations, highest priority first (read-only). Pixel defaults to SNAP_PIXEL_ID.", inputSchema: { pixel_id: z.string().optional() } },
    wrap(({ pixel_id }) => pixelHealth(client, pixel_id ?? env.SNAP_PIXEL_ID)),
  );

  server.registerTool(
    "snap_report_compare",
    {
      description: "Compare two time windows for a campaign, ad squad or ad, optionally per child (ad squads or ads): spend, purchases, ROAS, CPA, frequency, swipe rate and the changes (read-only).",
      inputSchema: {
        entity: z.enum(["campaign", "adsquad", "ad"]),
        id: z.string(),
        breakdown: z.enum(["adsquad", "ad"]).optional(),
        current_start: z.string(), current_end: z.string(),
        previous_start: z.string(), previous_end: z.string(),
      },
    },
    wrap(({ entity, id, breakdown, current_start, current_end, previous_start, previous_end }) =>
      compareReport(client, { entity, id, breakdown, current: { start_time: current_start, end_time: current_end }, previous: { start_time: previous_start, end_time: previous_end } }),
    ),
  );

  const idsField = z.array(z.string()).min(1).max(20);

  server.registerTool(
    "snap_bulk_exclude_segments",
    { description: "Add the same buyer-exclusion audiences to up to 20 ad squads. Per-item preview (skips squads that already exclude them); stops at the first failure. Previews unless confirm=true.", inputSchema: { adsquad_ids: idsField, segment_ids: z.array(z.string()).min(1), confirm: confirmField } },
    wrap(({ adsquad_ids, segment_ids, confirm }) => bulkEdit({ client, entity: "adsquad", ids: adsquad_ids, buildPlan: plans.exclude(segment_ids), confirm })),
  );

  server.registerTool(
    "snap_bulk_set_budget",
    {
      description: "Change the daily budget of up to 20 ad squads at once: mode 'set' (same value for all) or 'scale' (multiply each, e.g. 0.5 = half). Every item keeps the single-item guards (max +100%, minimum budget). Previews unless confirm=true.",
      inputSchema: { adsquad_ids: idsField, mode: z.enum(["set", "scale"]), value: z.number().positive(), confirm: confirmField },
    },
    wrap(({ adsquad_ids, mode, value, confirm }) => bulkEdit({ client, entity: "adsquad", ids: adsquad_ids, buildPlan: mode === "set" ? plans.budgetSet(value, env) : plans.budgetScale(value, env), confirm })),
  );

  server.registerTool(
    "snap_bulk_set_schedule",
    { description: "Set start/end time on up to 20 campaigns or ad squads. Previews unless confirm=true.", inputSchema: { entity: z.enum(["campaign", "adsquad"]), ids: idsField, start_time: z.string().optional(), end_time: z.string().optional(), confirm: confirmField } },
    wrap(({ entity, ids, start_time, end_time, confirm }) => bulkEdit({ client, entity, ids, buildPlan: plans.schedule({ startTime: start_time, endTime: end_time }), confirm })),
  );

  server.registerTool(
    "snap_bulk_rename",
    { description: "Find-and-replace inside the names of up to 20 campaigns, ad squads or ads. Previews unless confirm=true.", inputSchema: { entity: entityEnum, ids: idsField, find: z.string().min(1), replace: z.string().default(""), confirm: confirmField } },
    wrap(({ entity, ids, find, replace, confirm }) => bulkEdit({ client, entity, ids, buildPlan: plans.rename(find, replace), confirm })),
  );

  server.registerTool(
    "snap_influencer_batch",
    {
      description:
        "Influencer flow for up to 10 ad codes into one ad squad: for each, claim, wait for media, create creative, create a PAUSED ad. Expired codes are skipped and reported, others continue. Stops if a claimed code ends up incomplete. Claiming is one-way. Previews (format check only) unless confirm=true.",
      inputSchema: {
        adsquad_id: z.string(),
        items: z.array(z.object({ ad_code: z.string(), name: z.string().describe("e.g. 'Paid - handle - SKU'"), ref: z.string().optional().describe("Your own reference, e.g. the Airtable request id") })).min(1).max(10),
        headline: z.string(),
        url: z.string(),
        call_to_action: z.string().default("SHOP_NOW"),
        profile_id: z.string().optional(),
        confirm: confirmField,
      },
    },
    wrap(async ({ adsquad_id, items, headline, url, call_to_action, profile_id, confirm }) => {
      const checked = checkBatch(items);
      const profileId = brandProfile(profile_id);
      const squad = await client.getEntity("adsquad", adsquad_id);
      buildCreative({ adAccountId: account(), profileId, mediaId: "preview", name: "preview", headline, callToAction: call_to_action, url });
      if (!confirm) return { applied: false, dry_run: true, in_adsquad: { name: squad.name, status: squad.status }, codes: checked.length, names: checked.map((c) => c.name), warning: "Each successful claim uses up that creator's single-use code. Nothing was sent. Re-run with confirm=true.", note: "Expired codes cost nothing: they are skipped." };
      return runBatch({ client, adAccountId: account(), profileId, adSquadId: adsquad_id, headline, callToAction: call_to_action, url, items });
    }),
  );

  server.registerTool(
    "snap_clone_creative",
    {
      description: "Duplicate a creative with a new name and optionally a new headline, link or call to action (same media). Creatives have no status, so nothing delivers until you attach one to an ad. Previews unless confirm=true.",
      inputSchema: { creative_id: z.string(), name: z.string().min(3), headline: z.string().optional(), url: z.string().optional(), call_to_action: z.string().optional(), confirm: confirmField },
    },
    wrap(async ({ creative_id, name, headline, url, call_to_action, confirm }) => {
      const source = await client.getEntity("creative", creative_id);
      const plan = planCloneCreative(source, { name, headline, url, callToAction: call_to_action });
      if (!confirm) return { applied: false, dry_run: true, would_create: plan.summary, note: "Nothing created. Re-run with confirm=true." };
      const { created, stripped } = await createWithAutoStrip(client, "creative", { ...plan.obj, ad_account_id: source.ad_account_id });
      return { applied: true, creative_id: created.id, name: created.name, fields_snap_would_not_accept: stripped };
    }),
  );

  server.registerTool(
    "snap_undo",
    {
      description: "Revert one of the changes this server applied (budget, bid, status, targeting, schedule, rename) using the change log. Refuses if the field was changed again since, unless force=true. Not for creates, claims or copies. Previews unless confirm=true.",
      inputSchema: { n_from_last: z.number().int().min(1).max(50).default(1).describe("1 = the most recent undoable change"), force: z.boolean().default(false), confirm: confirmField },
    },
    wrap(async ({ n_from_last, force, confirm }) => {
      const list = undoableEntries();
      const entry = list[list.length - n_from_last];
      if (!entry) throw new Error("No undoable change found at that position");
      const result = await applyChange({ client, entity: entry.entity, id: entry.id, confirm, plan: (cur) => planUndo(entry, cur, { force }), logExtra: { undoes: entry.at } });
      return { ...result, reverting: { at: entry.at, name: entry.name, change: entry.change } };
    }),
  );

  server.registerTool(
    "snap_create_pixel_audience",
    {
      description: "Create an audience of people who fired pixel events (e.g. ADD_CART or VIEW_CONTENT) within N days. Audience only, nothing is delivered. Pixel defaults to SNAP_PIXEL_ID. Previews unless confirm=true.",
      inputSchema: { name: z.string().min(3), events: z.array(z.enum(PIXEL_EVENTS)).min(1), retention_days: z.number().int().min(1).max(180).default(30), pixel_id: z.string().optional(), confirm: confirmField },
    },
    wrap(async ({ name, events, retention_days, pixel_id, confirm }) => {
      const obj = buildPixelAudience({ adAccountId: account(), pixelId: pixel_id ?? env.SNAP_PIXEL_ID, name, events, retentionDays: retention_days });
      if (!confirm) return { applied: false, dry_run: true, would_create: { name: obj.name, events, retention_days, pixel_id: obj.pixel_id }, note: "Nothing created. Re-run with confirm=true." };
      const created = await client.createEntity("segment", obj);
      return { applied: true, segment_id: created.id, name: created.name };
    }),
  );

  server.registerTool(
    "snap_upload_customer_list",
    {
      description:
        "Create a customer-list audience from a local CSV of emails or phone numbers. Values are normalised and SHA-256 hashed on this machine; only hashes are uploaded and no raw value is ever shown or logged. Previews (counts only) unless confirm=true. Phone numbers without a country code get default_country_code (966).",
      inputSchema: {
        file_path: z.string().describe("Absolute path to a .csv with a header row"),
        kind: z.enum(["email", "phone"]),
        name: z.string().min(3).describe("Audience name"),
        column: z.string().optional().describe("Header of the column to use; found automatically when omitted"),
        default_country_code: z.string().default("966"),
        confirm: confirmField,
      },
    },
    wrap(async ({ file_path, kind, name, column, default_country_code, confirm }) => {
      const read = readIdentifiers(file_path, { kind, column, defaultCountryCode: default_country_code });
      const summary = { column_used: read.column, rows: read.rows, valid_unique: read.valid, invalid_skipped: read.invalid, duplicates_removed: read.duplicates };
      if (!read.valid) throw new Error(`No valid ${kind} values found. ${JSON.stringify(summary)}`);
      if (!confirm) return { applied: false, dry_run: true, would_upload: summary, audience_name: name, note: "Only SHA-256 hashes would be sent. Nothing was created. Re-run with confirm=true." };
      const segment = await client.createEntity("segment", buildCustomerSegment({ adAccountId: account(), name }));
      const sent = await uploadCustomerList({ client, segmentId: segment.id, hashes: read.hashes, kind });
      return { applied: true, segment_id: segment.id, uploaded: sent, ...summary, note: "Snap needs a while to match the list before it shows a size." };
    }),
  );

  const asyncEntity = z.enum(["adaccount", "campaign", "adsquad", "ad"]);
  server.registerTool(
    "snap_report_async_start",
    {
      description: "Start a large CSV report (no size limit, unlike the synchronous reports). Returns a report_run_id; check it with snap_report_async_status, then snap_report_async_download. Read-only.",
      inputSchema: { entity: asyncEntity, id: z.string(), start_time: z.string(), end_time: z.string(), granularity: z.enum(["TOTAL", "DAY", "HOUR"]).default("DAY"), breakdown: z.enum(["campaign", "adsquad", "ad"]).optional() },
    },
    wrap((a) => startAsyncReport(client, a)),
  );
  server.registerTool(
    "snap_report_async_status",
    { description: "Status of an async report (STARTED, RUNNING, COMPLETED) (read-only).", inputSchema: { entity: asyncEntity, id: z.string(), report_run_id: z.string() } },
    wrap((a) => asyncReportStatus(client, a)),
  );
  server.registerTool(
    "snap_report_async_download",
    { description: "Download a COMPLETED async report as a CSV into this project's exports/ folder and return its path and row count.", inputSchema: { entity: asyncEntity, id: z.string(), report_run_id: z.string(), file_name: z.string().optional() } },
    wrap(({ entity, id, report_run_id, file_name }) => downloadAsyncReport(client, { entity, id, report_run_id, fileName: file_name })),
  );

  server.registerTool(
    "snap_delete",
    {
      description:
        "Permanently delete a campaign, ad squad, ad or audience. Heavily guarded: the item must be PAUSED (audiences excepted), must have spent nothing in the last 30 days, a campaign must have no ACTIVE ad squads, and you must pass confirm_name equal to its exact name. Cannot be undone. Previews (and shows any blockers) unless confirm=true.",
      inputSchema: { entity: z.enum(["campaign", "adsquad", "ad", "segment"]), id: z.string(), confirm_name: z.string().optional().describe("Exact name of the item, copied from the preview"), confirm: confirmField },
    },
    wrap(async ({ entity, id, confirm_name, confirm }) => {
      const plan = await planDelete(client, { entity, id, confirmName: confirm_name });
      if (!confirm) return { applied: false, dry_run: true, preview: plan.summary, note: plan.blockers.length ? "This cannot be deleted yet (see blocked_because)." : "Nothing was deleted. To delete, re-run with confirm=true and confirm_name set to the exact name." };
      return executeDelete({ client, entity, id, plan });
    }),
  );

  server.registerTool(
    "snap_creative_fatigue",
    {
      description:
        "Which ads are tired? Compares each ad of a campaign or ad squad this window vs the one before: FATIGUED (ROAS down 30%+ with higher frequency or lower swipe rate), WATCH, HEALTHY, STOPPED, NEW (read-only). end_time must be hour-aligned with an offset; days defaults to 7.",
      inputSchema: { entity: z.enum(["campaign", "adsquad"]), id: z.string(), end_time: z.string().describe("e.g. 2026-10-27T00:00:00+03:00"), days: z.number().int().min(1).max(15).default(7), min_spend: z.number().default(50) },
    },
    wrap(({ entity, id, end_time, days, min_spend }) => fatigueReport(client, { entity, id, end_time, days, minSpend: min_spend })),
  );

  server.registerTool(
    "snap_change_log",
    { description: "Show the most recent changes this server applied.", inputSchema: { limit: z.number().int().min(1).max(200).default(20) } },
    wrap(({ limit }) => readLog(limit)),
  );
}
