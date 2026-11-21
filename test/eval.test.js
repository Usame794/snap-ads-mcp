// Runs the read-only evaluation questions in test/eval/questions.json against the fake Snap. A question passes when the tool an
// assistant should pick returns the known answer. Nothing here can reach the network or change anything.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setup } from "./helpers/harness.js";

const { questions } = JSON.parse(readFileSync(new URL("./eval/questions.json", import.meta.url), "utf8"));
const pick = (value, path) => path.split(/\.|(?=\[)/).filter(Boolean).reduce((v, step) => (step === "length" ? v.length : step.startsWith("[") ? v[Number(step.slice(1, -1))] : v?.[step]), value);

test("there are at least ten evaluation questions, all read-only tools", async () => {
  assert.ok(questions.length >= 10);
  const t = await setup();
  const { tools } = await t.client.listTools();
  for (const q of questions) assert.equal(tools.find((x) => x.name === q.tool)?.annotations?.readOnlyHint, true, `${q.tool} is read-only`);
});

for (const q of questions) {
  test(`eval: ${q.q}`, async () => {
    const t = await setup();
    const r = await t.raw(q.tool, q.args);
    assert.ok(!r.isError, r.content?.[0]?.text);
    const data = JSON.parse(r.content[0].text);
    for (const e of q.expect) assert.deepEqual(pick(data, e.path), e.equals, `${q.tool} ${e.path}`);
  });
}
