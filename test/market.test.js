// Market settings: no hidden Saudi defaults. Country, phone code and report offset are explicit, validated settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../src/policy.js";
import { setup } from "./helpers/harness.js";

test("market settings default to none / UTC, accept valid values, reject malformed ones", () => {
  const d = loadPolicy({});
  assert.deepEqual([d.defaultCountry, d.defaultPhoneCode, d.reportUtcOffset], [null, null, "+00:00"]);
  const p = loadPolicy({ SNAP_DEFAULT_COUNTRY: " US ", SNAP_DEFAULT_PHONE_CODE: "44", SNAP_REPORT_UTC_OFFSET: "-05:30" });
  assert.deepEqual([p.defaultCountry, p.defaultPhoneCode, p.reportUtcOffset], ["us", "44", "-05:30"]);
  for (const env of [{ SNAP_DEFAULT_COUNTRY: "usa" }, { SNAP_DEFAULT_COUNTRY: "u1" }, { SNAP_DEFAULT_PHONE_CODE: "+44" }, { SNAP_DEFAULT_PHONE_CODE: "0044" }, { SNAP_DEFAULT_PHONE_CODE: "12345" }, { SNAP_REPORT_UTC_OFFSET: "3" }, { SNAP_REPORT_UTC_OFFSET: "+25:00" }, { SNAP_REPORT_UTC_OFFSET: "UTC+3" }]) {
    assert.throws(() => loadPolicy(env), /Unsafe configuration/, JSON.stringify(env));
  }
});

test("without SNAP_DEFAULT_COUNTRY a new ad squad or lookalike must name its countries; nothing is guessed", async () => {
  const t = await setup({ env: { SNAP_DEFAULT_COUNTRY: "" } });
  const squad = { campaign_id: "c1", name: "New squad", daily_budget: 10, bid: 1 };
  assert.match((await t.call("snap_create_adsquad", squad)).error, /countries is required/);
  assert.match((await t.call("snap_create_lookalike", { seed_segment_id: "111", name: "Lookalike buyers" })).error, /countries is required/);
  assert.match((await t.call("snap_targeting_options", { kind: "interests_lifestyle" })).error, /country is required/);
  const ok = await t.twoStep("snap_create_adsquad", { ...squad, countries: ["gb"] });
  assert.equal(ok.preview.data.would_create.countries[0], "gb");
  assert.equal(ok.applied.data.status, "PAUSED");
  assert.deepEqual(Object.values(t.db.adsquads).find((s) => s.name === "New squad").targeting.geos, [{ country_code: "gb" }]);
  await t.close();
});

test("SNAP_DEFAULT_COUNTRY fills in the countries, and an explicit list always wins", async () => {
  const t = await setup({ env: { SNAP_DEFAULT_COUNTRY: "de" } });
  const squad = { campaign_id: "c1", name: "New squad", daily_budget: 10, bid: 1 };
  assert.deepEqual((await t.call("snap_create_adsquad", squad)).data.would_create.countries, ["de"]);
  assert.deepEqual((await t.call("snap_create_adsquad", { ...squad, countries: ["fr", "es"] })).data.would_create.countries, ["fr", "es"]);
  assert.deepEqual((await t.call("snap_create_lookalike", { seed_segment_id: "111", name: "Lookalike buyers" })).data.would_create.countries, ["DE"]);
  await t.close();
});

test("customer-list phones: no default code means local numbers are not hashed; a configured or passed code is used", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mk-"));
  const csv = join(dir, "phones.csv");
  writeFileSync(csv, "phone\n0555123456\n+447700900123\n");
  const none = await setup({ env: { SNAP_DEFAULT_PHONE_CODE: "" } });
  assert.deepEqual([(await none.call("snap_upload_customer_list", { file_path: csv, kind: "phone", name: "Customers" })).data.would_upload.valid_unique], [1]);
  assert.equal((await none.call("snap_upload_customer_list", { file_path: csv, kind: "phone", name: "Customers", default_country_code: "966" })).data.would_upload.valid_unique, 2);
  await none.close();
  const set = await setup({ env: { SNAP_DEFAULT_PHONE_CODE: "966" } });
  assert.equal((await set.call("snap_upload_customer_list", { file_path: csv, kind: "phone", name: "Customers" })).data.would_upload.valid_unique, 2);
  assert.equal((await set.raw("snap_upload_customer_list", { file_path: csv, kind: "phone", name: "Customers", default_country_code: "+966" })).isError, true, "a code with + is refused");
  await set.close();
});
