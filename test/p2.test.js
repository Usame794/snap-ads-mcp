// Remaining audit items: deleting an audience that is in use, local-file disclosure, and the read allow-list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planDelete } from "../src/delete.js";
import { readIdentifiers } from "../src/customer-list.js";
import { checkReadPath } from "../src/readers.js";
import { sampleWorld, setup } from "./helpers/harness.js";

const withSegment = (status) => {
  const w = sampleWorld();
  w.adsquads.s1 = { ...w.adsquads.s1, status, targeting: { segments: [{ operation: "EXCLUDE", segment_id: ["111"] }] } };
  return w;
};

test("F-16: an audience targeted by an ACTIVE ad squad cannot be deleted", async () => {
  const t = await setup({ world: withSegment("ACTIVE") });
  const p = (await t.call("snap_delete", { entity: "segment", id: "111", confirm_name: "Buyers" })).data;
  assert.match(p.preview.blocked_because[0], /1 ACTIVE ad squad\(s\) target it \("Squad s1" EXCLUDE\)/);
  assert.equal(p.preview.used_by_ad_squads, 1);
  assert.equal(p.approval_token, undefined, "a blocked delete gets no approval");
  assert.match((await t.call("snap_delete", { entity: "segment", id: "111", confirm_name: "Buyers", confirm: true })).error, /approval_token/);
  assert.equal(t.writes().length, 0);
  assert.ok(t.db.segments[111]);
  await t.close();
});

test("F-16: an audience used only by paused ad squads, or by none, can be deleted, and the preview says who uses it", async () => {
  const paused = await setup({ world: withSegment("PAUSED") });
  const p = (await paused.call("snap_delete", { entity: "segment", id: "111" })).data;
  assert.deepEqual(p.preview.blocked_because, []);
  assert.deepEqual(p.preview.used_by.map((s) => [s.id, s.status, s.operation]), [["s1", "PAUSED", "EXCLUDE"]]);
  assert.match(p.preview.warning, /Paused ad squads still reference/);
  const done = await paused.call("snap_delete", { entity: "segment", id: "111", confirm_name: "Buyers", confirm: true, approval_token: p.approval_token });
  assert.equal(done.data.deleted, true);
  assert.equal(paused.db.segments[111], undefined);
  await paused.close();

  const unused = await setup();
  const q = (await unused.call("snap_delete", { entity: "segment", id: "111" })).data;
  assert.deepEqual([q.preview.used_by_ad_squads, q.preview.warning], [0, undefined]);
  await unused.close();
});

test("F-16: if the account's ad squads cannot all be read, the audience is not deleted", async () => {
  const seg = { id: "9", name: "Aud", ad_account_id: "acc" };
  const client = (adsquads) => ({ getEntity: async () => seg, request: async () => adsquads });
  await assert.rejects(() => planDelete(client({ adsquads: [], paging: { next_link: "https://adsapi.snapchat.com/v1/x?cursor=same" } }), { entity: "segment", id: "9" }), /Could not read every ad squad|refusing/);
  await assert.rejects(() => planDelete({ getEntity: async () => ({ id: "9", name: "Aud" }), request: async () => ({ adsquads: [] }) }, { entity: "segment", id: "9" }), /Cannot tell which ad account/);
  // numeric and string ids match each other, include and exclude both count
  const plan = await planDelete(client({ adsquads: [{ adsquad: { id: "a", name: "A", status: "ACTIVE", targeting: { segments: [{ segment_id: [9] }] } } }, { adsquad: { id: "b", name: "B", status: "ACTIVE", targeting: { segments: [{ operation: "EXCLUDE", segment_id: ["8"] }] } } }] }), { entity: "segment", id: "9" });
  assert.deepEqual(plan.summary.used_by.map((s) => [s.id, s.operation]), [["a", "INCLUDE"]]);
  assert.equal(plan.blockers.length, 1);
});

test("F-17: the customer-list tool reads spreadsheet exports only and never echoes file contents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p2-"));
  const secret = join(dir, ".env");
  writeFileSync(secret, "SNAP_CLIENT_SECRET=AbC123xyz,token=XyZ\nline2\n");
  assert.throws(() => readIdentifiers(secret, { kind: "email" }), (e) => /must be a \.csv/.test(e.message) && !/abc123|snap_client_secret/i.test(e.message));
  for (const p of ["/etc/passwd", join(dir, "id_rsa"), join(dir, "notes.md")]) assert.throws(() => readIdentifiers(p, { kind: "email" }), /must be a \.csv/);
  // a .csv whose first line holds values instead of headers: the hint hides them
  const odd = join(dir, "odd.csv");
  writeFileSync(odd, "someone@example.com,key=value123,0501234567,Customer Name\nrow2,a,b,c\n");
  assert.throws(() => readIdentifiers(odd, { kind: "phone", column: "missing" }), (e) => /Columns are: \(hidden\), \(hidden\), \(hidden\), customer name/.test(e.message));
  // normal use is unchanged
  const ok = join(dir, "list.CSV");
  writeFileSync(ok, "Name,Email\nA,a@example.com\nB,A@Example.com \nC,not-an-email\n");
  const r = readIdentifiers(ok, { kind: "email" });
  assert.deepEqual([r.column, r.rows, r.valid, r.invalid, r.duplicates], ["email", 3, 1, 1, 1]);
  assert.match(r.hashes[0], /^[0-9a-f]{64}$/);

  const t = await setup();
  assert.match((await t.call("snap_upload_customer_list", { file_path: secret, kind: "email", name: "Customers" })).error, /must be a \.csv/);
  await t.close();
});

test("F-19: /me is one endpoint, not a prefix", () => {
  assert.equal(checkReadPath("/me"), "/me");
  for (const p of ["/merchants/anything", "/me/x", "/meta", "/metrics/x"]) assert.throws(() => checkReadPath(p), /path not allowed/, p);
  for (const p of ["/media/m1", "/members/x", "/adaccounts/a/campaigns", "/targeting/v1/geo/sa/region"]) assert.equal(checkReadPath(p), p);
  for (const p of ["/adaccounts/../me", "/adaccounts//x", "/adaccounts/a?x=1", "adaccounts/a", 5]) assert.throws(() => checkReadPath(p));
});
