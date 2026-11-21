// Thin client for the Snapchat Marketing API (https://adsapi.snapchat.com/v1).
import { brokerUrlFrom, refreshViaBroker } from "./broker.js";
import { fixFor } from "./snap-errors.js";
const API = "https://adsapi.snapchat.com/v1";
const TOKEN_URL = "https://accounts.snapchat.com/login/oauth2/access_token";
const TR = "https://tr.snapchat.com"; // Conversions API test-event tools

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
  creative_element: {
    plural: "creative_elements",
    singular: "creative_element",
    getPath: (id) => `/creative_elements/${id}`,
    createPath: (obj) => `/adaccounts/${obj.ad_account_id}/creative_elements`,
    updatePath: (obj) => `/adaccounts/${obj.ad_account_id}/creative_elements`,
  },
  interaction_zone: {
    plural: "interaction_zones",
    singular: "interaction_zone",
    getPath: (id) => `/interaction_zones/${id}`,
    createPath: (obj) => `/adaccounts/${obj.ad_account_id}/interaction_zones`,
    updatePath: (obj) => `/adaccounts/${obj.ad_account_id}/interaction_zones`,
  },
  product_set: {
    plural: "product_sets",
    singular: "product_set",
    getPath: (id) => `/product_sets/${id}`,
    createPath: (obj) => `/catalogs/${obj.catalog_id}/product_sets`,
    updatePath: () => "/product_sets",
  },
  dynamic_template: {
    plural: "dynamic_templates",
    singular: "dynamic_template",
    getPath: (id) => `/dynamic_templates/${id}`,
    createPath: (obj) => `/adaccounts/${obj.ad_account_id}/dynamic_templates`,
    updatePath: (obj) => `/adaccounts/${obj.ad_account_id}/dynamic_templates`,
  },
  fundingsource: {
    plural: "fundingsources",
    singular: "fundingsource",
    getPath: (id) => `/fundingsources/${id}`,
  },
  catalog: {
    plural: "catalogs",
    singular: "catalog",
    getPath: (id) => `/catalogs/${id}`,
    createPath: (obj) => `/organizations/${obj.organization_id}/catalogs`,
    updatePath: (obj) => `/organizations/${obj.organization_id}/catalogs`,
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
const MAX_LIST_PAGES = 20;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SnapClient {
  constructor({ env = process.env, fetchImpl = fetch, beforeToken, sleep = realSleep, timeoutMs = 60_000, uploadTimeoutMs = 600_000 } = {}) {
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.uploadTimeoutMs = uploadTimeoutMs;
    this.beforeToken = beforeToken;
    this.sleep = sleep;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiry = 0;
  }

  // Calls to Snap's Conversions API host (test-event tools only). Snap's test tools take the token as an `access_token` parameter
  // (an OAuth access token works, or a Conversions API token made in Ads Manager: set SNAP_CAPI_TOKEN to use that one). The token
  // goes to this one fixed host. A 4xx on POST is returned with its body (Snap explains an INVALID test event there); a failed GET throws.
  async requestTr(method, path, { body } = {}) {
    const [pathname, search = ""] = String(path).split("?");
    const url = new URL(TR + pathname);
    if (url.hostname !== "tr.snapchat.com") throw new Error("refusing to send the token to another host");
    url.search = search;
    const own = this.env.SNAP_CAPI_TOKEN || null;
    const send = async () => {
      const token = own ?? (await this.accessToken());
      url.searchParams.set("access_token", token);
      return this.fetchRetry(url, { method, headers: { ...(own ? {} : { Authorization: `Bearer ${token}` }), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    };
    let res = await send();
    if (res.status === 401 && !own) {
      this.token = null;
      this.tokenExpiry = 0;
      res = await send();
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Snap refused the token for the Conversions API test tools (${res.status}: ${String(data.reason ?? data.detail ?? "Invalid access token").slice(0, 120)}). ${own ? "Check SNAP_CAPI_TOKEN." : "Create a Conversions API token in Ads Manager (Events Manager > Conversions API > Generate token) and set SNAP_CAPI_TOKEN in your settings."}`);
    }
    if (method === "GET" && !res.ok) throw new Error(`Snap Conversions API ${method} ${pathname} failed (${res.status}): ${String(data.reason ?? data.debug_message ?? "").slice(0, 300)}`);
    return { status: res.status, data };
  }

  // Reads (and the token call) retry on 429/5xx and network errors. Writes retry ONLY on 429, which Snap sends before
  // processing, so a create/claim is never repeated by accident.
  async fetchRetry(url, opts = {}, { timeoutMs = this.timeoutMs } = {}) {
    const method = (opts.method ?? "GET").toUpperCase();
    const safe = method === "GET" || String(url).includes("access_token");
    let last;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Every request has a deadline, so a stalled connection can never hang a tool call forever.
        const res = await this.fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
        const retryable = safe ? RETRY_STATUSES.includes(res.status) : res.status === 429;
        if (!retryable || attempt === MAX_ATTEMPTS) return res;
        const ra = Number(res.headers?.get?.("retry-after"));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : Math.min(500 * 2 ** (attempt - 1), 8000));
      } catch (e) {
        last = e;
        if (!safe) {
          // A write that failed in transit may or may not have reached Snap. It is never re-sent automatically.
          const why = e?.name === "TimeoutError" ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `failed in transit (${e?.message ?? e})`;
          throw new Error(`Snap API ${method} request ${why}. OUTCOME UNKNOWN: it may or may not have been applied. Read the item back before trying again.`);
        }
        if (attempt === MAX_ATTEMPTS) throw e;
        await this.sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
      }
    }
    throw last;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiry - 60_000) return this.token;
    this.beforeToken?.();
    const { SNAP_CLIENT_ID, SNAP_CLIENT_SECRET, SNAP_REFRESH_TOKEN } = this.env;
    // Shared login: no app secret on this computer; the login service holds it and swaps the refresh token.
    if (SNAP_REFRESH_TOKEN && !SNAP_CLIENT_SECRET) {
      const broker = brokerUrlFrom(this.env);
      if (broker) {
        const data = await refreshViaBroker(broker, SNAP_REFRESH_TOKEN, this.fetch);
        this.token = data.access_token;
        this.tokenExpiry = Date.now() + (data.expires_in ?? 1800) * 1000;
        return this.token;
      }
    }
    if (!SNAP_CLIENT_ID || !SNAP_CLIENT_SECRET || !SNAP_REFRESH_TOKEN) {
      throw new Error("Missing SNAP_CLIENT_ID, SNAP_CLIENT_SECRET or SNAP_REFRESH_TOKEN. Run `npx -y ads-mcp-for-snapchat setup` (see .env.example).");
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
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const send = async () =>
      this.fetchRetry(url, {
        method,
        headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    let res = await send();
    if (res.status === 401) {
      // The access token was refused (revoked or expired early). A 401 means the request was not processed, so it is safe to
      // get a new token and send it once more, writes included. If the refresh token is bad, accessToken() says so.
      this.token = null;
      this.tokenExpiry = 0;
      res = await send();
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.request_status === "ERROR") {
      const detail = data.debug_message || data.display_message || JSON.stringify(data).slice(0, 400);
      throw new Error(`Snap API ${method} ${path} failed (${res.status}): ${detail} ${fixFor(res.status, { retryAfter: Number(res.headers?.get?.("retry-after")) })}`.trim());
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
    // Chunk paths come from an API response: they must stay on the API host, or the bearer token would go elsewhere.
    if (absolute && (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))) throw new Error("Upload path returned by Snap is not a plain path; refusing to send credentials to it.");
    const url = new URL(absolute ? "https://adsapi.snapchat.com" + path : API + path);
    if (url.origin !== "https://adsapi.snapchat.com") throw new Error("Upload URL is not on adsapi.snapchat.com; refusing to send credentials to it.");
    const send = async (bearer) => this.fetchRetry(url, { method: "POST", headers: { Authorization: `Bearer ${bearer}` }, body: formData }, { timeoutMs: this.uploadTimeoutMs });
    let res = await send(token);
    if (res.status === 401) {
      // Same as request(): a 401 was not processed, so one fresh token and one repeat are safe.
      this.token = null;
      this.tokenExpiry = 0;
      res = await send(await this.accessToken());
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.request_status === "ERROR") {
      throw new Error(`Snap API POST ${path} failed (${res.status}): ${data.debug_message || data.display_message || JSON.stringify(data).slice(0, 300)} ${fixFor(res.status, { retryAfter: Number(res.headers?.get?.("retry-after")) })}`.trim());
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

  // Reads a list endpoint page by page. Returns { items, complete }. `complete` is false when the page limit was reached or a
  // next-page link could not be followed; callers that need the whole list (safety checks) must treat that as an error.
  async listPaged(path, entity, { query = {}, maxPages = MAX_LIST_PAGES } = {}) {
    const items = [];
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const data = await this.request("GET", path, { query: { limit: 500, ...query, cursor } });
      items.push(...SnapClient.unwrap(data, entity));
      const next = data.paging?.next_link;
      if (!next) return { items, complete: true };
      let nextCursor = null;
      try {
        nextCursor = new URL(next).searchParams.get("cursor");
      } catch {
        nextCursor = null;
      }
      if (!nextCursor || nextCursor === cursor) return { items, complete: false, reason: "a next page could not be followed" };
      cursor = nextCursor;
    }
    return { items, complete: false, reason: `more than ${maxPages * 500} items` };
  }

  async listChildren(parentEntity, parentId, childEntity, extraQuery = {}) {
    // Safety checks (active children, budgets that would start) rely on this list being complete,
    // so an incomplete list is an error rather than a silent cut.
    const path = `/${ENTITIES[parentEntity].plural}/${parentId}/${ENTITIES[childEntity].plural}`;
    const { items, complete, reason } = await this.listPaged(path, childEntity, { query: extraQuery });
    if (!complete) throw new Error(`${path}: ${reason}; refusing to work on an incomplete list.`);
    return items;
  }

  async updateEntity(entity, obj) {
    const e = ENTITIES[entity];
    const data = await this.request("PUT", e.updatePath(obj), { body: { [e.plural]: [sanitizeForUpdate(obj)] } });
    const [updated] = SnapClient.unwrap(data, entity);
    return updated;
  }
}
