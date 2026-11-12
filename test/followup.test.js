// Follow-ups: regional targeting kept when countries change, one re-authentication on 401, cross-platform clipboard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planTargeting } from "../src/changes.js";
import { SnapClient } from "../src/snap.js";
import { clearClipboard, readClipboard, secretProblems } from "../src/clipboard.js";
import { setup } from "./helpers/harness.js";

const region = { country_code: "sa", region_id: ["1234"], operation: "INCLUDE" };

test("changing countries keeps the regional geo entries of countries that stay", () => {
  const cur = { targeting: { geos: [region, { country_code: "ae" }] } };
  const add = planTargeting(cur, { countries: ["sa", "ae", "kw"] });
  assert.deepEqual(add.patch.targeting.geos, [region, { country_code: "ae" }, { country_code: "kw" }]);
  assert.match(add.summary, /countries sa,ae,kw \(kept 1 regional\/detailed geo entry\)/);
  const drop = planTargeting(cur, { countries: ["sa"] });
  assert.deepEqual(drop.patch.targeting.geos, [region], "ae is removed, the region of sa stays");
  const swap = planTargeting(cur, { countries: ["kw"] });
  assert.deepEqual(swap.patch.targeting.geos, [{ country_code: "kw" }], "regions of a removed country go with it");
  assert.doesNotMatch(swap.summary, /kept/);
  assert.deepEqual(planTargeting({ targeting: {} }, { countries: ["SA"] }).patch.targeting.geos, [{ country_code: "sa" }]);
  assert.deepEqual(planTargeting({}, { countries: ["sa"] }).patch.targeting.geos, [{ country_code: "sa" }]);
  // a malformed existing entry is dropped rather than crashing
  assert.deepEqual(planTargeting({ targeting: { geos: [null, {}, { country_code: "sa" }] } }, { countries: ["sa"] }).patch.targeting.geos, [{ country_code: "sa" }]);
  assert.throws(() => planTargeting(cur, { countries: ["saudi"] }), /2-letter/);
});

test("the original input is not modified by the planner", () => {
  const cur = { targeting: { geos: [region] } };
  const before = JSON.stringify(cur);
  planTargeting(cur, { countries: ["sa", "ae"] });
  assert.equal(JSON.stringify(cur), before);
});

const env = { SNAP_CLIENT_ID: "i", SNAP_CLIENT_SECRET: "s", SNAP_REFRESH_TOKEN: "r" };
const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b, headers: { get: () => null } });

function authFake({ rejectFirst = 1, refreshFails = false } = {}) {
  const seen = { tokens: [], apiCalls: [], refreshes: 0 };
  let n = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes("accounts.snapchat.com")) {
      seen.refreshes++;
      return refreshFails && seen.refreshes > 1 ? json({ error: "invalid_grant", error_description: "refresh token revoked" }, 400) : json({ access_token: `tok${seen.refreshes}`, expires_in: 1800 });
    }
    seen.apiCalls.push(`${opts.method ?? "GET"}`);
    seen.tokens.push(opts.headers.Authorization);
    return ++n <= rejectFirst ? json({ request_status: "ERROR", debug_message: "Unauthorized" }, 401) : json({ request_status: "SUCCESS", campaigns: [{ sub_request_status: "SUCCESS", campaign: { id: "c" } }] });
  };
  return { seen, client: new SnapClient({ env, fetchImpl, sleep: async () => {} }) };
}

test("a refused access token is replaced once and the request is repeated, reads and writes alike", async () => {
  const read = authFake();
  assert.equal((await read.client.getEntity("campaign", "c")).id, "c");
  assert.deepEqual(read.seen.tokens, ["Bearer tok1", "Bearer tok2"]);
  assert.equal(read.seen.refreshes, 2);

  const write = authFake();
  await write.client.request("PUT", "/adaccounts/a/campaigns", { body: { campaigns: [{ id: "c" }] } });
  assert.deepEqual(write.seen.apiCalls, ["PUT", "PUT"], "a 401 means the first PUT was not processed, so it is sent once more");
  assert.deepEqual(write.seen.tokens, ["Bearer tok1", "Bearer tok2"]);
});

test("a second 401 is an error, never a loop; a failed refresh says why", async () => {
  const twice = authFake({ rejectFirst: 2 });
  await assert.rejects(() => twice.client.request("GET", "/me"), /failed \(401\).*Unauthorized/);
  assert.equal(twice.seen.apiCalls.length, 2, "exactly one repeat");

  const bad = authFake({ refreshFails: true });
  await assert.rejects(() => bad.client.request("GET", "/me"), /token refresh failed \(400\).*refresh token revoked/);
  assert.equal(bad.seen.apiCalls.length, 1, "nothing is sent without a valid token");
});

test("a normal request does not refresh again", async () => {
  const ok = authFake({ rejectFirst: 0 });
  await ok.client.request("GET", "/me");
  await ok.client.request("GET", "/me");
  assert.equal(ok.seen.refreshes, 1);
});

test("through the tools: a token refused during the write is replaced, the write lands once, and the approval is intact", async () => {
  const t = await setup();
  const args = { entity: "adsquad", id: "s1", new_name: "Squad one renamed" };
  const p = (await t.call("snap_rename", args)).data;
  t.hooks.reject401 = "PUT"; // the first PUT is answered with 401
  const done = await t.call("snap_rename", { ...args, confirm: true, approval_token: p.approval_token });
  assert.equal(done.data?.applied, true, done.error);
  assert.equal(done.data.verified, true);
  const puts = t.writes().filter((c) => c.method === "PUT");
  assert.equal(puts.length, 2, "the rejected PUT and its repeat");
  assert.equal(t.db.adsquads.s1.name, "Squad one renamed");
  assert.deepEqual(t.log().filter((e) => e.phase).map((e) => e.phase), ["intent", "result"], "one audit pair, not two");
  await t.close();
});

test("clipboard: uses the first tool that works on each platform, reports none, and never throws", () => {
  const calls = [];
  const exec = (cmd) => {
    calls.push(cmd);
    if (cmd === "wl-paste" || cmd === "xclip") throw new Error("not installed");
    return "  the-secret-value-0123456789 \n";
  };
  assert.equal(readClipboard({ platform: "linux", exec }), "the-secret-value-0123456789");
  assert.deepEqual(calls, ["wl-paste", "xclip", "xsel"]);
  assert.equal(readClipboard({ platform: "darwin", exec: () => "mac-text\n" }), "mac-text");
  assert.equal(readClipboard({ platform: "win32", exec: () => "win-text\r\n" }), "win-text");
  assert.equal(readClipboard({ platform: "linux", exec: () => { throw new Error("none"); } }), null);
  assert.equal(readClipboard({ platform: "freebsd", exec }), null);
  assert.equal(clearClipboard({ platform: "darwin", exec: () => "" }), true);
  assert.equal(clearClipboard({ platform: "linux", exec: () => { throw new Error("none"); } }), false);
});

test("a secret must look like a secret before it is saved", () => {
  assert.deepEqual(secretProblems("abcDEF0123456789abcdef-_.~+/="), []);
  assert.match(secretProblems("short")[0], /too short/);
  assert.match(secretProblems("has a space in it 012345678901234567")[0], /spaces/);
  assert.match(secretProblems("not-a-secret-because-of-$$$$$$$$$$$$")[0], /characters/);
  assert.match(secretProblems("line1\nline2-0123456789012345678901")[0], /spaces or line breaks/);
});
