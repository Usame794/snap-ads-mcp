// Login service for "Ads MCP for Snapchat": a small, STATELESS Cloudflare Worker. It lets people connect their Snapchat ad
// account with a normal "log in with Snapchat" click, without making their own Snapchat OAuth app. It holds the shared app's
// secret and nothing else: it stores no tokens, no accounts and no logs. See broker/README.md and PRIVACY.md.
//
//   GET  /login?port=&pk=&nonce=   the person's computer starts a login (loopback port, a public key made for this login)
//   GET  /callback?code=&state=    Snapchat sends the person back here; the refresh token is sealed to their key and handed to
//                                  their own computer (http://127.0.0.1:<port>/callback). Nothing is kept.
//   POST /v1/refresh               their computer swaps its refresh token for a short-lived access token (needs the secret)
//
// Settings (Worker secrets and variables): SNAP_CLIENT_ID, SNAP_CLIENT_SECRET, STATE_KEY (random text, 32+ characters).
import { checkPublicKey, fromB64u, seal, toB64u } from "../src/hybrid.js";

const AUTHORIZE = "https://accounts.snapchat.com/login/oauth2/authorize";
const TOKEN = "https://accounts.snapchat.com/login/oauth2/access_token";
const STATE_MINUTES = 10;
const COOKIE = "ads_mcp_login";
const MAX_BODY = 8 * 1024;
const enc = new TextEncoder();

const SECURITY_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };

const page = (title, body, status = 200, extra = {}) =>
  new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}code{background:#f2f2f2;padding:.1rem .3rem;border-radius:4px}</style><body>${body}</body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra } });

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- state: signed, so the service needs no storage ----------

async function hmacKey(env) {
  if (!env.STATE_KEY || String(env.STATE_KEY).length < 32) throw new Error("STATE_KEY is missing or too short");
  return crypto.subtle.importKey("raw", enc.encode(env.STATE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signState(env, payload) {
  const body = toB64u(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body)));
  return `${body}.${toB64u(sig)}`;
}

export async function readState(env, text, now = Date.now()) {
  const [body, sig, extra] = String(text ?? "").split(".");
  if (!body || !sig || extra !== undefined) return null;
  let sigBytes;
  try {
    sigBytes = fromB64u(sig);
  } catch {
    return null;
  }
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(env), sigBytes, enc.encode(body)))) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64u(body)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.e !== "number" || payload.e < now) return null;
  return payload;
}

const validPort = (p) => /^\d{4,5}$/.test(p) && Number(p) >= 1024 && Number(p) <= 65535;
const validNonce = (n) => /^[A-Za-z0-9_-]{16,64}$/.test(n ?? "");
const origin = (request, env) => (env.PUBLIC_URL ? String(env.PUBLIC_URL).replace(/\/+$/, "") : new URL(request.url).origin);
const getCookie = (request, name) => (request.headers.get("Cookie") ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === name)?.[1];

function need(env, ...keys) {
  for (const k of keys) if (!env[k]) throw new Error(`${k} is not set`);
}

// ---------- routes ----------

async function login(request, env) {
  need(env, "SNAP_CLIENT_ID", "SNAP_CLIENT_SECRET", "STATE_KEY");
  const u = new URL(request.url);
  const port = u.searchParams.get("port");
  const pk = u.searchParams.get("pk");
  const nonce = u.searchParams.get("nonce");
  if (!validPort(port) || !checkPublicKey(pk) || !validNonce(nonce)) return page("Cannot start", "<h1>Cannot start the login</h1><p>The link is not valid. Start again from the setup command or the Claude Desktop extension.</p>", 400);
  const state = await signState(env, { p: Number(port), k: pk, n: nonce, e: Date.now() + STATE_MINUTES * 60_000 });
  const auth = new URL(AUTHORIZE);
  auth.search = new URLSearchParams({ response_type: "code", client_id: env.SNAP_CLIENT_ID, redirect_uri: `${origin(request, env)}/callback`, scope: "snapchat-marketing-api", state }).toString();
  return new Response(null, { status: 302, headers: { Location: auth.toString(), "Set-Cookie": `${COOKIE}=${nonce}; Path=/callback; Max-Age=${STATE_MINUTES * 60}; HttpOnly; Secure; SameSite=Lax`, ...SECURITY_HEADERS } });
}

async function callback(request, env, fetchImpl) {
  need(env, "SNAP_CLIENT_ID", "SNAP_CLIENT_SECRET", "STATE_KEY");
  const u = new URL(request.url);
  const clear = { "Set-Cookie": `${COOKIE}=; Path=/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax` };
  const state = await readState(env, u.searchParams.get("state"));
  if (!state || !state.k || !validPort(String(state.p)) || !validNonce(state.n) || getCookie(request, COOKIE) !== state.n) {
    return page("Login expired", "<h1>This login link is not valid any more</h1><p>It may have expired, or it was opened in a different browser. Start again from the setup command.</p>", 400, clear);
  }
  if (u.searchParams.get("error")) return page("Login cancelled", "<h1>Snapchat did not approve the login</h1><p>Nothing was saved. You can close this tab and start again.</p>", 400, clear);
  const code = u.searchParams.get("code");
  if (!code || code.length > 2048) return page("Login failed", "<h1>No code came back from Snapchat</h1><p>Start again.</p>", 400, clear);
  const res = await fetchImpl(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${origin(request, env)}/callback`, client_id: env.SNAP_CLIENT_ID, client_secret: env.SNAP_CLIENT_SECRET }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) return page("Login failed", "<h1>Snapchat did not accept the login</h1><p>The code may have expired. Start again.</p>", 502, clear);
  // The refresh token leaves here sealed to the key the person's own computer made for this login. It is not stored.
  const sealed = await seal(state.k, data.refresh_token, state.n);
  const back = new URL(`http://127.0.0.1:${state.p}/callback`);
  back.search = new URLSearchParams({ nonce: state.n, epk: sealed.epk, salt: sealed.salt, iv: sealed.iv, ct: sealed.ct }).toString();
  return new Response(null, { status: 302, headers: { Location: back.toString(), ...SECURITY_HEADERS, ...clear } });
}

async function refresh(request, env, fetchImpl) {
  need(env, "SNAP_CLIENT_ID", "SNAP_CLIENT_SECRET");
  if (request.method !== "POST") return json({ error: "use POST" }, 405);
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") ?? "")) return json({ error: "send JSON" }, 415);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: "request too large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const token = body?.refresh_token;
  if (typeof token !== "string" || token.length < 10 || token.length > 4096 || /\s/.test(token)) return json({ error: "refresh_token is missing or invalid" }, 400);
  const res = await fetchImpl(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: env.SNAP_CLIENT_ID, client_secret: env.SNAP_CLIENT_SECRET }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // Only Snap's short reason goes back; never the secret or anything we sent.
    const reason = String(data.error_description ?? data.error ?? "refused").slice(0, 200);
    return json({ error: "snapchat_refused", reason }, res.status === 400 || res.status === 401 ? 401 : 502);
  }
  return json({ access_token: data.access_token, expires_in: data.expires_in ?? 1800, ...(data.refresh_token && data.refresh_token !== token ? { refresh_token: data.refresh_token } : {}) });
}

const HOME = `<h1>Ads MCP for Snapchat: login service</h1>
<p>This small service lets you connect your own Snapchat ad account to the open-source tool <a href="https://github.com/Usame794/snapchat-ads-mcp">Ads MCP for Snapchat</a> with a normal "log in with Snapchat" button, so you do not have to create your own Snapchat app.</p>
<p><strong>It stores nothing.</strong> Your access is sealed so that only your own computer can read it. See the <a href="/privacy">privacy page</a>. This is an unofficial project and is not affiliated with Snap Inc.</p>`;

const PRIVACY = `<h1>Privacy</h1>
<p>This login service is part of the open-source tool Ads MCP for Snapchat. The tool itself runs on your computer.</p>
<h2>What this service does</h2>
<ul>
<li>When you log in, it receives a one-time code from Snapchat and exchanges it, using the shared app's secret, for your refresh token.</li>
<li>It immediately <strong>seals</strong> that token to a key that only your computer holds, and sends it to your computer (an address that starts with <code>http://127.0.0.1</code>, which is your own machine).</li>
<li>Later, your computer sends its refresh token to this service to get a short-lived access token, because that step needs the app's secret.</li>
</ul>
<h2>What it does not do</h2>
<ul>
<li>It does <strong>not store</strong> tokens, ad account data, names, emails or IP addresses, and it keeps no database and no logs of its own.</li>
<li>It cannot read your ad account data: your computer talks to Snapchat directly.</li>
<li>It does not sell, share or analyze anything.</li>
</ul>
<h2>Good to know</h2>
<ul>
<li>While a request is being handled the service briefly holds your refresh token in memory, as it must. The hosting provider (Cloudflare) may keep standard request metadata under its own terms.</li>
<li>You can revoke access at any time in Snapchat (Business Manager &gt; Business Details &gt; OAuth Apps / connected apps) and by deleting your settings file.</li>
<li>You can run your own copy of this service with your own Snapchat app: the code is in the <code>broker</code> folder of the repository.</li>
</ul>`;

export default {
  async fetch(request, env, _ctx, fetchImpl = fetch) {
    try {
      const { pathname } = new URL(request.url);
      if (pathname === "/" && request.method === "GET") return page("Ads MCP for Snapchat", HOME);
      if (pathname === "/privacy" && request.method === "GET") return page("Privacy", PRIVACY);
      if (pathname === "/login" && request.method === "GET") return await login(request, env);
      if (pathname === "/callback" && request.method === "GET") return await callback(request, env, fetchImpl);
      if (pathname === "/v1/refresh") return await refresh(request, env, fetchImpl);
      return page("Not found", "<h1>Not found</h1>", 404);
    } catch (e) {
      // A generic answer: the reason may name a setting, never a value, and nothing about the request is logged.
      const setting = /^(\w+) is (missing|not set)/.exec(e?.message ?? "")?.[1];
      return page("Not available", `<h1>The login service is not set up correctly</h1>${setting ? `<p>Missing setting: <code>${esc(setting)}</code></p>` : ""}`, 503);
    }
  },
};
