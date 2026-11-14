// Connecting an ad account: the authorization link, reading the code back, exchanging it for a refresh token, and listing the
// ad accounts the login can see. Shared by the `setup` command and the in-chat snap_connect tools.
import { randomBytes } from "node:crypto";

export const AUTHORIZE_URL = "https://accounts.snapchat.com/login/oauth2/authorize";
export const TOKEN_URL = "https://accounts.snapchat.com/login/oauth2/access_token";
export const DEFAULT_REDIRECT = "https://127.0.0.1/callback";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const newState = () => `ads-mcp-${randomBytes(9).toString("base64url")}`;
export const looksLikeClientId = (text) => UUID.test(String(text).trim());

export function authorizeUrl({ clientId, redirectUri = DEFAULT_REDIRECT, state }) {
  if (!looksLikeClientId(clientId)) throw new Error("The Client ID should look like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (from Business Details > OAuth Apps).");
  const u = new URL(AUTHORIZE_URL);
  u.search = new URLSearchParams({ response_type: "code", client_id: clientId.trim(), redirect_uri: redirectUri, scope: "snapchat-marketing-api", state }).toString();
  return u.toString();
}

// Accepts the whole address the browser landed on (preferred: the state is checked) or just the code.
export function extractCode(input, expectedState) {
  const text = String(input ?? "").trim();
  if (!text) throw new Error("Nothing was pasted. Paste the whole address from the browser's address bar after approving.");
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    const error = url.searchParams.get("error");
    if (error) throw new Error(`Snap refused the authorization: ${url.searchParams.get("error_description") || error}.`);
    const code = url.searchParams.get("code");
    if (!code) throw new Error("That address has no code in it. Approve in the browser first, then copy the address it lands on.");
    const state = url.searchParams.get("state");
    if (expectedState && state !== expectedState) throw new Error("That address belongs to a different authorization attempt. Use the newest link.");
    return code;
  }
  if (!/^[A-Za-z0-9._~+\/=-]{10,}$/.test(text)) throw new Error("That does not look like a code. Paste the whole address from the browser instead.");
  return text;
}

export async function exchangeCode({ clientId, clientSecret, redirectUri = DEFAULT_REDIRECT, code, fetchImpl = fetch }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    const why = data.error_description || data.error || "no detail";
    const hint = /client/i.test(why) ? " Check that the Client ID and secret come from the same OAuth app." : " The code is single-use and expires after a few minutes: open the link again and paste the new address.";
    throw new Error(`Snap did not accept the code (${res.status}: ${why}).${hint}`);
  }
  return data.refresh_token;
}

// Every ad account the authorized login can see, across its organizations.
export async function listAdAccounts(client) {
  const data = await client.request("GET", "/me/organizations", { query: { with_ad_accounts: "true" } });
  const rows = [];
  for (const wrap of data.organizations ?? []) {
    const org = wrap.organization ?? wrap;
    for (const a of org.ad_accounts ?? []) rows.push({ id: a.id, name: a.name, status: a.status, currency: a.currency, organization: org.name });
  }
  return rows.sort((x, y) => String(x.organization).localeCompare(String(y.organization)) || String(x.name).localeCompare(String(y.name)));
}
