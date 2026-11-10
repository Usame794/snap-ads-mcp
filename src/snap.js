// Thin client for the Snapchat Marketing API (https://adsapi.snapchat.com/v1).
const API = "https://adsapi.snapchat.com/v1";
const TOKEN_URL = "https://accounts.snapchat.com/login/oauth2/access_token";

// Fields the API returns but rejects (or ignores) on update.
const READ_ONLY = [
  "created_at",
  "updated_at",
  "delivery_status",
  "delivery_properties_version",
  "targeting_reach_status",
  "review_status",
  "review_status_reasons",
  "render_type",
];

export const ENTITIES = {
  segment: {
    plural: "segments",
    singular: "segment",
    getPath: (id) => `/segments/${id}`,
    createPath: (obj) => `/adaccounts/${obj.ad_account_id}/segments`,
    updatePath: (obj) => `/adaccounts/${obj.ad_account_id}/segments`,
  },
  media: {
    plural: "media",
    singular: "media",
    getPath: (id) => `/media/${id}`,
    createPath: (obj) => `/adaccounts/${obj.ad_account_id}/media`,
    updatePath: (obj) => `/adaccounts/${obj.ad_account_id}/media`,
  },
  creative: {
    plural: "creatives",
    singular: "creative",
    getPath: (id) => `/creatives/${id}`,
    createPath: (obj) => `/adaccounts/${obj.ad_account_id}/creatives`,
    updatePath: (obj) => `/adaccounts/${obj.ad_account_id}/creatives`,
  },
  campaign: {
    plural: "campaigns",
    singular: "campaign",
    getPath: (id) => `/campaigns/${id}`,
    updatePath: (obj) => `/adaccounts/${obj.ad_account_id}/campaigns`,
    createPath: (obj) => `/adaccounts/${obj.ad_account_id}/campaigns`,
  },
  adsquad: {
    plural: "adsquads",
    singular: "adsquad",
    getPath: (id) => `/adsquads/${id}`,
    updatePath: (obj) => `/campaigns/${obj.campaign_id}/adsquads`,
    createPath: (obj) => `/campaigns/${obj.campaign_id}/adsquads`,
  },
  ad: {
    plural: "ads",
    singular: "ad",
    getPath: (id) => `/ads/${id}`,
    updatePath: (obj) => `/adsquads/${obj.ad_squad_id}/ads`,
    createPath: (obj) => `/adsquads/${obj.ad_squad_id}/ads`,
  },
};

// Extra fields to drop when creating a new entity from an existing one.
const CREATE_STRIP = ["id", "creation_state", "forced_view_setting"];

// Fields Snap returns but rejects on create, at any nesting depth (e.g. product_properties.catalog_vertical).
const CREATE_STRIP_DEEP = ["catalog_vertical"];

function deleteDeep(o, key) {
  for (const k of Object.keys(o)) {
    if (k === key) delete o[k];
    else if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) deleteDeep(o[k], key);
  }
}

export function sanitizeForCreate(obj) {
  const copy = sanitizeForUpdate(obj);
  // render_type is read-only on update but must be kept when creating an ad, so it matches its creative.
  if (obj.render_type !== undefined) copy.render_type = obj.render_type;
  for (const f of CREATE_STRIP) delete copy[f];
  for (const f of CREATE_STRIP_DEEP) deleteDeep(copy, f);
  return copy;
}

export function sanitizeForUpdate(obj) {
  const copy = JSON.parse(JSON.stringify(obj));
  for (const f of READ_ONLY) delete copy[f];
  return copy;
}

const RETRY_STATUSES = [429, 500, 502, 503, 504];
const MAX_ATTEMPTS = 4;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SnapClient {
  constructor({ env = process.env, fetchImpl = fetch, beforeToken, sleep = realSleep } = {}) {
    this.env = env;
    this.beforeToken = beforeToken;
    this.sleep = sleep;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiry = 0;
  }

  // Reads (and the token call) retry on 429/5xx and network errors. Writes retry ONLY on 429, which Snap sends before
  // processing, so a create/claim is never repeated by accident.
  async fetchRetry(url, opts = {}) {
    const method = (opts.method ?? "GET").toUpperCase();
    const safe = method === "GET" || String(url).includes("access_token");
    let last;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetch(url, opts);
        const retryable = safe ? RETRY_STATUSES.includes(res.status) : res.status === 429;
        if (!retryable || attempt === MAX_ATTEMPTS) return res;
        const ra = Number(res.headers?.get?.("retry-after"));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : Math.min(500 * 2 ** (attempt - 1), 8000));
      } catch (e) {
        last = e;
        if (!safe || attempt === MAX_ATTEMPTS) throw e;
        await this.sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
      }
    }
    throw last;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiry - 60_000) return this.token;
    this.beforeToken?.();
    const { SNAP_CLIENT_ID, SNAP_CLIENT_SECRET, SNAP_REFRESH_TOKEN } = this.env;
    if (!SNAP_CLIENT_ID || !SNAP_CLIENT_SECRET || !SNAP_REFRESH_TOKEN) {
      throw new Error("Missing SNAP_CLIENT_ID, SNAP_CLIENT_SECRET or SNAP_REFRESH_TOKEN. Fill in .env (see .env.example).");
    }
    const res = await this.fetchRetry(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: SNAP_CLIENT_ID,
        client_secret: SNAP_CLIENT_SECRET,
        refresh_token: SNAP_REFRESH_TOKEN,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Snap token refresh failed (${res.status}): ${data.error_description || data.error || "no detail"}`);
    }
    this.token = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in ?? 1800) * 1000;
    return this.token;
  }

  async request(method, path, { query, body } = {}) {
    const token = await this.accessToken();
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await this.fetchRetry(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.request_status === "ERROR") {
      const detail = data.debug_message || data.display_message || JSON.stringify(data).slice(0, 400);
      throw new Error(`Snap API ${method} ${path} failed (${res.status}): ${detail}`);
    }
    return data;
  }

  // Unwrap Snap's {campaigns:[{sub_request_status, campaign:{...}}]} envelope.
  static unwrap(data, entity) {
    const e = ENTITIES[entity];
    const rows = data[e.plural] ?? [];
    return rows.map((r) => {
      if (r.sub_request_status && r.sub_request_status !== "SUCCESS") {
        throw new Error(`Snap returned ${r.sub_request_status}: ${r.error_message || r.debug_message || r.sub_request_error_reason || ""}`);
      }
      return r[e.singular];
    });
  }

  // multipart/form-data upload (used for media files). The boundary header is set by fetch.
  // `path` is relative to /v1, unless `absolute` is true (Snap returns some chunk paths like /us/v1/... relative to the host).
  async upload(path, formData, { absolute = false } = {}) {
    const token = await this.accessToken();
    const url = absolute ? "https://adsapi.snapchat.com" + path : API + path;
    const res = await this.fetchRetry(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.request_status === "ERROR") {
      throw new Error(`Snap API POST ${path} failed (${res.status}): ${data.debug_message || data.display_message || JSON.stringify(data).slice(0, 300)}`);
    }
    return data;
  }

  async getEntity(entity, id, query) {
    const data = await this.request("GET", ENTITIES[entity].getPath(id), { query });
    const [obj] = SnapClient.unwrap(data, entity);
    if (!obj) throw new Error(`${entity} ${id} not found`);
    return obj;
  }

  async createEntity(entity, obj) {
    const e = ENTITIES[entity];
    const data = await this.request("POST", e.createPath(obj), { body: { [e.plural]: [sanitizeForCreate(obj)] } });
    const [created] = SnapClient.unwrap(data, entity);
    if (!created?.id) throw new Error(`Snap did not return an id for the new ${entity}`);
    return created;
  }

  async listChildren(parentEntity, parentId, childEntity, extraQuery = {}) {
    const path = `/${ENTITIES[parentEntity].plural}/${parentId}/${ENTITIES[childEntity].plural}`;
    const data = await this.request("GET", path, { query: { limit: 500, ...extraQuery } });
    return SnapClient.unwrap(data, childEntity);
  }

  async updateEntity(entity, obj) {
    const e = ENTITIES[entity];
    const data = await this.request("PUT", e.updatePath(obj), { body: { [e.plural]: [sanitizeForUpdate(obj)] } });
    const [updated] = SnapClient.unwrap(data, entity);
    return updated;
  }
}
