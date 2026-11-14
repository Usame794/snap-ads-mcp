// Builders for Snap Ad formats beyond the WEB_VIEW Snap Ad: plain Snap Ads, Story Ads (PREVIEW + COMPOSITE) and Collection Ads
// (creative elements + interaction zone + COLLECTION). Field names follow Snap's Marketing API reference (Creatives, Creative
// Elements, Interaction Zones, Ads). Creatives have no status and never spend by themselves; ads are always created PAUSED.

// Call to action values Snap documents for WEB_VIEW creatives (also the allowed interaction zone headlines).
export const WEB_VIEW_CTAS = ["APPLY_NOW", "MORE", "ORDER_NOW", "PLAY", "READ", "SHOP_NOW", "SHOW", "SIGN_UP", "VIEW", "WATCH", "DONATE", "DOWNLOAD", "RESPOND", "BUY_TICKETS", "SHOWTIMES", "BOOK_NOW", "GET_NOW", "LISTEN", "TRY", "VOTE", "VIEW_MENU", "PRE_REGISTER", "PLAY_GAME", "EXPLORE_MORE", "REQUEST_QUOTE"];

// Which ad type each creative type must be used with (Snap's "Ad Type / Allowed Creative Type" table).
export const AD_TYPE_FOR_CREATIVE = {
  SNAP_AD: "SNAP_AD",
  WEB_VIEW: "REMOTE_WEBPAGE",
  APP_INSTALL: "APP_INSTALL",
  DEEP_LINK: "DEEP_LINK",
  COMPOSITE: "STORY",
  COLLECTION: "COLLECTION",
  AD_TO_LENS: "AD_TO_LENS",
  AD_TO_CALL: "AD_TO_CALL",
  AD_TO_MESSAGE: "AD_TO_MESSAGE",
  LEAD_GENERATION: "LEAD_GENERATION",
  REMINDER: "REMINDER",
};

// Creative types a Story (COMPOSITE) may contain.
export const STORY_PART_TYPES = ["SNAP_AD", "APP_INSTALL", "WEB_VIEW", "DEEP_LINK"];

const text = (label, value, max) => {
  const v = String(value ?? "").trim();
  if (!v) throw new Error(`${label} is required`);
  if (v.length > max) throw new Error(`${label} is ${v.length} characters; Snap allows ${max}`);
  return v;
};
const https = (label, url) => {
  if (!/^https:\/\/[^\s]+$/.test(String(url ?? ""))) throw new Error(`${label} must be an https:// address`);
  return url;
};

export function adTypeFor(creativeType, requested) {
  const expected = AD_TYPE_FOR_CREATIVE[creativeType];
  if (creativeType === "PREVIEW") throw new Error("A PREVIEW creative is only the tile of a Story Ad; use its COMPOSITE creative in the ad");
  if (requested && expected && requested !== expected) throw new Error(`A ${creativeType} creative needs ad type ${expected}, not ${requested}`);
  if (!requested && !expected) throw new Error(`Give ad_type for a ${creativeType} creative (see Snap's ad type table)`);
  return requested ?? expected;
}

// A Snap Ad with only a Top Snap (image or video), no attachment and no call to action.
export function buildSnapAdCreative({ adAccountId, profileId, mediaId, name, headline }) {
  return { ad_account_id: adAccountId, name: text("name", name, 375), type: "SNAP_AD", top_snap_media_id: mediaId, headline: text("headline", headline, 34), shareable: true, profile_properties: { profile_id: profileId } };
}

// The tile shown in the Stories tab (Story Ad, full variant).
export function buildPreviewCreative({ adAccountId, name, previewMediaId, previewHeadline, logoMediaId }) {
  const preview_properties = { preview_media_id: previewMediaId, preview_headline: text("preview_headline", previewHeadline, 55) };
  if (logoMediaId) preview_properties.logo_media_id = logoMediaId;
  return { ad_account_id: adAccountId, name: text("name", name, 375), type: "PREVIEW", preview_properties };
}

// The Story itself: 1-20 existing creatives, shown in the given order (fixed once created).
export function buildCompositeCreative({ adAccountId, profileId, name, headline, creativeIds, previewCreativeId }) {
  if (!Array.isArray(creativeIds) || creativeIds.length < 1 || creativeIds.length > 20) throw new Error("A Story needs 1 to 20 creatives");
  if (new Set(creativeIds).size !== creativeIds.length) throw new Error("A Story cannot contain the same creative twice");
  const obj = { ad_account_id: adAccountId, name: text("name", name, 375), type: "COMPOSITE", headline: text("headline", headline, 34), shareable: true, profile_properties: { profile_id: profileId }, composite_properties: { creative_ids: [...creativeIds] } };
  if (previewCreativeId) obj.preview_creative_id = previewCreativeId;
  return obj;
}

// One product tile of a Collection Ad: an image that opens a web page.
export function buildCreativeElement({ adAccountId, name, imageMediaId, url, title, description }) {
  const el = { ad_account_id: adAccountId, name: text("product name", name, 375), type: "BUTTON", interaction_type: "WEB_VIEW", button_properties: { button_overlay_media_id: imageMediaId }, web_view_properties: { url: https("product url", url) } };
  if (title) el.title = String(title).trim();
  if (description) el.description = String(description).trim();
  return el;
}

// The row of product tiles. Snap requires at least 4; this server allows at most 20.
export function buildInteractionZone({ adAccountId, name, headline, creativeElementIds }) {
  if (!WEB_VIEW_CTAS.includes(headline)) throw new Error(`button label must be one of ${WEB_VIEW_CTAS.join(", ")}`);
  if (!Array.isArray(creativeElementIds) || creativeElementIds.length < 4 || creativeElementIds.length > 20) throw new Error("A Collection needs 4 to 20 products");
  return { ad_account_id: adAccountId, name: text("name", name, 375), headline, creative_element_ids: [...creativeElementIds] };
}

// The Collection creative. Snap requires call_to_action to be left out (the interaction zone headline is used instead).
export function buildCollectionCreative({ adAccountId, profileId, name, topSnapMediaId, headline, interactionZoneId, fallbackUrl }) {
  return {
    ad_account_id: adAccountId,
    name: text("name", name, 375),
    type: "COLLECTION",
    top_snap_media_id: topSnapMediaId,
    headline: text("headline", headline, 34),
    shareable: true,
    profile_properties: { profile_id: profileId },
    collection_properties: { interaction_zone_id: interactionZoneId, default_fallback_interaction_type: "WEB_VIEW", web_view_properties: { url: https("fallback_url", fallbackUrl) } },
  };
}
