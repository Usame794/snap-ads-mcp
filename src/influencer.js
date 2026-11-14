// Influencer (creator) ad-code flow: claim the creator's post, wait for the media, build a creative, build a paused ad.
import { logChange } from "./changes.js";

const AD_CODE_RE = /^adcode_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Snap's documented call to action values for WEB_VIEW creatives (BUY_NOW and VIEW_MORE are not among them).
export { WEB_VIEW_CTAS as CTAS } from "./formats.js";
import { WEB_VIEW_CTAS as CTAS } from "./formats.js";

export function validateAdCode(code) {
  const c = String(code ?? "").trim();
  if (!AD_CODE_RE.test(c)) {
    throw new Error("Ad code must look like adcode_<uuid> (the full string, with the adcode_ prefix and no spaces). Codes starting with # or other formats are for other platforms.");
  }
  return c;
}

// Claiming is one-way: the code is single-use and binds the creator's post to this ad account.
export async function claimAdCode(client, { adAccountId, adCode, profileId }) {
  const code = validateAdCode(adCode);
  if (!profileId) throw new Error("profile_id (the brand profile id) is required");
  // Snap sends these as query parameters (like its sibling claim endpoint); a JSON body gave an HTTP 500.
  const data = await client.request("POST", `/adaccounts/${adAccountId}/claim_media_by_ad_code`, { query: { ad_code: code, profile_id: profileId } });
  if (!data.media_entity_id) throw new Error(`Claim returned no media_entity_id: ${JSON.stringify(data).slice(0, 300)}`);
  return data.media_entity_id;
}

export async function getMedia(client, mediaId) {
  const data = await client.request("GET", `/media/${mediaId}`);
  const m = data.media?.[0]?.media;
  if (!m) throw new Error(`Media ${mediaId} not found`);
  return m;
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForMedia(client, mediaId, { timeoutMs = 10 * 60_000, intervalMs = 8_000, sleep = sleepReal } = {}) {
  const started = Date.now();
  for (;;) {
    const m = await getMedia(client, mediaId);
    if (m.media_status === "READY") return m;
    if (m.media_status === "ERROR") throw new Error(`Media ${mediaId} failed processing (ERROR). Ask the creator for a new ad code.`);
    if (Date.now() - started > timeoutMs) throw new Error(`Media ${mediaId} still ${m.media_status} after ${Math.round(timeoutMs / 1000)}s. It may become READY later: check with snap_get_media, then continue.`);
    await sleep(intervalMs);
  }
}

export function buildCreative({ adAccountId, profileId, mediaId, name, headline, callToAction = "SHOP_NOW", url }) {
  if (!name?.trim()) throw new Error("name is required");
  if (!headline?.trim()) throw new Error("headline is required");
  if (headline.length > 34) throw new Error(`headline is ${headline.length} characters; Snap allows 34`);
  if (!/^https:\/\//.test(url ?? "")) throw new Error("url must start with https://");
  if (!CTAS.includes(callToAction)) throw new Error(`call_to_action must be one of ${CTAS.join(", ")}`);
  return {
    ad_account_id: adAccountId,
    name: name.trim(),
    type: "WEB_VIEW",
    top_snap_media_id: mediaId,
    headline: headline.trim(),
    call_to_action: callToAction,
    shareable: true,
    web_view_properties: { url, allow_snap_javascript_sdk: false, use_immersive_mode: false, block_preload: false },
    profile_properties: { profile_id: profileId },
  };
}

export function buildAd({ adSquadId, creativeId, name, type = "REMOTE_WEBPAGE" }) {
  // REMOTE_WEBPAGE is the ad type for the WEB_VIEW creatives this module builds; other formats pass their own type.
  if (!name?.trim()) throw new Error("name is required");
  return { ad_squad_id: adSquadId, creative_id: creativeId, name: name.trim(), type, status: "PAUSED" };
}

// The whole flow in one go. Returns ids of everything created; the ad is PAUSED.
export async function runInfluencerFlow({ client, adAccountId, profileId, adCode, adSquadId, name, headline, callToAction, url, logFile, sleep, timeoutMs }) {
  const done = {};
  try {
    done.media_id = await claimAdCode(client, { adAccountId, adCode, profileId });
    await waitForMedia(client, done.media_id, { sleep, timeoutMs });
    const creative = await client.createEntity("creative", buildCreative({ adAccountId, profileId, mediaId: done.media_id, name, headline, callToAction, url }));
    done.creative_id = creative.id;
    const ad = await client.createEntity("ad", buildAd({ adSquadId, creativeId: creative.id, name }));
    done.ad_id = ad.id;
  } catch (e) {
    logChange({ entity: "influencer_ad", id: done.media_id ?? null, change: `FAILED: ${e.message}`, done }, logFile);
    const err = new Error(`${e.message}. Progress so far: ${JSON.stringify(done)}`);
    err.done = done;
    throw err;
  }
  logChange({ entity: "influencer_ad", id: done.ad_id, change: `claimed ad code, created creative and PAUSED ad "${name}"`, done }, logFile);
  return done;
}
