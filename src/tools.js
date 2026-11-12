import { statSync } from "node:fs";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { SnapClient } from "./snap.js";
import { executeChange, LOG_FILE, planBid, planBudget, planExcludeSegments, planRename, planSchedule, planStatus, planTargeting, planUndo, prepareChange, previewOf, readLog, undoableEntries } from "./changes.js";
import { executeBulkEdit, plans, prepareBulkEdit } from "./bulk-edit.js";
import { runBatch, checkBatch } from "./influencer-batch.js";
import { createWithAutoStrip, planCloneCreative } from "./creative-tools.js";
import { buildCustomerSegment, readIdentifiers, uploadCustomerList } from "./customer-list.js";
import { asyncReportStatus, downloadAsyncReport, startAsyncReport } from "./async-report.js";
import { executeDelete, planDelete } from "./delete.js";
import { breakdownReport, dailyReport, dimensionReport, DIMENSIONS, SWIPE_WINDOWS, VIEW_WINDOWS } from "./report.js";
import { compareReport, healthCheck, pixelHealth, reviewIssues } from "./audit.js";
import { fatigueReport } from "./fatigue.js";
import { buildLookalike, buildPixelAudience, PIXEL_EVENTS, listCatalogs, listPixels, listProductSets, listSegments, rawGet, targetingOptions, TARGETING_KINDS } from "./readers.js";
import { buildAdSquad, buildCampaign, createAdSquad, createCampaign, inspectMediaFile, uploadMedia } from "./create.js";
import { executeCopy, executeCopySquad, loadSource, planCopy, planCopySquad } from "./copy.js";
import { executeCloneAd, loadTargets, planCloneAd } from "./clone-ad.js";
import { executeBulkStatus, loadBulkItems, planBulkStatus } from "./bulk.js";
import { buildAd, buildCreative, claimAdCode, getMedia, runInfluencerFlow, validateAdCode } from "./influencer.js";
import { describePolicy, loadPolicy } from "./policy.js";
import { ApprovalStore, digest, fingerprintOf } from "./approval.js";
import { addedDailyBudgetInWindow, auditIntent, auditResult, redact, windowStartMicro } from "./audit-log.js";
import { Ownership } from "./ownership.js";
import { activationImpact, scheduleOpensDelivery } from "./activation.js";

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
// A list result keeps its plain array shape; anything the reader must know (cut off, more than shown) goes in a second block.
class ListResult {
  constructor(items, notes = []) {
    this.items = items;
    this.notes = notes;
  }
}
const asResult = (out) => {
  if (!(out instanceof ListResult)) return text(out);
  const r = text(out.items);
  if (out.notes.length) r.content.push({ type: "text", text: `NOTE: ${out.notes.join(" ")}` });
  return r;
};
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] });

const brief = (o) => ({
  id: o.id,
  name: o.name,
  status: o.status,
  daily_budget: o.daily_budget_micro != null ? o.daily_budget_micro / 1e6 : undefined,
  lifetime_budget: o.lifetime_budget_micro != null ? o.lifetime_budget_micro / 1e6 : undefined,
  campaign_id: o.campaign_id,
  ad_squad_id: o.ad_squad_id,
  optimization_goal: o.optimization_goal,
  bid_strategy: o.bid_strategy,
  updated_at: o.updated_at,
});

// Ids are placed in URL paths, so only id-safe characters are accepted (no '/', '.', '?', '#', '%').
const id = () => z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be an id (letters, digits, '-' or '_')");
const TWO_STEP = " Two steps: confirm=false returns a preview and an approval_token; to apply, repeat the same arguments with confirm=true and that approval_token.";

export function registerTools(server, client, env = process.env) {
  // Safety settings are parsed once, here. Invalid settings throw, so the server does not start with a limit switched off.
  const policy = loadPolicy(env);
  // The account, profile and pixel are fixed for the life of the process: editing .env cannot retarget a running server.
  const cfg = Object.freeze({ account: env.SNAP_AD_ACCOUNT_ID || undefined, profile: env.SNAP_BRAND_PROFILE_ID || undefined, pixel: env.SNAP_PIXEL_ID || undefined });
  const logFile = env.SNAP_LOG_FILE || LOG_FILE;
  const approvals = new ApprovalStore({ ttlMs: policy.approvalTtlSeconds * 1000, repeatWindowMs: policy.repeatWindowSeconds * 1000 });
  const ownership = new Ownership(client);
  const history = (entityId, field) => windowStartMicro(logFile, entityId, field);

  const defaultCountries = () => {
    if (!policy.defaultCountry) throw new Error("countries is required (2-letter codes such as [\"us\"]). Set SNAP_DEFAULT_COUNTRY in .env to use a default.");
    return [policy.defaultCountry];
  };
  const account = (given) => {
    const a = given ?? cfg.account;
    if (!a) throw new Error("ad_account_id missing and SNAP_AD_ACCOUNT_ID not set");
    return a;
  };
  const brandProfile = (given) => {
    const p = given ?? cfg.profile;
    if (!p) throw new Error("profile_id missing and SNAP_BRAND_PROFILE_ID not set");
    return p;
  };
  const entityEnum = z.enum(["campaign", "adsquad", "ad"]);

  // Limits are expressed in account currency. When SNAP_ACCOUNT_CURRENCY is set, writes are refused unless the account matches.
  let currencyCheck = null;
  const ensureCurrency = () => {
    if (!policy.currency) return null;
    currencyCheck ??= client.request("GET", `/adaccounts/${account()}`).then((d) => {
      const actual = d.adaccounts?.[0]?.adaccount?.currency;
      if (actual !== policy.currency) throw new Error(`The ad account currency is ${actual ?? "unknown"} but SNAP_ACCOUNT_CURRENCY is ${policy.currency}. The limits would mean something else, so writes are refused.`);
      return actual;
    });
    return currencyCheck.catch((e) => {
      currencyCheck = null;
      throw e;
    });
  };

  // Optional human signal: the server asks the person directly through the MCP client (elicitation). The question and the
  // answer travel between server and client UI; they are not part of any tool result, so the model neither sees the
  // confirmation code nor can answer for the user. Fails closed whenever the client cannot ask.
  // (A client can still be configured to answer elicitations automatically, e.g. with a hook. That is outside this server.)
  async function humanApproval(tool, p, targetIds, added) {
    if (policy.humanApproval !== "elicit") return;
    const sensitive = added > 0 || tool === "snap_delete" || tool === "snap_undo";
    const code = sensitive ? String(randomInt(1000, 10000)) : null;
    const facts = [
      `${tool} on ad account ${cfg.account ?? "?"}`,
      targetIds.length ? `Targets (${targetIds.length}): ${targetIds.slice(0, 5).join(", ")}${targetIds.length > 5 ? ", ..." : ""}` : null,
      added > 0 ? `THIS ADDS ${added} PER DAY of budget (account currency).` : null,
      typeof p.preview?.change === "string" ? `Change: ${p.preview.change}` : null,
      code ? `To approve, tick the box AND type this code: ${code}` : "To approve, tick the box.",
    ].filter(Boolean);
    const properties = { approve: { type: "boolean", title: "Approve this change", description: "Tick to let this exact change run." } };
    if (code) properties.confirmation_code = { type: "string", title: "Confirmation code", description: "The 4-digit code shown in the message." };
    let res;
    try {
      res = await server.server.elicitInput(
        { message: `${facts.join("\n")}\n\nDetails:\n${JSON.stringify(redact(p.preview), null, 1).slice(0, 1400)}`, requestedSchema: { type: "object", properties, required: ["approve"] } },
        { timeout: 600_000 },
      );
    } catch (e) {
      throw new Error(`A human approval is required (SNAP_HUMAN_APPROVAL=elicit) but this MCP client could not ask for one (${e.message}). Nothing was sent.`);
    }
    if (res?.action !== "accept" || res.content?.approve !== true) throw new Error("The user did not approve this change. Nothing was sent.");
    if (code && String(res.content?.confirmation_code ?? "").trim() !== code) throw new Error("The confirmation code did not match. Nothing was sent.");
  }

  // Everything this server may add to the account's daily spend in 24 hours, across all tools and calls.
  const round2 = (n) => Math.round(n * 100) / 100;
  const spendLedger = (added) => {
    if (!(added > 0)) return null;
    const used = addedDailyBudgetInWindow(logFile);
    if (used + added > policy.maxAddedDailyBudget24h + 1e-9) {
      throw new Error(`Refusing: this would add ${added} per day of budget, and ${used} per day was already added through this server in the last 24 hours (limit ${policy.maxAddedDailyBudget24h}, SNAP_MAX_ADDED_DAILY_BUDGET_24H). Nothing was sent. Only the account owner can raise that limit, in .env, followed by a restart.`);
    }
    return { adds_daily_budget: added, already_added_last_24h: used, limit_per_24h: policy.maxAddedDailyBudget24h };
  };

  const READ = { readOnlyHint: true, openWorldHint: true };
  const read = (name, { description, shape = {}, annotations = READ }, fn) =>
    server.registerTool(name, { description, inputSchema: z.object(shape).strict(), annotations }, async (args) => {
      try {
        return asResult(await fn(args));
      } catch (e) {
        return fail(e);
      }
    });

  const confirmField = z.boolean().default(false).describe("false = preview only (nothing sent). true = apply; needs approval_token from the preview.");
  const tokenField = z.string().max(200).optional().describe("The approval_token returned by the preview of this exact request. Required with confirm=true.");

  // Every mutating tool goes through this one path:
  //   prepare (read + validate + plan, nothing sent) -> ownership -> preview with approval token
  //   confirm: token must match the same request AND the same target state -> optional human approval
  //            -> audit intent written -> execute -> audit result written.
  // `prepare(params)` returns { preview, execute, targets?, state?, blocked?, targetIds? }.
  const write = (name, { description, shape, destructive = false, repeatGuard = false, bind = (p) => p }, prepare) =>
    server.registerTool(
      name,
      {
        description: description + TWO_STEP,
        inputSchema: z.object({ ...shape, confirm: confirmField, approval_token: tokenField }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          const { confirm, approval_token, ...params } = args;
          if (confirm) {
            if (policy.readOnly) throw new Error("This server is in read-only mode (SNAP_READ_ONLY). Nothing was sent.");
            approvals.precheck(name, approval_token);
          }
          await ensureCurrency();
          const p = await prepare(params);
          for (const t of p.targets ?? []) await ownership.assert(t.entity, t.obj, account());
          const targetIds = p.targetIds ?? (p.targets ?? []).map((t) => t.obj.id);
          const added = round2(p.addedDailyBudget ?? 0);
          const ledger = p.blocked ? null : spendLedger(added);
          const requestDigest = digest({ tool: name, account: cfg.account ?? null, params: bind(params) });
          const binding = digest({ requestDigest, state: p.state ?? null });
          const detail = { request: requestDigest, state: fingerprintOf(p.state ?? null) };
          if (!confirm) {
            if (p.blocked) return text(p.preview);
            const repeat = repeatGuard ? approvals.recentRepeat(requestDigest) : null;
            const issued = approvals.issue(name, binding, detail);
            return text({
              ...p.preview,
              ...(repeat ? { duplicate_warning: `An identical request was executed ${repeat.seconds_ago}s ago and will be refused if confirmed: ${JSON.stringify(repeat.summary)}` } : {}),
              ...(ledger ? { spend_impact: ledger } : {}),
              ...(policy.readOnly ? { read_only: "SNAP_READ_ONLY is on: this preview cannot be applied." } : {}),
              ad_account: cfg.account ?? null,
              approval_token: issued.token,
              approval_expires_in_seconds: issued.expires_in_seconds,
            });
          }
          if (p.blocked) throw new Error(p.blocked);
          approvals.consume(name, approval_token, binding, detail);
          if (repeatGuard) {
            const repeat = approvals.recentRepeat(requestDigest);
            if (repeat) throw new Error(`An identical ${name} request was already executed ${repeat.seconds_ago}s ago (${JSON.stringify(repeat.summary)}). Not repeating it. If a second one is really wanted, give it a different name or wait ${policy.repeatWindowSeconds}s.`);
          }
          await humanApproval(name, p, targetIds, added);
          const event = { tool: name, account: cfg.account ?? null, targets: targetIds };
          // Checked again and recorded in one synchronous step, so two calls running at once cannot both slip under the limit.
          spendLedger(added);
          const event_id = auditIntent(logFile, { ...event, params, preview: p.preview, addedDailyBudget: added });
          let result;
          try {
            result = await p.execute();
          } catch (e) {
            auditResult(logFile, { ...event, event_id, ok: false, error: e.message });
            throw e;
          }
          const logged = auditResult(logFile, { ...event, event_id, ok: true, result });
          if (repeatGuard) approvals.recordExecuted(requestDigest, { audit_event_id: event_id, at: new Date().toISOString() });
          return text({ ...result, audit_event_id: event_id, ...(logged.logged ? {} : { audit_log_warning: `The operation ran but its result could not be written to the audit log (${logged.error}). Tell the user.` }) });
        } catch (e) {
          return fail(e);
        }
      },
    );

  // One planned edit of one existing item.
  // Whatever the tool is called, a change that can start or raise spending is measured here: enabling, a schedule edit that
  // lets an ACTIVE item deliver sooner, and a budget increase.
  const spendOf = async (entity, current, patch) => {
    const enabling = patch.status === "ACTIVE" && current.status !== "ACTIVE";
    const opening = !enabling && ("start_time" in patch || "end_time" in patch) && scheduleOpensDelivery(current, patch);
    const impact = enabling || opening ? await activationImpact(client, entity, [{ ...current, ...patch }], policy) : undefined;
    const raise = typeof patch.daily_budget_micro === "number" && patch.daily_budget_micro > (current.daily_budget_micro ?? 0) ? (patch.daily_budget_micro - (current.daily_budget_micro ?? 0)) / 1e6 : 0;
    return { impact, opening, added: (impact?.daily_budget_that_starts_delivering ?? 0) + raise };
  };

  const change = async (entity, entityId, plan, { logExtra, extraPreview } = {}) => {
    const prepared = await prepareChange({ client, entity, id: entityId, plan });
    const { impact, opening, added } = await spendOf(entity, prepared.current, prepared.patch);
    return {
      targets: [{ entity, obj: prepared.current }],
      state: { current: prepared.current, impact: impact ?? null },
      addedDailyBudget: added,
      preview: { ...previewOf(prepared), ...(impact ? { activation: { ...(opening ? { reason: "This schedule change lets an ACTIVE item deliver sooner, so it is checked like enabling it." } : {}), ...impact } } : {}), ...(extraPreview ?? {}) },
      execute: async () => ({ ...(await executeChange({ client, prepared, logFile, logExtra })), ...(extraPreview ?? {}) }),
    };
  };

  const fileState = (path) => {
    const st = statSync(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  };

  // ---------------------------------------------------------------- read tools

  // Optional: pin the attribution windows of a report. Left out, Snap uses the account's defaults (stated in the output).
  const attributionShape = {
    swipe_up_attribution_window: z.enum(SWIPE_WINDOWS).optional().describe("Pin the swipe attribution window; default is the account's setting"),
    view_attribution_window: z.enum(VIEW_WINDOWS).optional().describe("Pin the view attribution window; default is the account's setting"),
  };

  read("snap_ping", { description: "Check the Snap credentials work, show who is authorized, and show the safety limits this server is running with." }, async () => {
    const me = await client.request("GET", "/me");
    return { ok: true, me: me.me ?? me, ad_account: cfg.account ?? null, safety_limits: describePolicy(policy) };
  });

  // Lists read every page, apply the status filter to ALL rows, and only then cut to `limit`. If anything was left out, say so.
  const nameFilter = z.string().min(1).max(100).optional().describe("Only items whose name contains this text (case-insensitive). Use it to find one item in a big account.");
  const listRows = async (path, entity, { status, limit, nameContains }) => {
    const { items, complete, reason } = await client.listPaged(path, entity);
    const needle = nameContains?.toLowerCase();
    const rows = items.map(brief).filter((r) => (!status || r.status === status) && (!needle || String(r.name ?? "").toLowerCase().includes(needle)));
    const notes = [];
    if (!complete) notes.push(`The list is INCOMPLETE (${reason}); more items exist that are not included.`);
    if (rows.length > limit) notes.push(`${rows.length} items match; showing the first ${limit}. Raise limit (max 500) or narrow the filters.`);
    return new ListResult(rows.slice(0, limit), notes);
  };

  read(
    "snap_list_campaigns",
    {
      description: "List campaigns in an ad account (read-only). Uses SNAP_AD_ACCOUNT_ID if no account is given. Reads every page and applies the status and name_contains filters before the limit (use name_contains to find one campaign in a big account); a note says when the list is cut.",
      shape: { ad_account_id: id().optional(), status: z.enum(["ACTIVE", "PAUSED"]).optional(), name_contains: nameFilter, limit: z.number().int().min(1).max(500).default(100) },
    },
    ({ ad_account_id, status, name_contains, limit }) => listRows(`/adaccounts/${account(ad_account_id)}/campaigns`, "campaign", { status, limit, nameContains: name_contains }),
  );

  read(
    "snap_list_adsquads",
    {
      description: "List ad squads for a campaign, or for the whole ad account when only the account is given (read-only). Reads every page and applies the status filter before the limit; a note says when the list is cut.",
      shape: { campaign_id: id().optional(), ad_account_id: id().optional(), status: z.enum(["ACTIVE", "PAUSED"]).optional(), name_contains: nameFilter, limit: z.number().int().min(1).max(500).default(100) },
    },
    ({ campaign_id, ad_account_id, status, name_contains, limit }) => listRows(campaign_id ? `/campaigns/${campaign_id}/adsquads` : `/adaccounts/${account(ad_account_id)}/adsquads`, "adsquad", { status, limit, nameContains: name_contains }),
  );

  read("snap_list_ads", { description: "List ads in an ad squad (read-only). Reads every page; a note says when the list is cut.", shape: { adsquad_id: id() } }, ({ adsquad_id }) => listRows(`/adsquads/${adsquad_id}/ads`, "ad", { limit: 500 }));

  read("snap_get_entity", { description: "Get one campaign, ad squad or ad in full, including targeting (read-only).", shape: { entity: entityEnum, id: id() } }, ({ entity, id: entityId }) => client.getEntity(entity, entityId));

  read(
    "snap_get_stats",
    {
      description: "Stats for one campaign, ad squad or ad over a window (read-only). Times must fall on the hour; spend is in micro-currency.",
      shape: {
        entity: entityEnum,
        id: id(),
        start_time: z.string().describe("ISO date-time on the hour, with offset, e.g. 2026-10-19T00:00:00+00:00"),
        end_time: z.string(),
        granularity: z.enum(["TOTAL", "DAY", "HOUR"]).default("TOTAL"),
        fields: z.array(z.string()).default(["impressions", "spend", "swipes", "conversion_purchases", "conversion_purchases_value", "frequency"]),
      },
    },
    async ({ entity, id: entityId, start_time, end_time, granularity, fields }) => {
      const base = { campaign: "campaigns", adsquad: "adsquads", ad: "ads" }[entity];
      return client.request("GET", `/${base}/${entityId}/stats`, { query: { granularity, start_time, end_time, fields: fields.join(",") } });
    },
  );

  read(
    "snap_list_creatives",
    {
      description: "List creatives in an ad account (read-only), so you can see what can be reused. Reads every page; a note says when the list is cut.",
      shape: { ad_account_id: id().optional(), name_contains: nameFilter, limit: z.number().int().min(1).max(500).default(50) },
    },
    async ({ ad_account_id, name_contains, limit }) => {
      const { items, complete, reason } = await client.listPaged(`/adaccounts/${account(ad_account_id)}/creatives`, "creative");
      const needle = name_contains?.toLowerCase();
      const rows = items.filter((c) => !needle || String(c.name ?? "").toLowerCase().includes(needle)).map((c) => ({ id: c.id, name: c.name, type: c.type, render_type: c.render_type, status: c.status, updated_at: c.updated_at }));
      const notes = [];
      if (!complete) notes.push(`The list is INCOMPLETE (${reason}); more creatives exist that are not included.`);
      if (rows.length > limit) notes.push(`${rows.length} creatives found; showing the first ${limit}. Raise limit (max 500).`);
      return new ListResult(rows.slice(0, limit), notes);
    },
  );

  read("snap_get_media", { description: "Get a media asset and its processing status (read-only). Use after claiming an ad code.", shape: { media_id: id() } }, async ({ media_id }) => {
    const m = await getMedia(client, media_id);
    return { id: m.id, type: m.type, media_status: m.media_status, duration_in_seconds: m.duration_in_seconds, content_source_type: m.content_source_type, video_metadata: m.video_metadata };
  });

  read(
    "snap_report",
    {
      description: "Performance table for a campaign or ad squad broken down by ad squad or ad: spend, purchases, ROAS, CPA, swipe rate and frequency (read-only). Times must fall on the hour, with offset.",
      shape: { entity: z.enum(["campaign", "adsquad"]), id: id(), breakdown: z.enum(["adsquad", "ad"]), start_time: z.string().describe("e.g. 2026-10-19T00:00:00+00:00"), end_time: z.string(), ...attributionShape },
    },
    (args) => breakdownReport(client, args),
  );

  read(
    "snap_api_get",
    {
      description: "Read-only GET against the Snap Marketing API for anything without a dedicated tool (allow-listed paths only, e.g. /adaccounts/{id}/..., /pixels/{id}/..., /organizations/{id}/...). Query values go in `query`. Never writes.",
      shape: { path: z.string().describe("Starts with /, no query string"), query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}), max_chars: z.number().int().min(1000).max(100000).default(20000) },
    },
    ({ path, query, max_chars }) => rawGet(client, { path, query, maxChars: max_chars }),
  );

  read(
    "snap_list_segments",
    {
      description: "List audience segments (customer lists, pixel, engagement, lookalike) with size and status, largest first (read-only).",
      shape: { source_type: z.enum(["FIRST_PARTY", "PIXEL", "ENGAGEMENT", "LOOKALIKE"]).optional(), min_size: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(300).default(60), ad_account_id: id().optional() },
    },
    async ({ source_type, min_size, limit, ad_account_id }) => (await listSegments(client, account(ad_account_id), { sourceType: source_type, minSize: min_size })).slice(0, limit),
  );

  read("snap_list_pixels", { description: "List the Snap pixels of the ad account (read-only).", shape: { ad_account_id: id().optional() } }, ({ ad_account_id }) => listPixels(client, account(ad_account_id)));

  read(
    "snap_list_catalogs",
    { description: "List product catalogs of the organization (read-only). Organization id defaults to the ad account's organization.", shape: { organization_id: id().optional() } },
    async ({ organization_id }) => {
      const org = organization_id ?? (await client.request("GET", `/adaccounts/${account()}`)).adaccounts[0].adaccount.organization_id;
      return listCatalogs(client, org);
    },
  );

  read("snap_list_product_sets", { description: "List product sets of a catalog (read-only).", shape: { catalog_id: id() } }, ({ catalog_id }) => listProductSets(client, catalog_id));

  read(
    "snap_targeting_options",
    {
      description: "Look up targeting ids (read-only): interests (lifestyle, shopper, visitation), regions, languages, age groups. Use the returned ids with snap_set_targeting.",
      shape: { kind: z.enum(Object.keys(TARGETING_KINDS)), country: z.string().optional().describe("2-letter code; defaults to SNAP_DEFAULT_COUNTRY"), search: z.string().optional() },
    },
    ({ kind, country, search }) => targetingOptions(client, { kind, country: country ?? policy.defaultCountry, search }),
  );

  read(
    "snap_report_daily",
    {
      description: "Day-by-day performance (spend, purchases, ROAS, CPA, swipe rate) for a campaign, ad squad or ad, up to 31 days (read-only). Day boundaries must be local midnight with offset.",
      shape: { entity: z.enum(["campaign", "adsquad", "ad"]), id: id(), start_time: z.string().describe("e.g. 2026-10-01T00:00:00+00:00"), end_time: z.string(), ...attributionShape },
    },
    (args) => dailyReport(client, args),
  );

  read(
    "snap_report_audience",
    {
      description: "Performance split by country, gender, age, region, dma or make (read-only), for a campaign, ad squad or ad.",
      shape: { entity: z.enum(["campaign", "adsquad", "ad"]), id: id(), dimension: z.enum(DIMENSIONS), start_time: z.string(), end_time: z.string() },
    },
    (args) => dimensionReport(client, args),
  );

  read(
    "snap_health_check",
    {
      description: "Audit every ACTIVE campaign's ACTIVE ad squads (read-only): no buyer exclusion, high frequency, low swipe rate, low ROAS, spend with no purchases, squads under a paused campaign. Returns the ad squad ids to act on.",
      shape: {
        start_time: z.string().describe("Window start, e.g. 2026-10-19T00:00:00+00:00"),
        end_time: z.string(),
        max_frequency: z.number().default(5),
        min_swipe_rate_pct: z.number().default(0.15),
        min_spend: z.number().default(100),
        min_roas: z.number().default(3),
      },
    },
    ({ start_time, end_time, max_frequency, min_swipe_rate_pct, min_spend, min_roas }) =>
      healthCheck(client, { adAccountId: account(), start_time, end_time, thresholds: { maxFrequency: max_frequency, minSwipeRatePct: min_swipe_rate_pct, minSpend: min_spend, minRoas: min_roas } }),
  );

  read(
    "snap_review_issues",
    { description: "Ads that are rejected or pending review, with Snap's reasons (read-only). By default only ads whose ad squad is ACTIVE.", shape: { only_active: z.boolean().default(true) } },
    ({ only_active }) => reviewIssues(client, { adAccountId: account(), onlyActive: only_active }),
  );

  read(
    "snap_pixel_health",
    { description: "Pixel signal readiness and event-quality recommendations, highest priority first (read-only). Pixel defaults to SNAP_PIXEL_ID.", shape: { pixel_id: id().optional() } },
    ({ pixel_id }) => {
      const pixel = pixel_id ?? cfg.pixel;
      if (!pixel) throw new Error("pixel_id missing and SNAP_PIXEL_ID not set");
      return pixelHealth(client, pixel);
    },
  );

  read(
    "snap_report_compare",
    {
      description: "Compare two time windows for a campaign, ad squad or ad, optionally per child (ad squads or ads): spend, purchases, ROAS, CPA, frequency, swipe rate and the changes (read-only).",
      shape: { entity: z.enum(["campaign", "adsquad", "ad"]), id: id(), breakdown: z.enum(["adsquad", "ad"]).optional(), current_start: z.string(), current_end: z.string(), previous_start: z.string(), previous_end: z.string() },
    },
    ({ entity, id: entityId, breakdown, current_start, current_end, previous_start, previous_end }) =>
      compareReport(client, { entity, id: entityId, breakdown, current: { start_time: current_start, end_time: current_end }, previous: { start_time: previous_start, end_time: previous_end } }),
  );

  const asyncEntity = z.enum(["adaccount", "campaign", "adsquad", "ad"]);
  read(
    "snap_report_async_start",
    {
      description: "Start a large CSV report (no size limit, unlike the synchronous reports). Returns a report_run_id; check it with snap_report_async_status, then snap_report_async_download. Read-only.",
      shape: { entity: asyncEntity, id: id(), start_time: z.string(), end_time: z.string(), granularity: z.enum(["TOTAL", "DAY", "HOUR"]).default("DAY"), breakdown: z.enum(["campaign", "adsquad", "ad"]).optional() },
    },
    (a) => startAsyncReport(client, a),
  );
  read("snap_report_async_status", { description: "Status of an async report (STARTED, RUNNING, COMPLETED) (read-only).", shape: { entity: asyncEntity, id: id(), report_run_id: z.string() } }, (a) => asyncReportStatus(client, a));
  read(
    "snap_report_async_download",
    {
      description: "Download a COMPLETED async report as a CSV into this project's exports/ folder and return its path and row count. Reads from Snap only; writes one local file.",
      shape: { entity: asyncEntity, id: id(), report_run_id: z.string(), file_name: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ entity, id: entityId, report_run_id, file_name }) => downloadAsyncReport(client, { entity, id: entityId, report_run_id, fileName: file_name }),
  );

  read(
    "snap_creative_fatigue",
    {
      description: "Which ads are tired? Compares each ad of a campaign or ad squad this window vs the one before: FATIGUED (ROAS down 30%+ with higher frequency or lower swipe rate), WATCH, HEALTHY, STOPPED, NEW (read-only). end_time must be hour-aligned with an offset; days defaults to 7.",
      shape: { entity: z.enum(["campaign", "adsquad"]), id: id(), end_time: z.string().describe("e.g. 2026-10-27T00:00:00+00:00"), days: z.number().int().min(1).max(15).default(7), min_spend: z.number().default(50) },
    },
    ({ entity, id: entityId, end_time, days, min_spend }) => fatigueReport(client, { entity, id: entityId, end_time, days, minSpend: min_spend }),
  );

  read("snap_change_log", { description: "Show the most recent changes and audit events this server recorded.", shape: { limit: z.number().int().min(1).max(200).default(20) }, annotations: { readOnlyHint: true, openWorldHint: false } }, ({ limit }) => readLog(limit, logFile));

  // ---------------------------------------------------------------- write tools

  write(
    "snap_set_status",
    {
      description: "Pause (PAUSED) or enable (ACTIVE) a campaign, ad squad or ad. Enabling shows the daily budget that would really start delivering (including the ACTIVE ad squads under a campaign) and is refused above the configured limits. Previews unless confirm=true. Never deletes.",
      shape: { entity: entityEnum, id: id(), status: z.enum(["ACTIVE", "PAUSED"]) },
      destructive: true,
    },
    ({ entity, id: entityId, status }) => change(entity, entityId, (cur) => planStatus(cur, status)),
  );

  write(
    "snap_set_status_bulk",
    {
      description:
        "Enable (ACTIVE) or pause (PAUSED) up to 20 campaigns, ad squads or ads in one go. Previews unless confirm=true: shows each change, skips ones already in that state, warns when a parent is paused, and for ACTIVE shows the daily budget that would really start delivering (refused above the configured limits). Stops at the first failure and reports exactly what changed. Never deletes.",
      shape: { entity: entityEnum, ids: z.array(id()).min(1).max(20), status: z.enum(["ACTIVE", "PAUSED"]) },
      destructive: true,
    },
    async ({ entity, ids, status }) => {
      const items = await loadBulkItems(client, entity, ids);
      const plan = planBulkStatus({ entity, items, status });
      const changing = items.filter(({ obj }) => obj.status !== status).map(({ obj }) => obj);
      const impact = status === "ACTIVE" && changing.length ? await activationImpact(client, entity, changing, policy) : undefined;
      // The planner only sees the items themselves; the real figure comes from what their children would start.
      const summary = { ...plan.summary, ...(impact ? { daily_budget_that_would_start_delivering: impact.daily_budget_that_starts_delivering, activation: impact } : {}) };
      return {
        targets: items.map(({ obj }) => ({ entity, obj })),
        state: { items: items.map(({ obj, parent }) => ({ obj, parent_status: parent?.status ?? null })), impact: impact ?? null },
        addedDailyBudget: impact?.daily_budget_that_starts_delivering ?? 0,
        blocked: plan.toChange.length ? undefined : "Nothing to change: every item is already in that state.",
        preview: { applied: false, dry_run: true, preview: summary, note: "Nothing was changed. Re-run with confirm=true to apply." },
        execute: async () => ({ applied: true, changed: await executeBulkStatus({ client, entity, plan, status, logFile }), skipped: plan.skipped, warnings: plan.warnings }),
      };
    },
  );

  write(
    "snap_set_daily_budget",
    {
      description:
        "Set the daily budget (in account currency, e.g. USD) on a campaign or ad squad. Refused above the absolute limit (SNAP_MAX_DAILY_BUDGET), above the allowed increase per step and per 24 hours (default +100%), and below the minimum. Previews unless confirm=true.",
      shape: { entity: z.enum(["campaign", "adsquad"]), id: id(), daily_budget: z.number().positive() },
      destructive: true,
    },
    ({ entity, id: entityId, daily_budget }) => change(entity, entityId, (cur) => planBudget(cur, daily_budget, policy, { history })),
  );

  write(
    "snap_exclude_segments",
    {
      description: "Add audience segments (e.g. past buyers) as EXCLUDE targeting on an ad squad, keeping existing targeting. Previews unless confirm=true.",
      shape: { adsquad_id: id(), segment_ids: z.array(id()).min(1) },
      destructive: true,
    },
    ({ adsquad_id, segment_ids }) => change("adsquad", adsquad_id, (cur) => planExcludeSegments(cur, segment_ids)),
  );

  write(
    "snap_copy_campaign",
    {
      description:
        "Copy a campaign with its ad squads (and optionally ads) into a NEW campaign. Everything is created PAUSED and re-timed to start shortly after enabling. Daily and lifetime budgets are scaled by budget_scale and must stay within the configured limits. Previews unless confirm=true. Review in Ads Manager, then enable with snap_set_status.",
      shape: {
        campaign_id: id(),
        new_name: z.string().min(3),
        include_ads: z.boolean().default(true),
        budget_scale: z.number().positive().max(2).default(1).describe("Multiply every daily and lifetime budget, e.g. 0.5 for half"),
        squad_ids: z.array(id()).optional().describe("Copy only these ad squads of the source campaign"),
        resume_campaign_id: id().optional().describe("Reuse an empty campaign left by a failed copy instead of creating a new one"),
      },
      repeatGuard: true,
    },
    async ({ campaign_id, new_name, include_ads, budget_scale, squad_ids, resume_campaign_id }) => {
      const src = await loadSource(client, campaign_id, { includeAds: include_ads, squadIds: squad_ids });
      if (src.campaign.name === new_name.trim()) throw new Error("new_name must differ from the source campaign name");
      const plan = planCopy({ ...src, newName: new_name, includeAds: include_ads, budgetScale: budget_scale, env: policy });
      const targets = [{ entity: "campaign", obj: src.campaign }];
      let resume = null;
      if (resume_campaign_id) {
        resume = await client.getEntity("campaign", resume_campaign_id);
        if (resume.status !== "PAUSED") throw new Error("resume_campaign_id must be a PAUSED campaign left by a failed copy");
        targets.push({ entity: "campaign", obj: resume });
      }
      return {
        targets,
        state: { campaign: src.campaign, squads: src.squads, ads: src.adsBySquad, resume },
        preview: { applied: false, dry_run: true, source: src.campaign.name, would_create: plan.summary, note: "Nothing was created. Re-run with confirm=true to create it (all PAUSED)." },
        execute: async () => ({ applied: true, created: await executeCopy({ client, plan, sourceCampaignId: campaign_id, resumeCampaignId: resume_campaign_id, logFile }), note: "Everything is PAUSED. Review in Ads Manager, then enable the campaign, ad squads and ads." }),
      };
    },
  );

  write(
    "snap_clone_ad",
    {
      description: "Clone an existing ad (same creative) into other ad squads. New ads are created PAUSED. Skips squads that already have an ad with that creative. Previews unless confirm=true.",
      shape: { ad_id: id(), target_adsquad_ids: z.array(id()).min(1).max(20), new_name: z.string().optional().describe("Name for the new ads; defaults to the source ad name") },
    },
    async ({ ad_id, target_adsquad_ids, new_name }) => {
      const sourceAd = await client.getEntity("ad", ad_id);
      const targetSquads = await loadTargets(client, target_adsquad_ids);
      const sourceSquad = await client.getEntity("adsquad", sourceAd.ad_squad_id);
      const plan = planCloneAd({ sourceAd, targets: targetSquads, newName: new_name, sourceSquad });
      return {
        targets: [{ entity: "ad", obj: sourceAd }, ...targetSquads.map((t) => ({ entity: "adsquad", obj: t.squad }))],
        state: { sourceAd, targets: targetSquads },
        blocked: plan.toCreate.length ? undefined : `Nothing to create: every target was skipped. ${JSON.stringify(plan.skipped)}`,
        preview: { applied: false, dry_run: true, would_create: plan.summary, note: "Nothing was created. Re-run with confirm=true (new ads are PAUSED)." },
        execute: async () => ({ applied: true, created: await executeCloneAd({ client, plan, sourceAdId: ad_id, logFile }), skipped: plan.skipped, note: "New ads are PAUSED. Review in Ads Manager, then enable with snap_set_status." }),
      };
    },
  );

  write(
    "snap_claim_ad_code",
    {
      description: "Claim a creator's ad code (adcode_<uuid>) into the ad account. ONE-WAY: the code is single-use and cannot be unclaimed. Previews (format check only, nothing sent) unless confirm=true.",
      shape: { ad_code: z.string(), profile_id: id().optional().describe("Brand profile id; defaults to SNAP_BRAND_PROFILE_ID") },
      repeatGuard: true,
    },
    async ({ ad_code, profile_id }) => {
      const code = validateAdCode(ad_code);
      const profileId = brandProfile(profile_id);
      const adAccountId = account();
      return {
        preview: { applied: false, dry_run: true, ad_code_format: "valid", brand_profile_id: profileId, warning: "Claiming uses up the creator's single-use code. Nothing was sent. Re-run with confirm=true." },
        execute: async () => ({ applied: true, media_id: await claimAdCode(client, { adAccountId, adCode: code, profileId }), next: "Poll with snap_get_media until media_status is READY, then snap_create_creative." }),
      };
    },
  );

  write(
    "snap_create_creative",
    {
      description: "Create a WEB_VIEW creative from a READY media asset (for example a claimed creator post). Previews unless confirm=true.",
      shape: { media_id: id(), name: z.string(), headline: z.string().describe("Max 34 characters"), url: z.string().describe("https:// landing page"), call_to_action: z.string().default("SHOP_NOW"), profile_id: id().optional() },
      repeatGuard: true,
    },
    async ({ media_id, name, headline, url, call_to_action, profile_id }) => {
      const obj = buildCreative({ adAccountId: account(), profileId: brandProfile(profile_id), mediaId: media_id, name, headline, callToAction: call_to_action, url });
      const media = await getMedia(client, media_id);
      if (media.media_status !== "READY") throw new Error(`Media is ${media.media_status}, not READY yet`);
      return {
        targetIds: [media_id],
        state: { media_status: media.media_status },
        preview: { applied: false, dry_run: true, would_create: { name: obj.name, headline: obj.headline, cta: obj.call_to_action, url: obj.web_view_properties.url, media: media_id }, note: "Nothing created. Re-run with confirm=true." },
        execute: async () => {
          const created = await client.createEntity("creative", obj);
          return { applied: true, creative_id: created.id, name: created.name };
        },
      };
    },
  );

  write(
    "snap_create_ad",
    {
      description: "Create an ad from an existing creative inside an ad squad. Always created PAUSED. Previews unless confirm=true.",
      shape: { creative_id: id(), adsquad_id: id(), name: z.string(), ad_type: z.string().default("REMOTE_WEBPAGE") },
      repeatGuard: true,
    },
    async ({ creative_id, adsquad_id, name, ad_type }) => {
      const squad = await client.getEntity("adsquad", adsquad_id);
      const obj = buildAd({ adSquadId: adsquad_id, creativeId: creative_id, name, type: ad_type });
      return {
        targets: [{ entity: "adsquad", obj: squad }],
        state: { squad },
        preview: { applied: false, dry_run: true, would_create: { name: obj.name, in_adsquad: squad.name, squad_status: squad.status, type: obj.type, status: "PAUSED" }, note: "Nothing created. Re-run with confirm=true." },
        execute: async () => ({ applied: true, ad_id: (await client.createEntity("ad", obj)).id, status: "PAUSED" }),
      };
    },
  );

  write(
    "snap_influencer_ad",
    {
      description: "Full influencer flow in one step: claim a creator ad code, wait for the media, create a WEB_VIEW creative, and create a PAUSED ad in the given ad squad. Claiming is one-way (single-use code). Previews (nothing sent) unless confirm=true.",
      shape: { ad_code: z.string(), adsquad_id: id(), name: z.string().describe("Used for the creative and the ad, e.g. 'Paid - handle - SKU'"), headline: z.string(), url: z.string(), call_to_action: z.string().default("SHOP_NOW"), profile_id: id().optional() },
      repeatGuard: true,
    },
    async ({ ad_code, adsquad_id, name, headline, url, call_to_action, profile_id }) => {
      const code = validateAdCode(ad_code);
      const profileId = brandProfile(profile_id);
      const adAccountId = account();
      const squad = await client.getEntity("adsquad", adsquad_id);
      buildCreative({ adAccountId, profileId, mediaId: "preview", name, headline, callToAction: call_to_action, url });
      return {
        targets: [{ entity: "adsquad", obj: squad }],
        state: { squad },
        preview: { applied: false, dry_run: true, will_do: ["claim ad code (one-way, single-use)", "wait for media READY", "create WEB_VIEW creative", "create PAUSED ad"], in_adsquad: { name: squad.name, status: squad.status }, creative: { name, headline, cta: call_to_action, url }, note: "Nothing was sent. Re-run with confirm=true." },
        execute: async () => ({ applied: true, ...(await runInfluencerFlow({ client, adAccountId, profileId, adCode: code, adSquadId: adsquad_id, name, headline, callToAction: call_to_action, url, logFile })), status: "PAUSED" }),
      };
    },
  );

  write(
    "snap_rename",
    { description: "Rename a campaign, ad squad or ad. Previews unless confirm=true.", shape: { entity: entityEnum, id: id(), new_name: z.string().min(3) }, destructive: true },
    ({ entity, id: entityId, new_name }) => change(entity, entityId, (cur) => planRename(cur, new_name)),
  );

  write(
    "snap_set_bid",
    {
      description: "Set the max bid (account currency) on an ad squad that uses a max bid. Refused above the absolute limit (SNAP_MAX_BID), above +50% per step and per 24 hours (SNAP_MAX_BID_INCREASE_PCT), and on auto-bid squads. Previews unless confirm=true.",
      shape: { adsquad_id: id(), bid: z.number().positive() },
      destructive: true,
    },
    ({ adsquad_id, bid }) => change("adsquad", adsquad_id, (cur) => planBid(cur, bid, policy, { history })),
  );

  write(
    "snap_copy_adsquad",
    {
      description: "Copy one ad squad (optionally with its ads) into a target campaign. Created PAUSED. Budgets are scaled by budget_scale and must stay within the configured limits. Previews unless confirm=true.",
      shape: { adsquad_id: id(), target_campaign_id: id(), new_name: z.string().optional(), include_ads: z.boolean().default(false), budget_scale: z.number().positive().max(2).default(1) },
      repeatGuard: true,
    },
    async ({ adsquad_id, target_campaign_id, new_name, include_ads, budget_scale }) => {
      const squad = await client.getEntity("adsquad", adsquad_id, { return_placement_v2: true });
      const target = await client.getEntity("campaign", target_campaign_id);
      const ads = include_ads ? await client.listChildren("adsquad", adsquad_id, "ad") : [];
      const plan = planCopySquad({ squad, ads, newName: new_name, budgetScale: budget_scale, env: policy });
      return {
        targets: [{ entity: "adsquad", obj: squad }, { entity: "campaign", obj: target }],
        state: { squad, target, ads },
        preview: { applied: false, dry_run: true, would_create_in_campaign: target.name, would_create: plan.summary, note: "Nothing created. Re-run with confirm=true (PAUSED)." },
        execute: async () => {
          const created = await executeCopySquad({ client, plan, targetCampaignId: target_campaign_id, sourceSquadId: adsquad_id, logFile });
          return { applied: true, adsquad_id: created.adsquad.id, ads_created: created.ads, status: "PAUSED" };
        },
      };
    },
  );

  write(
    "snap_create_campaign",
    {
      description: "Create a new, empty campaign (always PAUSED, starting shortly after you enable it). Add ad squads with snap_copy_adsquad. Previews unless confirm=true.",
      shape: { name: z.string().min(3), objective: z.enum(["SALES", "TRAFFIC", "AWARENESS", "ENGAGEMENT", "LEADS", "APP_PROMOTION"]).default("SALES") },
      repeatGuard: true,
    },
    async ({ name, objective }) => {
      const adAccountId = account();
      buildCampaign({ adAccountId, name, objective });
      return {
        preview: { applied: false, dry_run: true, would_create: { name: name.trim(), objective, status: "PAUSED" }, note: "Nothing created. Re-run with confirm=true." },
        execute: async () => ({ applied: true, campaign_id: (await createCampaign({ client, campaign: buildCampaign({ adAccountId, name, objective }), logFile })).id, status: "PAUSED" }),
      };
    },
  );

  write(
    "snap_upload_media",
    {
      description: "Upload a local video (.mp4/.mov) or image (.jpg/.png), up to 1 GB (files over 32 MB go in chunks), to the ad account. It is not attached to any ad. Then poll snap_get_media until READY and use snap_create_creative. Previews (file check only) unless confirm=true.",
      shape: { file_path: z.string().describe("Absolute path on this machine"), name: z.string().optional() },
      repeatGuard: true,
    },
    async ({ file_path, name }) => {
      const info = inspectMediaFile(file_path);
      const adAccountId = account();
      return {
        state: fileState(file_path),
        preview: { applied: false, dry_run: true, file: info.fileName, type: info.type, megabytes: Math.round((info.size / 1048576) * 10) / 10, note: "Nothing uploaded. Re-run with confirm=true." },
        execute: async () => ({ applied: true, ...(await uploadMedia({ client, adAccountId, filePath: file_path, name, logFile })) }),
      };
    },
  );

  write(
    "snap_create_adsquad",
    {
      description: "Create a new ad squad from a few choices (purchase-optimized web squad with a max bid). Always PAUSED. daily_budget and bid must be within the configured limits (SNAP_MIN_DAILY_BUDGET, SNAP_MAX_DAILY_BUDGET, SNAP_MAX_BID). Previews unless confirm=true. Pixel defaults to SNAP_PIXEL_ID.",
      shape: {
        campaign_id: id(),
        name: z.string().min(3),
        daily_budget: z.number().positive().describe("In account currency, e.g. 25"),
        bid: z.number().positive().optional().describe("Max bid in account currency (required unless bid_strategy is AUTO_BID)"),
        bid_strategy: z.enum(["LOWEST_COST_WITH_MAX_BID", "AUTO_BID"]).default("LOWEST_COST_WITH_MAX_BID"),
        pixel_id: id().optional(),
        interests: z.array(z.string()).optional().describe("Interest ids like SLC_11 (see snap_targeting_options)"),
        os_type: z.enum(["iOS", "ANDROID"]).optional(),
        exclude_segment_ids: z.array(id()).optional().describe("e.g. past-buyer audiences"),
        include_segment_ids: z.array(id()).optional(),
        countries: z.array(z.string()).optional().describe("2-letter codes, e.g. [\"us\"]; defaults to SNAP_DEFAULT_COUNTRY"),
        min_age: z.number().int().min(13).max(50).optional(),
        max_age: z.number().int().min(13).max(50).optional(),
        gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
        conversion_window: z.enum(["SWIPE_7DAY", "SWIPE_28DAY_VIEW_1DAY"]).default("SWIPE_7DAY"),
      },
      repeatGuard: true,
    },
    async (a) => {
      const campaign = await client.getEntity("campaign", a.campaign_id);
      const build = () => buildAdSquad({ campaignId: a.campaign_id, name: a.name, dailyBudget: a.daily_budget, bid: a.bid, bidStrategy: a.bid_strategy, pixelId: a.pixel_id ?? cfg.pixel, countries: a.countries ?? defaultCountries(), minAge: a.min_age, maxAge: a.max_age, gender: a.gender, interests: a.interests, osType: a.os_type, excludeSegmentIds: a.exclude_segment_ids, includeSegmentIds: a.include_segment_ids, conversionWindow: a.conversion_window, env: policy });
      const adsquad = build();
      const summary = { name: adsquad.name, in_campaign: campaign.name, daily_budget: a.daily_budget, bid_strategy: a.bid_strategy, max_bid: a.bid, countries: a.countries ?? defaultCountries(), excluded_segments: a.exclude_segment_ids?.length ?? 0, interests: a.interests?.length ?? 0, os_type: a.os_type, goal: adsquad.optimization_goal, conversion_window: adsquad.conversion_window, status: "PAUSED" };
      return {
        targets: [{ entity: "campaign", obj: campaign }],
        state: { campaign },
        preview: { applied: false, dry_run: true, would_create: summary, note: "Nothing created. Re-run with confirm=true (PAUSED)." },
        execute: async () => ({ applied: true, adsquad_id: (await createAdSquad({ client, adsquad: build(), logFile })).id, status: "PAUSED" }),
      };
    },
  );

  write(
    "snap_set_targeting",
    {
      description: "Change an ad squad's targeting: countries, age, gender, interests, device OS, include segments, or stop excluding segments. Everything not mentioned is kept. Previews unless confirm=true.",
      shape: {
        adsquad_id: id(),
        countries: z.array(z.string()).optional(),
        min_age: z.number().int().min(13).max(50).optional(),
        max_age: z.number().int().min(13).max(50).optional(),
        gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
        interests: z.array(z.string()).optional().describe("Replace interests with these ids (e.g. SLC_11); use snap_targeting_options to find ids"),
        clear_interests: z.boolean().optional(),
        os_type: z.enum(["iOS", "ANDROID"]).optional(),
        clear_devices: z.boolean().optional(),
        include_segments: z.array(id()).optional(),
        remove_exclusions: z.array(id()).optional().describe("Segment ids to stop excluding"),
      },
      destructive: true,
    },
    ({ adsquad_id, countries, min_age, max_age, gender, interests, clear_interests, os_type, clear_devices, include_segments, remove_exclusions }) =>
      change("adsquad", adsquad_id, (cur) => planTargeting(cur, { countries, minAge: min_age, maxAge: max_age, gender, interests, clearInterests: clear_interests, osType: os_type, clearDevices: clear_devices, includeSegments: include_segments, removeExclusions: remove_exclusions })),
  );

  write(
    "snap_set_schedule",
    {
      description: "Set start_time and/or end_time (ISO with offset) on a campaign or ad squad. end_time must be in the future and after the start. A change that lets an ACTIVE item deliver sooner (an earlier start, or reviving an ended item) is checked and limited like enabling it. Previews unless confirm=true.",
      shape: { entity: z.enum(["campaign", "adsquad"]), id: id(), start_time: z.string().optional(), end_time: z.string().optional() },
      destructive: true,
    },
    ({ entity, id: entityId, start_time, end_time }) => change(entity, entityId, (cur) => planSchedule(cur, { startTime: start_time, endTime: end_time })),
  );

  write(
    "snap_create_lookalike",
    {
      description: "Create a lookalike audience from a first-party (customer list) seed segment. Creates an audience only, nothing is delivered. Previews unless confirm=true.",
      shape: { seed_segment_id: id(), name: z.string().min(3), countries: z.array(z.string()).optional().describe("2-letter codes; defaults to SNAP_DEFAULT_COUNTRY"), type: z.enum(["BALANCE", "SIMILARITY", "REACH"]).default("BALANCE"), retention_days: z.number().int().min(1).max(180).default(180) },
      repeatGuard: true,
    },
    async ({ seed_segment_id, name, countries, type, retention_days }) => {
      const seed = await client.getEntity("segment", seed_segment_id);
      const obj = buildLookalike({ adAccountId: account(), seedSegmentId: seed_segment_id, name, countries: countries ?? defaultCountries(), type, retentionDays: retention_days });
      return {
        targets: [{ entity: "segment", obj: seed }],
        state: { seed: { id: seed.id, name: seed.name, source_type: seed.source_type } },
        preview: { applied: false, dry_run: true, would_create: { name: obj.name, type, countries: obj.creation_spec.countries, seed: seed.name, seed_size: seed.approximate_number_users, seed_source: seed.source_type }, note: "Nothing created. Re-run with confirm=true." },
        execute: async () => {
          const created = await client.createEntity("segment", obj);
          return { applied: true, segment_id: created.id, name: created.name };
        },
      };
    },
  );

  // Bulk edits of up to 20 items share one shape.
  const idsField = z.array(id()).min(1).max(20);
  const bulk = async (entity, ids, buildPlan) => {
    const prepared = await prepareBulkEdit({ client, entity, ids, buildPlan });
    // Budget increases across all items, plus anything a schedule edit would let start, count as one amount.
    const raise = prepared.will.reduce((n, i) => n + (typeof i.patch?.daily_budget_micro === "number" && i.patch.daily_budget_micro > (i.current.daily_budget_micro ?? 0) ? (i.patch.daily_budget_micro - (i.current.daily_budget_micro ?? 0)) / 1e6 : 0), 0);
    const opening = prepared.will.filter((i) => i.patch && ("start_time" in i.patch || "end_time" in i.patch) && scheduleOpensDelivery(i.current, i.patch));
    const impact = opening.length ? await activationImpact(client, entity, opening.map((i) => ({ ...i.current, ...i.patch })), policy) : undefined;
    return {
      targets: prepared.items.map((i) => ({ entity, obj: i.current })),
      state: { items: prepared.items.map((i) => i.current), impact: impact ?? null },
      addedDailyBudget: raise + (impact?.daily_budget_that_starts_delivering ?? 0),
      blocked: prepared.will.length ? undefined : `Nothing to change. ${JSON.stringify(prepared.skipped)}`,
      preview: { ...prepared.preview, ...(impact ? { activation: { reason: "These schedule changes let ACTIVE items deliver sooner, so they are checked like enabling them.", ...impact } } : {}) },
      execute: () => executeBulkEdit({ client, entity, prepared, buildPlan, logFile }),
    };
  };

  write(
    "snap_bulk_exclude_segments",
    { description: "Add the same buyer-exclusion audiences to up to 20 ad squads. Per-item preview (skips squads that already exclude them); stops at the first failure. Previews unless confirm=true.", shape: { adsquad_ids: idsField, segment_ids: z.array(id()).min(1) }, destructive: true },
    ({ adsquad_ids, segment_ids }) => bulk("adsquad", adsquad_ids, plans.exclude(segment_ids)),
  );

  write(
    "snap_bulk_set_budget",
    {
      description: "Change the daily budget of up to 20 ad squads at once: mode 'set' (same value for all) or 'scale' (multiply each, e.g. 0.5 = half). Every item keeps the single-item guards (absolute limit, max +100% per step and per 24 hours, minimum budget). Previews unless confirm=true.",
      shape: { adsquad_ids: idsField, mode: z.enum(["set", "scale"]), value: z.number().positive() },
      destructive: true,
    },
    ({ adsquad_ids, mode, value }) => bulk("adsquad", adsquad_ids, mode === "set" ? plans.budgetSet(value, policy, { history }) : plans.budgetScale(value, policy, { history })),
  );

  write(
    "snap_bulk_set_schedule",
    { description: "Set start/end time on up to 20 campaigns or ad squads. Changes that let ACTIVE items deliver sooner are checked and limited like enabling them. Previews unless confirm=true.", shape: { entity: z.enum(["campaign", "adsquad"]), ids: idsField, start_time: z.string().optional(), end_time: z.string().optional() }, destructive: true },
    ({ entity, ids, start_time, end_time }) => bulk(entity, ids, plans.schedule({ startTime: start_time, endTime: end_time })),
  );

  write(
    "snap_bulk_rename",
    { description: "Find-and-replace inside the names of up to 20 campaigns, ad squads or ads. Previews unless confirm=true.", shape: { entity: entityEnum, ids: idsField, find: z.string().min(1), replace: z.string().default("") }, destructive: true },
    ({ entity, ids, find, replace }) => bulk(entity, ids, plans.rename(find, replace)),
  );

  write(
    "snap_influencer_batch",
    {
      description:
        "Influencer flow for up to 10 ad codes into one ad squad: for each, claim, wait for media, create creative, create a PAUSED ad. Expired codes are skipped and reported, others continue. Stops if a claimed code ends up incomplete. Claiming is one-way. Previews (format check only) unless confirm=true.",
      shape: {
        adsquad_id: id(),
        items: z.array(z.object({ ad_code: z.string(), name: z.string().describe("e.g. 'Paid - handle - SKU'"), ref: z.string().optional().describe("Your own reference, e.g. a request id from your own tracker") }).strict()).min(1).max(10),
        headline: z.string(),
        url: z.string(),
        call_to_action: z.string().default("SHOP_NOW"),
        profile_id: id().optional(),
      },
      repeatGuard: true,
    },
    async ({ adsquad_id, items, headline, url, call_to_action, profile_id }) => {
      const checked = checkBatch(items);
      const profileId = brandProfile(profile_id);
      const adAccountId = account();
      const squad = await client.getEntity("adsquad", adsquad_id);
      buildCreative({ adAccountId, profileId, mediaId: "preview", name: "preview", headline, callToAction: call_to_action, url });
      return {
        targets: [{ entity: "adsquad", obj: squad }],
        state: { squad },
        preview: { applied: false, dry_run: true, in_adsquad: { name: squad.name, status: squad.status }, codes: checked.length, names: checked.map((c) => c.name), warning: "Each successful claim uses up that creator's single-use code. Nothing was sent. Re-run with confirm=true.", note: "Expired codes cost nothing: they are skipped." },
        execute: () => runBatch({ client, adAccountId, profileId, adSquadId: adsquad_id, headline, callToAction: call_to_action, url, items, logFile }),
      };
    },
  );

  write(
    "snap_clone_creative",
    {
      description: "Duplicate a creative with a new name and optionally a new headline, link or call to action (same media). Creatives have no status, so nothing delivers until you attach one to an ad. Previews unless confirm=true.",
      shape: { creative_id: id(), name: z.string().min(3), headline: z.string().optional(), url: z.string().optional(), call_to_action: z.string().optional() },
      repeatGuard: true,
    },
    async ({ creative_id, name, headline, url, call_to_action }) => {
      const source = await client.getEntity("creative", creative_id);
      const plan = planCloneCreative(source, { name, headline, url, callToAction: call_to_action });
      const adAccountId = account();
      return {
        targets: [{ entity: "creative", obj: source }],
        state: { source },
        preview: { applied: false, dry_run: true, would_create: plan.summary, note: "Nothing created. Re-run with confirm=true." },
        execute: async () => {
          const { created, stripped } = await createWithAutoStrip(client, "creative", { ...plan.obj, ad_account_id: adAccountId });
          return { applied: true, creative_id: created.id, name: created.name, fields_snap_would_not_accept: stripped };
        },
      };
    },
  );

  write(
    "snap_undo",
    {
      description: "Revert one of the changes this server applied (budget, bid, status, targeting, schedule, rename) using the change log. An undo is checked like any other change: raising a budget or bid back up stays within the configured limits, and re-enabling shows and limits what would start delivering. Refuses if the field was changed again since, unless force=true. Not for creates, claims or copies. Previews unless confirm=true.",
      shape: { n_from_last: z.number().int().min(1).max(50).default(1).describe("1 = the most recent undoable change"), force: z.boolean().default(false) },
      destructive: true,
    },
    async ({ n_from_last, force }) => {
      const list = undoableEntries(logFile);
      const entry = list[list.length - n_from_last];
      if (!entry) throw new Error("No undoable change found at that position");
      if (!["campaign", "adsquad", "ad"].includes(entry.entity)) throw new Error("That log entry cannot be undone");
      const reverting = { at: entry.at, name: entry.name, change: entry.change };
      const p = await change(entry.entity, entry.id, (cur) => planUndo(entry, cur, { force, env: policy, history }), { logExtra: { undoes: entry.at }, extraPreview: { reverting } });
      // The approval is tied to this exact log entry, so a newer change cannot shift which one gets undone.
      return { ...p, state: { ...p.state, entry_at: entry.at } };
    },
  );

  write(
    "snap_create_pixel_audience",
    {
      description: "Create an audience of people who fired pixel events (e.g. ADD_CART or VIEW_CONTENT) within N days. Audience only, nothing is delivered. Pixel defaults to SNAP_PIXEL_ID. Previews unless confirm=true.",
      shape: { name: z.string().min(3), events: z.array(z.enum(PIXEL_EVENTS)).min(1), retention_days: z.number().int().min(1).max(180).default(30), pixel_id: id().optional() },
      repeatGuard: true,
    },
    async ({ name, events, retention_days, pixel_id }) => {
      const obj = buildPixelAudience({ adAccountId: account(), pixelId: pixel_id ?? cfg.pixel, name, events, retentionDays: retention_days });
      return {
        preview: { applied: false, dry_run: true, would_create: { name: obj.name, events, retention_days, pixel_id: obj.pixel_id }, note: "Nothing created. Re-run with confirm=true." },
        execute: async () => {
          const created = await client.createEntity("segment", obj);
          return { applied: true, segment_id: created.id, name: created.name };
        },
      };
    },
  );

  write(
    "snap_upload_customer_list",
    {
      description:
        "Create a customer-list audience from a local CSV of emails or phone numbers. Values are normalised and SHA-256 hashed on this machine; only hashes are uploaded and no raw value is ever shown or logged. Previews (counts only) unless confirm=true. Local phone numbers get default_country_code (or SNAP_DEFAULT_PHONE_CODE); without either they are counted as invalid.",
      shape: {
        file_path: z.string().describe("Absolute path to a .csv with a header row"),
        kind: z.enum(["email", "phone"]),
        name: z.string().min(3).describe("Audience name"),
        column: z.string().optional().describe("Header of the column to use; found automatically when omitted"),
        default_country_code: z.string().regex(/^[1-9]\d{0,3}$/, "digits only, e.g. 1, 44 or 966").optional().describe("Country code (digits, no +) for local numbers; defaults to SNAP_DEFAULT_PHONE_CODE. Without one, local numbers are counted as invalid."),
      },
      repeatGuard: true,
    },
    async ({ file_path, kind, name, column, default_country_code }) => {
      const data = readIdentifiers(file_path, { kind, column, defaultCountryCode: default_country_code ?? policy.defaultPhoneCode ?? undefined });
      const summary = { column_used: data.column, rows: data.rows, valid_unique: data.valid, invalid_skipped: data.invalid, duplicates_removed: data.duplicates };
      if (!data.valid) throw new Error(`No valid ${kind} values found. ${JSON.stringify(summary)}`);
      const adAccountId = account();
      return {
        state: { file: fileState(file_path), summary },
        preview: { applied: false, dry_run: true, would_upload: summary, audience_name: name, note: "Only SHA-256 hashes would be sent. Nothing was created. Re-run with confirm=true." },
        execute: async () => {
          const segment = await client.createEntity("segment", buildCustomerSegment({ adAccountId, name }));
          const sent = await uploadCustomerList({ client, segmentId: segment.id, hashes: data.hashes, kind, logFile });
          return { applied: true, segment_id: segment.id, uploaded: sent, ...summary, note: "Snap needs a while to match the list before it shows a size." };
        },
      };
    },
  );

  write(
    "snap_delete",
    {
      description:
        "Permanently delete a campaign, ad squad, ad or audience. Heavily guarded: the item must be PAUSED (audiences excepted), must have spent nothing in the last 30 days, a campaign must have no ACTIVE ad squads, and you must pass confirm_name equal to its exact name. Cannot be undone. Previews (and shows any blockers) unless confirm=true.",
      shape: { entity: z.enum(["campaign", "adsquad", "ad", "segment"]), id: id(), confirm_name: z.string().optional().describe("Exact name of the item, copied from the preview") },
      destructive: true,
      // confirm_name is typed after reading the preview, so it is not part of what the approval is bound to.
      bind: ({ confirm_name, ...rest }) => rest,
    },
    async ({ entity, id: entityId, confirm_name }) => {
      const plan = await planDelete(client, { entity, id: entityId, confirmName: confirm_name });
      return {
        targets: [{ entity, obj: plan.obj }],
        state: { obj: plan.obj, children: plan.summary.will_also_remove ?? null },
        blocked: plan.blockers.length ? `Refusing to delete: ${plan.blockers.join("; ")}` : undefined,
        preview: { applied: false, dry_run: true, preview: plan.summary, note: plan.blockers.length ? "This cannot be deleted yet (see blocked_because)." : "Nothing was deleted. To delete, re-run with confirm=true, the approval_token and confirm_name set to the exact name." },
        execute: () => executeDelete({ client, entity, id: entityId, plan, logFile }),
      };
    },
  );
}
