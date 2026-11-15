// Catalog (Dynamic Product) ads: product sets, dynamic templates, the DPA creative, and the audience rules for DPA ad squads.
// Everything here follows Snap's Dynamic Product Ads guide. Nothing is sent from this file; the tools send, after a preview.

const ENUM_ATTRS = {
  AGE_GROUP: ["NEWBORN", "INFANT", "TODDLER", "KIDS", "ADULT"],
  AVAILABILITY: ["IN_STOCK", "OUT_OF_STOCK", "PREORDER", "DISCONTINUED", "AVAILABLE_FOR_ORDER"],
  CONDITION: ["NEW", "REFURBISHED", "USED"],
  GENDER: ["MALE", "FEMALE", "UNISEX"],
};
const NUMBER_ATTRS = ["PRICE_AMOUNT"];
const STRING_ATTRS = ["BRAND", "COLOR", "CUSTOM_LABEL_0", "CUSTOM_LABEL_1", "CUSTOM_LABEL_2", "CUSTOM_LABEL_3", "CUSTOM_LABEL_4", "GOOGLE_PRODUCT_CATEGORY", "ID", "ITEM_GROUP_ID", "MATERIAL", "PATTERN", "PRODUCT_TYPE", "SIZE", "TITLE", "PRICE_CURRENCY"];
export const PRODUCT_ATTRIBUTES = [...Object.keys(ENUM_ATTRS), ...NUMBER_ATTRS, ...STRING_ATTRS].sort();
const COMPARE = ["EQ", "NEQ", "GT", "GTE", "LT", "LTE"];
const STRING_OPS = ["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "I_CONTAINS", "I_NOT_CONTAINS", "STARTS_WITH", "I_STARTS_WITH"];
const LIST_OPS = ["IS_ANY", "IS_NOT_ANY", "I_IS_ANY", "I_IS_NOT_ANY"];
export const MAX_FILTER_ENTRIES = 10;

const isPlain = (o) => o && typeof o === "object" && !Array.isArray(o);

function checkEntry(entry, seen) {
  if (!isPlain(entry) || Object.keys(entry).length !== 1) throw new Error("Each filter entry must be one attribute, such as {\"AVAILABILITY\": {\"EQ\": \"IN_STOCK\"}}");
  const [attr] = Object.keys(entry);
  if (!PRODUCT_ATTRIBUTES.includes(attr)) throw new Error(`Unknown product attribute ${attr}. Allowed: ${PRODUCT_ATTRIBUTES.join(", ")}`);
  if (seen.has(attr)) throw new Error(`${attr} appears more than once. Snap allows each attribute only once per filter; list several values with IS_ANY instead.`);
  seen.add(attr);
  const cond = entry[attr];
  if (!isPlain(cond) || Object.keys(cond).length !== 1) throw new Error(`${attr} needs exactly one operator, such as {"EQ": "value"}`);
  const [op] = Object.keys(cond);
  const value = cond[op];
  if (attr in ENUM_ATTRS) {
    if (!["EQ", "NEQ"].includes(op)) throw new Error(`${attr} only supports EQ and NEQ`);
    if (!ENUM_ATTRS[attr].includes(value)) throw new Error(`${attr} must be one of ${ENUM_ATTRS[attr].join(", ")} (capitals, underscores)`);
    return;
  }
  if (NUMBER_ATTRS.includes(attr)) {
    if (!COMPARE.includes(op)) throw new Error(`${attr} supports ${COMPARE.join(", ")}`);
    if (typeof value !== "string" || !/^\d+(\.\d{1,2})?$/.test(value)) throw new Error(`${attr} must be a number with at most 2 decimals, written as a string such as "15.50"`);
    return;
  }
  if (attr === "PRICE_CURRENCY") {
    if (!["EQ", "NEQ"].includes(op) || !/^[A-Z]{2,3}$/.test(String(value))) throw new Error("PRICE_CURRENCY supports EQ / NEQ with a currency code such as USD");
    return;
  }
  if (LIST_OPS.includes(op)) {
    const limit = attr === "ID" ? 1000 : 15;
    if (!Array.isArray(value) || !value.length) throw new Error(`${attr} ${op} needs a list of values`);
    if (value.length > limit) throw new Error(`${attr} ${op} allows at most ${limit} values (Snap's limit); you gave ${value.length}`);
    if (value.some((v) => typeof v !== "string" || !/^[A-Za-z0-9 _.-]{1,255}$/.test(v))) throw new Error(`${attr} ${op} only works with letters, digits, spaces, "_", "." and "-" (1-255 characters each)`);
    return;
  }
  if (!STRING_OPS.includes(op)) throw new Error(`${attr} does not support ${op}. Use ${[...STRING_OPS, ...LIST_OPS].join(", ")}`);
  if (typeof value !== "string" || value.length < 1 || value.length > 255) throw new Error(`${attr} ${op} needs a text value of 1-255 characters`);
}

// A product set filter in Snap's shape. Returns the filter unchanged when valid, so what is previewed is exactly what is sent.
export function checkProductSetFilter(filter) {
  if (!isPlain(filter) || !Object.keys(filter).length) throw new Error("filter is required, for example {\"AVAILABILITY\": {\"EQ\": \"IN_STOCK\"}}");
  const keys = Object.keys(filter);
  const seen = new Set();
  if (keys.length === 1 && (keys[0] === "AND" || keys[0] === "OR")) {
    const list = filter[keys[0]];
    if (!Array.isArray(list) || list.length < 1) throw new Error(`${keys[0]} needs a list of filter entries`);
    if (list.length > MAX_FILTER_ENTRIES) throw new Error(`At most ${MAX_FILTER_ENTRIES} filter rules can be chained (Snap's limit)`);
    for (const e of list) checkEntry(e, seen);
  } else {
    if (keys.some((k) => k === "AND" || k === "OR")) throw new Error("Use AND or OR on its own, around a list of entries. Only one logical operator is allowed.");
    checkEntry(filter, seen);
  }
  return filter;
}

export function buildProductSet({ name, filter }) {
  const n = String(name ?? "").trim();
  if (n.length < 3 || n.length > 255) throw new Error("name must be 3-255 characters");
  return { name: n, filter: checkProductSetFilter(filter) };
}

// Describes a filter in words, for the preview.
export function describeFilter(filter) {
  const one = (e) => {
    const [attr] = Object.keys(e);
    const [op] = Object.keys(e[attr]);
    const v = e[attr][op];
    return `${attr} ${op} ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`;
  };
  const k = Object.keys(filter)[0];
  return k === "AND" || k === "OR" ? filter[k].map(one).join(` ${k} `) : one(filter);
}

// ---------- Dynamic template ----------

export const TEMPLATE_LAYOUTS = ["AUTOMATIC", "FILL_WIDTH", "FILL_HEIGHT", "FIT", "HEADER", "TILT"];
export const TEMPLATE_TEXT_FIELDS = ["title", "price", "descriptionTruncated", "salePrice", "availability", "brand", "condition", "ageGroup", "color", "gender", "productType", "size", "customLabel_0", "customLabel_1", "customLabel_2", "customLabel_3", "customLabel_4"];
export const TEMPLATE_URL = "https://ads-interfaces.sc-cdn.net/adformats/templates/V2/index.html";

export function buildDynamicTemplate({ adAccountId, name, layout = "AUTOMATIC", textFields = ["title", "price"], backgroundColor }) {
  const n = String(name ?? "").trim();
  if (!n || n.length > 375) throw new Error("name must be 1-375 characters");
  if (!TEMPLATE_LAYOUTS.includes(layout)) throw new Error(`layout must be one of ${TEMPLATE_LAYOUTS.join(", ")} (CAROUSEL and SLIDESHOW belong to Collection ads)`);
  if (!Array.isArray(textFields) || textFields.length > 2) throw new Error("text_fields takes at most 2 fields");
  const bad = textFields.filter((f) => !TEMPLATE_TEXT_FIELDS.includes(f));
  if (bad.length) throw new Error(`Unknown text field ${bad.join(", ")}. Allowed: ${TEMPLATE_TEXT_FIELDS.join(", ")}`);
  if (backgroundColor !== undefined && !/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(backgroundColor)) throw new Error("background_color must be a 3 or 6 digit hex colour such as #FFFFFF");
  const obj = { ad_account_id: adAccountId, name: n, ios_url: TEMPLATE_URL, android_url: TEMPLATE_URL, layout, text_fields: textFields };
  if (backgroundColor !== undefined) obj.background_color = backgroundColor.replace(/^#/, "");
  return obj;
}

// ---------- DPA creative ----------

export function buildDynamicCreative({ adAccountId, profileId, name, headline, callToAction, templateId, productSetId, urlMacroParameters }) {
  if (!String(name ?? "").trim()) throw new Error("name is required");
  if (!String(headline ?? "").trim()) throw new Error("headline is required");
  if (headline.length > 34) throw new Error(`headline is ${headline.length} characters; Snap allows 34`);
  if (!templateId) throw new Error("dynamic_template_id is required (see snap_list_dynamic_templates)");
  if (!productSetId) throw new Error("product_set_id is required (see snap_list_product_sets)");
  const obj = {
    ad_account_id: adAccountId,
    name: name.trim(),
    type: "WEB_VIEW",
    render_type: "DYNAMIC",
    headline: headline.trim(),
    call_to_action: callToAction,
    shareable: true,
    profile_properties: { profile_id: profileId },
    dynamic_render_properties: { dynamic_template_id: templateId, product_set_id: productSetId },
  };
  if (urlMacroParameters) {
    if (!/^[A-Za-z0-9_.=&-]{1,500}$/.test(urlMacroParameters)) throw new Error("url_macro_parameters looks like utm_campaign=campaign.name&utm_content=ad.id");
    obj.url_macro_parameters = urlMacroParameters;
  }
  return obj;
}

// ---------- DPA ad squad audiences ----------

export const PRODUCT_EVENTS = ["PAGE_VIEW", "VIEW_CONTENT", "ADD_CART", "PURCHASE"];

// retargeting: people who viewed or added to cart, not people who bought. prospecting: everyone who has NOT interacted.
export function productAudiences({ mode, productSetId, days = 14 }) {
  if (!["retargeting", "prospecting"].includes(mode)) throw new Error("dpa_mode must be retargeting or prospecting");
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("audience_days must be a whole number from 1 to 30");
  const seconds = days * 86_400;
  const rule = (event_type, operation) => ({ product_set: productSetId, event_type, retention_seconds: seconds, operation });
  return mode === "retargeting"
    ? [rule("VIEW_CONTENT", "INCLUDE"), rule("ADD_CART", "INCLUDE"), rule("PURCHASE", "EXCLUDE")]
    : PRODUCT_EVENTS.map((e) => rule(e, "EXCLUDE"));
}

// What the ad squad says about its catalog. Used to check an ad's creative against its ad squad.
export const squadProductSet = (squad) => squad?.product_properties?.product_set_id ?? null;
export const creativeProductSet = (creative) => creative?.dynamic_render_properties?.product_set_id ?? null;
