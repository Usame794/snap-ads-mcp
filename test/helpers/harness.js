// Test harness: an in-memory fake of the Snap Marketing API behind a real SnapClient, wired to the real MCP tools over an
// in-memory transport. Nothing here can reach the network.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SnapClient } from "../../src/snap.js";
import { registerTools } from "../../src/tools.js";

export const ACC = "acc-1";
const KIND = { campaigns: "campaign", adsquads: "adsquad", ads: "ad", creatives: "creative", segments: "segment", media: "media", creative_elements: "creative_element", interaction_zones: "interaction_zone" };
const PARENT_KEY = { adsquads: "campaign_id", ads: "ad_squad_id" };

// world = { campaigns: {id: obj}, adsquads: {...}, ads: {...}, creatives: {...}, segments: {...}, media: {...}, currency }
export function fakeSnap(world = {}) {
  const db = { campaigns: {}, adsquads: {}, ads: {}, creatives: {}, segments: {}, media: {}, creative_elements: {}, interaction_zones: {}, currency: "USD", ...world };
  const calls = [];
  let seq = 0;
  const hooks = { failGetAfterPut: false, failNextWrite: null };
  let putSeen = false;
  const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b, headers: { get: () => null } });
  // Like Snap: `limit` rows per page, and a next_link carrying a cursor (here an offset) while rows remain.
  const paged = (plural, path, u, all) => {
    const limit = Math.min(Number(u.searchParams.get("limit") ?? 50), hooks.pageSize ?? 500);
    const start = Number(u.searchParams.get("cursor") ?? 0);
    if (hooks.reverseLists) all = [...all].reverse();
    const body = wrap(plural, all.slice(start, start + limit));
    if (start + limit < all.length) body.paging = { next_link: hooks.brokenPaging ? "not a url" : `https://adsapi.snapchat.com/v1${path}?limit=${limit}&cursor=${start + limit}` };
    return json(body);
  };
  const wrap = (plural, objs) => ({ request_status: "SUCCESS", [plural]: objs.map((o) => ({ sub_request_status: "SUCCESS", [KIND[plural]]: o })) });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.hostname.includes("accounts")) return json({ access_token: "test-access-token", expires_in: 1800 });
    const method = (opts.method ?? "GET").toUpperCase();
    const path = u.pathname.replace(/^\/v1/, "");
    calls.push({ method, path, query: Object.fromEntries(u.searchParams), body: opts.body && typeof opts.body === "string" ? JSON.parse(opts.body) : undefined });
    const seg = path.split("/").filter(Boolean);
    if (hooks.reject401 && method === hooks.reject401) {
      hooks.reject401 = null; // the access token was refused once, before anything was processed
      return json({ request_status: "ERROR", debug_message: "Unauthorized" }, 401);
    }
    if (method !== "GET" && hooks.failNextWrite) {
      const e = hooks.failNextWrite;
      hooks.failNextWrite = null;
      throw e;
    }
    if (method === "GET") {
      if (hooks.failGetAfterPut && putSeen) return json({ request_status: "ERROR", debug_message: "boom" }, 500);
      if (seg[0] === "adaccounts" && seg.length === 2) return json({ adaccounts: [{ adaccount: { id: seg[1], currency: db.currency, organization_id: "org-1" } }] });
      if (seg[0] === "adaccounts" && seg.length === 3 && db[seg[2]]) return paged(seg[2], path, u, Object.values(db[seg[2]]).filter((o) => (seg[2] === "campaigns" ? o.ad_account_id === seg[1] : true)));
      if (seg[2] === "stats") return json({ total_stats: [{ total_stat: { stats: { spend: (db[seg[0]]?.[seg[1]]?._spend ?? 0) * 1e6 } } }] });
      if (seg.length === 3 && PARENT_KEY[seg[2]]) return paged(seg[2], path, u, Object.values(db[seg[2]]).filter((o) => o[PARENT_KEY[seg[2]]] === seg[1]));
      if (seg.length === 2 && db[seg[0]]) {
        const o = db[seg[0]][seg[1]];
        return o ? json(wrap(seg[0], [o])) : json({ request_status: "ERROR", debug_message: "not found" }, 404);
      }
      if (seg[0] === "me") return json({ me: { display_name: "Tester" } });
      return json({}, 404);
    }
    if (method === "DELETE") {
      delete db[seg[0]]?.[seg[1]];
      return json({ request_status: "SUCCESS" });
    }
    if (path.endsWith("/claim_media_by_ad_code")) {
      const mid = `media-${++seq}`;
      db.media[mid] = { id: mid, ad_account_id: seg[1], media_status: "READY", type: "VIDEO" };
      return json({ request_status: "SUCCESS", media_entity_id: mid });
    }
    if (seg[0] === "media" && seg[2] === "upload") return json({ request_status: "SUCCESS", result: { id: seg[1] } });
    if (seg[0] === "segments" && seg[2] === "users") return json({ request_status: "SUCCESS", users: [{ sub_request_status: "SUCCESS" }] });
    const plural = seg[seg.length - 1];
    const sent = calls[calls.length - 1].body?.[plural]?.[0];
    if (!sent || !db[plural]) return json({ request_status: "ERROR", debug_message: `unsupported ${method} ${path}` }, 400);
    if (method === "PUT") {
      putSeen = true;
      if (!db[plural][sent.id]) return json({ request_status: "ERROR", debug_message: "not found" }, 404);
      db[plural][sent.id] = { ...db[plural][sent.id], ...sent, updated_at: `t${++seq}` };
      return json(wrap(plural, [db[plural][sent.id]]));
    }
    const nid = `${KIND[plural]}-new-${++seq}`;
    db[plural][nid] = { ...sent, id: nid, ...(seg[0] === "adaccounts" ? { ad_account_id: seg[1] } : {}), updated_at: `t${seq}` };
    return json(wrap(plural, [db[plural][nid]]));
  };
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { db, calls, writes, hooks, fetchImpl };
}

// A small account: one ACTIVE campaign with squads, one PAUSED campaign with ACTIVE squads, and a foreign campaign.
export function sampleWorld(extra = {}) {
  const c = (id, o = {}) => ({ id, name: `Campaign ${id}`, status: "ACTIVE", ad_account_id: ACC, updated_at: "t0", ...o });
  const s = (id, campaign_id, budget, o = {}) => ({ id, name: `Squad ${id}`, status: "ACTIVE", campaign_id, daily_budget_micro: budget * 1e6, bid_micro: 2e6, targeting: { geos: [{ country_code: "sa" }] }, updated_at: "t0", ...o });
  const a = (id, ad_squad_id, o = {}) => ({ id, name: `Ad ${id}`, status: "ACTIVE", ad_squad_id, creative_id: "cr1", type: "REMOTE_WEBPAGE", updated_at: "t0", ...o });
  return {
    campaigns: { c1: c("c1"), c2: c("c2", { status: "PAUSED" }), cx: c("cx", { ad_account_id: "acc-OTHER" }) },
    adsquads: { s1: s("s1", "c1", 10), s2: s("s2", "c1", 100, { status: "PAUSED" }), s3: s("s3", "c2", 30), s4: s("s4", "c2", 50), s5: s("s5", "c2", 70, { status: "PAUSED" }), sx: s("sx", "cx", 10) },
    ads: { a1: a("a1", "s1"), a2: a("a2", "s2", { status: "PAUSED" }) },
    creatives: { cr1: { id: "cr1", name: "Creative one", type: "WEB_VIEW", ad_account_id: ACC, headline: "Hi", web_view_properties: { url: "https://example.com/" } } },
    segments: { 111: { id: "111", name: "Buyers", ad_account_id: ACC, source_type: "FIRST_PARTY" } },
    media: { m1: { id: "m1", ad_account_id: ACC, media_status: "READY", type: "VIDEO" }, sq1: { id: "sq1", ad_account_id: ACC, media_status: "READY", type: "IMAGE", image_metadata: { width: 600, height: 600 } } },
    ...extra,
  };
}

export async function setup({ world = sampleWorld(), env = {}, elicit } = {}) {
  const snap = fakeSnap(world);
  const dir = mkdtempSync(join(tmpdir(), "snap-safety-"));
  const logFile = env.SNAP_LOG_FILE ?? join(dir, "changes.log.jsonl");
  const fullEnv = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r", SNAP_AD_ACCOUNT_ID: ACC, SNAP_BRAND_PROFILE_ID: "prof-1", SNAP_PIXEL_ID: "pix-1", SNAP_DEFAULT_COUNTRY: "sa", SNAP_DEFAULT_PHONE_CODE: "966", SNAP_LOG_FILE: logFile, ...env };
  const server = new McpServer({ name: "t", version: "1" });
  registerTools(server, new SnapClient({ env: fullEnv, fetchImpl: snap.fetchImpl, sleep: async () => {} }), fullEnv);
  const client = new Client({ name: "c", version: "1" }, elicit ? { capabilities: { elicitation: { form: {} } } } : undefined);
  const asked = [];
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params.message);
      return elicit(req.params);
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const raw = (name, args = {}) => client.callTool({ name, arguments: args });
  const parse = (r) => {
    const t = r.content[0].text;
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  };
  // call -> { error?: string, data?: object }
  const call = async (name, args = {}) => {
    const r = await raw(name, args);
    return r.isError ? { error: r.content[0].text } : { data: parse(r) };
  };
  // Preview, then confirm with the token the preview returned.
  const twoStep = async (name, args = {}, confirmArgs = args) => {
    const preview = await call(name, args);
    if (preview.error || !preview.data.approval_token) return { preview, applied: { error: preview.error ?? "no approval_token in preview" } };
    const applied = await call(name, { ...confirmArgs, confirm: true, approval_token: preview.data.approval_token });
    return { preview, applied };
  };
  const log = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { ...snap, client, raw, call, twoStep, log, logFile, dir, asked, env: fullEnv, close: () => client.close() };
}
