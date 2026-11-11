// Creating a campaign from scratch and uploading media files. Everything is created PAUSED / unattached.
import { openSync, closeSync, readSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { logChange } from "./changes.js";
import { checkBid, checkDailyBudget, loadPolicy } from "./policy.js";

const OBJECTIVES = ["SALES", "TRAFFIC", "AWARENESS", "ENGAGEMENT", "LEADS", "APP_PROMOTION"];
const startIn = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

export function buildCampaign({ adAccountId, name, objective = "SALES", now = startIn(10) }) {
  const n = String(name ?? "").trim();
  if (n.length < 3) throw new Error("name must be at least 3 characters");
  if (!OBJECTIVES.includes(objective)) throw new Error(`objective must be one of ${OBJECTIVES.join(", ")}`);
  return {
    ad_account_id: adAccountId,
    name: n,
    status: "PAUSED",
    start_time: now,
    buy_model: "AUCTION",
    objective_v2_properties: { objective_v2_type: objective },
  };
}

export async function createCampaign({ client, campaign, logFile }) {
  const created = await client.createEntity("campaign", campaign);
  logChange({ entity: "campaign_create", id: created.id, change: `created PAUSED campaign "${campaign.name}"` }, logFile);
  return created;
}

const MEDIA_TYPES = { ".mp4": "VIDEO", ".mov": "VIDEO", ".jpg": "IMAGE", ".jpeg": "IMAGE", ".png": "IMAGE" };
export const SIMPLE_UPLOAD_MAX = 32 * 1024 * 1024; // Snap's simple upload limit
export const CHUNK_BYTES = 30 * 1024 * 1024; // each chunk must be <= 32 MB
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 32 chunks


export function inspectMediaFile(filePath, stat = statSync) {
  const ext = extname(filePath).toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) throw new Error(`Unsupported file type "${ext}". Use .mp4, .mov, .jpg, .jpeg or .png`);
  let size;
  try {
    size = stat(filePath).size;
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  if (size === 0) throw new Error("File is empty");
  if (size > MAX_UPLOAD_BYTES) throw new Error(`File is ${(size / 1048576).toFixed(1)} MB; the maximum is 1 GB. Compress it first.`);
  return { type, size, fileName: basename(filePath) };
}

function readChunk(filePath, start, length) {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

// Files over 32 MB: INIT, then one ADD per chunk, then FINALIZE.
async function uploadChunked({ client, mediaId, filePath, info }) {
  const parts = Math.ceil(info.size / CHUNK_BYTES);
  const init = new FormData();
  init.append("file_name", info.fileName);
  init.append("file_size", String(info.size));
  init.append("number_of_parts", String(parts));
  const started = await client.upload(`/media/${mediaId}/multipart-upload-v2?action=INIT`, init);
  if (!started.upload_id || !started.add_path || !started.finalize_path) throw new Error(`Chunked upload INIT returned no upload_id/paths: ${JSON.stringify(started).slice(0, 200)}`);
  for (let i = 0; i < parts; i++) {
    const form = new FormData();
    form.append("upload_id", started.upload_id);
    form.append("part_number", String(i + 1));
    form.append("file", new Blob([readChunk(filePath, i * CHUNK_BYTES, CHUNK_BYTES)]), `${info.fileName}.part${i + 1}`);
    await client.upload(started.add_path, form, { absolute: true });
  }
  const fin = new FormData();
  fin.append("upload_id", started.upload_id);
  await client.upload(started.finalize_path, fin, { absolute: true });
  return parts;
}

// 1) create the media entity  2) upload the bytes (simple or chunked). The media then processes asynchronously (poll snap_get_media).
export async function uploadMedia({ client, adAccountId, filePath, name, logFile }) {
  const info = inspectMediaFile(filePath);
  const label = (name ?? info.fileName).trim();
  const media = await client.createEntity("media", { ad_account_id: adAccountId, name: label, type: info.type });
  let parts = 1;
  try {
    if (info.size <= SIMPLE_UPLOAD_MAX) {
      const form = new FormData();
      form.append("file", new Blob([readFileSync(filePath)]), info.fileName);
      await client.upload(`/media/${media.id}/upload`, form);
    } else {
      parts = await uploadChunked({ client, mediaId: media.id, filePath, info });
    }
  } catch (e) {
    logChange({ entity: "media_upload", id: media.id, change: `upload FAILED: ${e.message}` }, logFile);
    throw new Error(`${e.message}. The media entity ${media.id} was created but the upload did not complete; retry with another file or ignore it.`);
  }
  logChange({ entity: "media_upload", id: media.id, change: `uploaded ${info.fileName} (${info.type}, ${info.size} bytes, ${parts} part${parts > 1 ? "s" : ""})` }, logFile);
  return { media_id: media.id, type: info.type, bytes: info.size, parts };
}

// A new ad squad from a few choices. Always PAUSED. Defaults suit web purchase squads.
export function buildAdSquad({ campaignId, name, dailyBudget, bid, bidStrategy = "LOWEST_COST_WITH_MAX_BID", pixelId, countries, minAge, maxAge, gender, interests, osType, excludeSegmentIds, includeSegmentIds, conversionWindow = "SWIPE_7DAY", optimizationGoal = "PIXEL_PURCHASE", childAdType = "REMOTE_WEBPAGE", now = startIn(10), env = process.env }) {
  const policy = loadPolicy(env);
  const n = String(name ?? "").trim();
  if (n.length < 3) throw new Error("name must be at least 3 characters");
  if (!(dailyBudget >= policy.minDailyBudget)) throw new Error(`daily_budget must be at least ${policy.minDailyBudget} (account currency)`);
  checkDailyBudget(policy, { value: dailyBudget, what: "daily_budget" });
  if (!["LOWEST_COST_WITH_MAX_BID", "AUTO_BID"].includes(bidStrategy)) throw new Error("bid_strategy must be LOWEST_COST_WITH_MAX_BID or AUTO_BID");
  if (bidStrategy === "LOWEST_COST_WITH_MAX_BID" && !(bid > 0)) throw new Error("bid must be greater than 0 for a max-bid squad");
  if (bidStrategy === "LOWEST_COST_WITH_MAX_BID") checkBid(policy, { value: bid, what: "bid" });
  if (bidStrategy === "AUTO_BID" && bid != null) throw new Error("bid is not used with AUTO_BID; leave it out");
  if (!pixelId) throw new Error("pixel_id is required (or set SNAP_PIXEL_ID)");
  if (!["SWIPE_7DAY", "SWIPE_28DAY_VIEW_1DAY"].includes(conversionWindow)) throw new Error("conversion_window must be SWIPE_7DAY or SWIPE_28DAY_VIEW_1DAY");
  if (!Array.isArray(countries) || !countries.length) throw new Error("countries is required: give 2-letter codes such as [\"us\"], or set SNAP_DEFAULT_COUNTRY");
  const geos = countries.map((c) => String(c).trim().toLowerCase());
  if (!geos.length || geos.some((c) => !/^[a-z]{2}$/.test(c))) throw new Error("countries must be 2-letter codes");
  const targeting = { regulated_content: false, geos: geos.map((country_code) => ({ country_code })) };
  if (minAge != null || maxAge != null || gender) {
    const demo = { operation: "INCLUDE" };
    if (minAge != null) demo.min_age = String(minAge);
    if (maxAge != null) demo.max_age = String(maxAge);
    if (gender) demo.gender = gender;
    targeting.demographics = [demo];
  }
  if (interests?.length) {
    if (interests.some((i) => !/^[A-Z]{2,4}_\d+$/.test(i))) throw new Error("interest ids look like SLC_11");
    targeting.interests = [{ category_id: interests, operation: "INCLUDE" }];
  }
  if (osType) {
    if (!["iOS", "ANDROID"].includes(osType)) throw new Error("os_type must be iOS or ANDROID");
    targeting.devices = [{ os_type: osType, operation: "INCLUDE" }];
  }
  const segments = [];
  if (includeSegmentIds?.length) segments.push({ segment_id: includeSegmentIds, operation: "INCLUDE" });
  if (excludeSegmentIds?.length) segments.push({ segment_id: excludeSegmentIds, operation: "EXCLUDE" });
  if (segments.length) targeting.segments = segments;
  const squad = {
    campaign_id: campaignId,
    name: n,
    status: "PAUSED",
    type: "SNAP_ADS",
    child_ad_type: childAdType,
    targeting,
    placement_v2: { config: "AUTOMATIC" },
    billing_event: "IMPRESSION",
    optimization_goal: optimizationGoal,
    pixel_id: pixelId,
    conversion_window: conversionWindow,
    bid_strategy: bidStrategy,
    delivery_constraint: "DAILY_BUDGET",
    daily_budget_micro: Math.round(dailyBudget * 1_000_000),
    start_time: now,
  };
  if (bidStrategy === "LOWEST_COST_WITH_MAX_BID") squad.bid_micro = Math.round(bid * 1_000_000);
  return squad;
}

export async function createAdSquad({ client, adsquad, logFile }) {
  const created = await client.createEntity("adsquad", adsquad);
  logChange({ entity: "adsquad_create", id: created.id, change: `created PAUSED ad squad "${adsquad.name}"` }, logFile);
  return created;
}
