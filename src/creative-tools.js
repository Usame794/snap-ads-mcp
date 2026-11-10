// Duplicate a creative with a new name / headline / link. Creatives have no status, so nothing delivers by itself.
const STRIP = ["id", "created_at", "updated_at", "packaging_status", "review_status", "review_status_details", "semantic_id", "forced_view_eligibility", "ad_account_id"];

function deleteDeep(o, key) {
  for (const k of Object.keys(o)) {
    if (k === key) delete o[k];
    else if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) deleteDeep(o[k], key);
  }
}

export function planCloneCreative(source, { name, headline, url, callToAction }) {
  const n = String(name ?? "").trim();
  if (n.length < 3) throw new Error("name must be at least 3 characters");
  if (headline != null && headline.length > 34) throw new Error(`headline is ${headline.length} characters; Snap allows 34`);
  if (url != null && !/^https:\/\//.test(url)) throw new Error("url must start with https://");
  const obj = structuredClone(source);
  for (const k of STRIP) delete obj[k];
  obj.name = n;
  if (headline != null) obj.headline = headline.trim();
  if (callToAction) obj.call_to_action = callToAction;
  if (url != null) {
    if (!obj.web_view_properties) throw new Error("This creative has no web view link to change");
    obj.web_view_properties = { ...obj.web_view_properties, url };
  }
  return { obj, summary: { name: obj.name, type: source.type, headline: obj.headline, call_to_action: obj.call_to_action, url: obj.web_view_properties?.url } };
}

// Snap rejects some returned-only fields on create; remove each one it names and retry.
export async function createWithAutoStrip(client, entity, obj, { maxRetries = 8 } = {}) {
  const work = structuredClone(obj);
  const stripped = [];
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const created = await client.createEntity(entity, { ...work, ad_account_id: obj.ad_account_id ?? work.ad_account_id });
      return { created, stripped };
    } catch (e) {
      const m = e.message.match(/not allowed : \[(\w+)\]/);
      if (!m || stripped.includes(m[1])) throw e;
      stripped.push(m[1]);
      deleteDeep(work, m[1]);
    }
  }
  throw new Error(`Gave up after removing: ${stripped.join(", ")}`);
}
