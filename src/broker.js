// The computer's side of the shared login: where the login service is, how to start a login (a tiny listener on this computer
// only), and how to swap a refresh token for an access token through the service. The refresh token never travels in the clear
// after the login: the service seals it to a key made here, for this one login.
import { createServer } from "node:http";
import { randomBytes, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.js";
import { generateKeyPair, open, toB64u } from "./hybrid.js";

// The address of the login service people use by default. Empty until the maintainer deploys one and sets "adsMcpBroker" in
// package.json. SNAP_BROKER_URL overrides it (for example to run your own copy of the service).
function packageDefault() {
  try {
    return String(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).adsMcpBroker ?? "");
  } catch {
    return "";
  }
}

// Returns the service's origin, or null when none is set. Only https, or a loopback address for local testing. A refresh token is
// sent to this address, so a plain http address to anything else is refused.
export function brokerUrlFrom(env = process.env, fallback = packageDefault()) {
  const raw = String(env.SNAP_BROKER_URL ?? "").trim() || String(fallback ?? "").trim();
  if (!raw || /^(off|none|no)$/i.test(raw)) return null; // SNAP_BROKER_URL=off turns the shared login off
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("SNAP_BROKER_URL is not a valid address");
  }
  const loopback = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (u.protocol !== "https:" && !loopback) throw new Error("SNAP_BROKER_URL must start with https:// (a refresh token is sent there)");
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) throw new Error("SNAP_BROKER_URL must be just the address, like https://login.example.com");
  return u.origin;
}

const DONE_PAGE = (ok) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ads MCP for Snapchat</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem">${
    ok ? "<h1>Connected</h1><p>Your Snapchat login was received by Ads MCP for Snapchat. You can close this tab and go back to the terminal or to Claude.</p>" : "<h1>Could not finish</h1><p>This link did not work. Go back and start the login again.</p>"
  }</body></html>`;

// Starts a login. Returns { url, done, close }: open `url` in a browser; `done` resolves with the refresh token.
// The listener accepts only this login's one callback, only for the loopback address, and closes itself afterwards.
export async function startBrokerLogin({ brokerUrl, timeoutMs = 5 * 60_000, crypto = webcrypto } = {}) {
  if (!brokerUrl) throw new Error("No login service address is set");
  const keys = await generateKeyPair(crypto);
  const nonce = toB64u(randomBytes(18));
  let finish;
  let fail;
  const done = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  let settled = false;
  const server = createServer(async (req, res) => {
    const reply = (status, ok) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(DONE_PAGE(ok));
    };
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      // Host check: a web page cannot reach this listener through a name that points at 127.0.0.1 (DNS rebinding).
      if (req.method !== "GET" || u.pathname !== "/callback" || req.headers.host !== `127.0.0.1:${server.address().port}`) return reply(404, false);
      const q = u.searchParams;
      if (settled || q.get("nonce") !== nonce) return reply(400, false);
      const token = await open(keys.privateKey, { v: 1, epk: q.get("epk"), salt: q.get("salt"), iv: q.get("iv"), ct: q.get("ct") }, nonce, crypto);
      // A refresh token is one run of letters, digits and . _ ~ + / = -. Anything else (a line break, a space) is not a token and must
      // never reach the settings file, even if it was sealed to this login's key (anyone who saw the login link can do that).
      if (typeof token !== "string" || !/^[A-Za-z0-9._~+/=-]{10,4096}$/.test(token)) return reply(400, false);
      settled = true;
      reply(200, true);
      clear();
      finish(token);
    } catch {
      reply(400, false);
    }
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      clear();
      fail(new Error("The login was not completed in time. Start again."));
    }
  }, timeoutMs);
  timer.unref?.();
  const clear = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  };
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const url = new URL(`${brokerUrl}/login`);
  url.search = new URLSearchParams({ port: String(port), pk: keys.publicKey, nonce }).toString();
  return { url: url.toString(), port, done, close: () => { if (!settled) { settled = true; clear(); fail(new Error("cancelled")); } } };
}

// Swaps the refresh token for an access token through the login service (which holds the app's secret).
export async function refreshViaBroker(brokerUrl, refreshToken, fetchImpl = fetch, timeoutMs = 30_000) {
  const res = await fetchImpl(`${brokerUrl}/v1/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: refreshToken }), signal: AbortSignal.timeout(timeoutMs) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const why = data.reason || data.error || `status ${res.status}`;
    throw new Error(`Snap login service refused the token refresh (${res.status}: ${String(why).slice(0, 200)})${res.status === 401 ? ". The login may have been revoked or expired: run setup again." : ""}`);
  }
  return data;
}
