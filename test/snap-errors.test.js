import test from "node:test";
import assert from "node:assert/strict";
import { fixFor } from "../src/snap-errors.js";
import { SnapClient } from "../src/snap.js";

test("each common Snap status gets a fix", () => {
  assert.match(fixFor(401), /setup/);
  assert.match(fixFor(403), /Admin/);
  assert.match(fixFor(404), /snap_list_/);
  assert.match(fixFor(429, { retryAfter: 12 }), /about 12 seconds/);
  assert.match(fixFor(429), /a minute/);
  assert.match(fixFor(503), /Snap had a problem/);
  assert.match(fixFor(400), /preview/);
  assert.equal(fixFor(200), "");
});

test("a failed request keeps Snap's own message and adds the fix", async () => {
  const res = { ok: false, status: 404, json: async () => ({ request_status: "ERROR", debug_message: "no such campaign" }), headers: { get: () => null } };
  const client = new SnapClient({ env: { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" }, fetchImpl: async (url) => (String(url).includes("accounts") ? { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 1800 }), headers: { get: () => null } } : res), sleep: async () => {} });
  await assert.rejects(client.request("GET", "/campaigns/x"), (e) => /no such campaign/.test(e.message) && /snap_list_/.test(e.message) && !/at .*\.js/.test(e.message));
});
