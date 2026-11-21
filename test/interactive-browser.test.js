// The interactive cards added in 0.10.0, run in a real browser inside a fake chat app that speaks the MCP Apps protocol. The fake app answers
// ui/initialize, sends the tool's input and result, and forwards the card's tools/call requests to the real MCP server (with the
// fake Snap behind it). Skipped where Playwright is not installed. Screenshots go to SNAP_APPS_SCREENSHOTS when that is set.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setup } from "./helpers/harness.js";
import { pageFor } from "../src/apps.js";
import { dashboardData } from "../src/dashboard.js";
import { statsClient } from "./helpers/stats-client.js";

let pw = null;
try {
  pw = createRequire(import.meta.url)("playwright");
} catch {
  pw = null;
}
const skip = pw ? false : "Playwright is not installed";
const SHOTS = process.env.SNAP_APPS_SCREENSHOTS;

const HOST = `<!doctype html><html><body style="margin:0;background:#888"><iframe id="f" style="width:420px;height:300px;border:0;background:#fff"></iframe>
<script>
const frame = document.getElementById("f");
window.log = [];
const send = (msg) => frame.contentWindow.postMessage(Object.assign({ jsonrpc: "2.0" }, msg), "*");
window.addEventListener("message", async (e) => {
  if (e.source !== frame.contentWindow) return;
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  window.log.push(m.method || "response");
  if (m.method === "ui/initialize") send({ id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "fake", version: "1" }, hostCapabilities: {}, hostContext: { theme: window.cfg.theme, toolInfo: { tool: { name: window.cfg.tool } } } } });
  else if (m.method === "ui/notifications/initialized") { send({ method: "ui/notifications/tool-input", params: { arguments: window.cfg.input } }); send({ method: "ui/notifications/tool-result", params: window.cfg.result }); }
  else if (m.method === "tools/call") { try { send({ id: m.id, result: await window.callTool(m.params.name, m.params.arguments) }); } catch (err) { send({ id: m.id, error: { code: -32000, message: String(err.message) } }); } }
  else if (m.method === "ui/notifications/size-changed") frame.style.height = Math.min(m.params.height, 900) + "px";
});
window.load = (html, cfg) => { window.cfg = cfg; frame.srcdoc = html; };
</script></body></html>`;

let browser;
before(async () => {
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
});

async function open(html, cfg, callTool, name, theme = "light") {
  const page = await browser.newPage({ viewport: { width: 460, height: 800 } });
  await page.exposeFunction("callTool", callTool);
  await page.setContent(HOST);
  await page.evaluate(([h, c]) => window.load(h, c), [html, { theme, ...cfg }]);
  const frame = page.frameLocator("#f");
  const shot = async (label) => SHOTS && (await page.screenshot({ path: join(SHOTS, `${name}-${label}.png`) }));
  return { page, frame, shot };
}


test("board: Resume shows the money that would start before Confirm (audit F4)", { skip }, async () => {
  const t = await setup();
  const result = await t.raw("snap_campaign_board", {});
  const { page, frame, shot } = await open(pageFor("board.html"), { tool: "snap_campaign_board", input: {}, result }, (n, a) => t.raw(n, a), "board-resume");
  await frame.locator(".row", { hasText: "Campaign c2" }).getByRole("button", { name: "Resume" }).click();
  await frame.getByRole("button", { name: "Confirm resume" }).waitFor({ timeout: 15000 });
  const panel = await frame.locator(".panel").innerText();
  assert.match(panel, /Adds 80 per day of spending/);
  assert.match(panel, /Starts delivering\s+80 per day across 2 ad squads/);
  assert.match(panel, /Squad s3/);
  assert.equal(t.writes().length, 0);
  await shot("resume-money");
  await page.close();
});

test("board: ad squad level, -20% / +20% previews the budget and Confirm applies it", { skip }, async () => {
  const t = await setup();
  const result = await t.raw("snap_campaign_board", { level: "adsquads" });
  const { page, frame, shot } = await open(pageFor("board.html"), { tool: "snap_campaign_board", input: { level: "adsquads" }, result }, (n, a) => t.raw(n, a), "board-squads");
  const row = frame.locator(".row", { hasText: "Squad s1" });
  await row.waitFor({ timeout: 15000 });
  await row.getByRole("button", { name: "Raise daily budget 20%" }).click();
  await frame.getByRole("button", { name: "Confirm 12/day" }).waitFor({ timeout: 15000 });
  assert.match(await frame.locator(".panel").innerText(), /Adds 2 per day/);
  await shot("budget-step");
  assert.equal(t.writes().length, 0, "nothing is sent while previewing");
  await frame.getByRole("button", { name: "Confirm 12/day" }).click();
  await frame.getByText(/Daily budget is now 12/).waitFor({ timeout: 15000 });
  assert.equal(t.db.adsquads.s1.daily_budget_micro, 12e6);
  await frame.getByRole("button", { name: "Campaigns", exact: true }).click();
  await frame.locator(".row", { hasText: "Campaign c1" }).waitFor({ timeout: 15000 });
  await page.close();
});

test("preview card: money line first, Cancel sends nothing, Apply then Undo previews and reverts", { skip }, async () => {
  const t = await setup();
  const input = { entity: "adsquad", id: "s1", daily_budget: 15 };
  const result = await t.raw("snap_set_daily_budget", input);
  const { page, frame, shot } = await open(pageFor("preview.html"), { tool: "snap_set_daily_budget", input, result }, (n, a) => t.raw(n, a), "preview-undo");
  await frame.getByText(/Adds 5 per day of spending/).waitFor({ timeout: 15000 });
  await frame.getByText(/Approval expires in/).waitFor({ timeout: 15000 });
  await shot("before");
  await frame.getByRole("button", { name: "Apply" }).click();
  await frame.getByRole("button", { name: "Undo this change" }).waitFor({ timeout: 15000 });
  assert.equal(t.db.adsquads.s1.daily_budget_micro, 15e6);
  await frame.getByRole("button", { name: "Undo this change" }).click();
  await frame.getByRole("button", { name: "Confirm undo" }).waitFor({ timeout: 15000 });
  assert.equal(t.db.adsquads.s1.daily_budget_micro, 15e6, "the undo preview sends nothing");
  await shot("undo");
  await frame.getByRole("button", { name: "Confirm undo" }).click();
  await frame.getByText("Undone.").waitFor({ timeout: 15000 });
  assert.equal(t.db.adsquads.s1.daily_budget_micro, 10e6);

  const t2 = await setup();
  const r2 = await t2.raw("snap_set_status", { entity: "adsquad", id: "s1", status: "PAUSED" });
  const p2 = await open(pageFor("preview.html"), { tool: "snap_set_status", input: { entity: "adsquad", id: "s1", status: "PAUSED" }, result: r2 }, (n, a) => t2.raw(n, a), "preview-cancel");
  await p2.frame.getByRole("button", { name: "Cancel" }).click();
  await p2.frame.getByText("Nothing was sent.").waitFor({ timeout: 15000 });
  assert.equal(t2.writes().length, 0);
  await page.close();
  await p2.page.close();
});

test("history card: Before / after, then Undo previews and reverts, and the list reloads", { skip }, async () => {
  const t = await setup();
  await t.twoStep("snap_set_daily_budget", { entity: "adsquad", id: "s1", daily_budget: 15 });
  const result = await t.raw("snap_change_history", {});
  const { page, frame, shot } = await open(pageFor("history.html"), { tool: "snap_change_history", input: {}, result }, (n, a) => t.raw(n, a), "history");
  const row = frame.locator(".row", { hasText: "Squad s1" });
  await row.getByRole("button", { name: "Before / after" }).click();
  await frame.getByText("10 → 15").waitFor({ timeout: 15000 });
  await shot("open");
  await row.getByRole("button", { name: "Undo" }).click();
  await frame.getByRole("button", { name: "Confirm undo" }).click();
  await frame.getByText(/· undone/).waitFor({ timeout: 15000 });
  assert.equal(t.db.adsquads.s1.daily_budget_micro, 10e6);
  await page.close();
});

test("advice card: tick moves, Apply previews and applies each one, stopping at nothing when all pass", { skip }, async () => {
  const t = await setup();
  const advice = { window: { days: 7 }, median_roas: 3, squads_compared: 3, decreases: [{ adsquad: "Squad s1", adsquad_id: "s1", from: 10, to: 8, why: "ROAS 1" }], increases: [{ adsquad: "Squad s3", adsquad_id: "s3", from: 30, to: 36, why: "ROAS 6" }] };
  const result = { content: [{ type: "text", text: JSON.stringify(advice) }], structuredContent: advice };
  const { page, frame, shot } = await open(pageFor("advice.html"), { tool: "snap_budget_advice", input: {}, result }, (n, a) => t.raw(n, a), "advice");
  await frame.getByText(/2 of 2 selected · net \+4 per day/).waitFor({ timeout: 15000 });
  await shot("list");
  await frame.getByRole("button", { name: "Only cuts" }).click();
  await frame.getByText(/1 of 2 selected/).waitFor();
  await frame.getByRole("button", { name: "Apply 1 change" }).click();
  await frame.getByText(/1 budget changed/).waitFor({ timeout: 15000 });
  assert.equal(t.db.adsquads.s1.daily_budget_micro, 8e6);
  assert.equal(t.db.adsquads.s3.daily_budget_micro, 30e6, "an unticked move is not sent");
  await page.close();
});

test("advice card: a warning in a preview stops the batch and nothing is applied unseen", { skip }, async () => {
  const t = await setup({ env: { SNAP_MAX_BUDGET_INCREASE_PCT: "1000", SNAP_MAX_ADDED_DAILY_BUDGET_24H: "5000", SNAP_MAX_ACTIVATION_DAILY_BUDGET: "5000" } });
  const advice = { window: { days: 7 }, median_roas: 3, squads_compared: 3, decreases: [], increases: [{ adsquad: "Squad s3", adsquad_id: "s3", from: 30, to: 300, why: "ROAS 6" }] };
  const result = { content: [{ type: "text", text: JSON.stringify(advice) }], structuredContent: advice };
  const { page, frame } = await open(pageFor("advice.html"), { tool: "snap_budget_advice", input: {}, result }, (n, a) => t.raw(n, a), "advice-warning");
  await frame.getByRole("button", { name: "Apply 1 change" }).click();
  await frame.getByText(/Not applied: .*adds 270/).waitFor({ timeout: 15000 });
  assert.equal(t.db.adsquads.s3.daily_budget_micro, 30e6, "the budget was not changed");
  assert.equal(t.writes().length, 0);
  await page.close();
});

test("setup card: account banner, checklist with fixes, limits, and Run check again", { skip }, async () => {
  const t = await setup();
  const result = await t.raw("snap_setup_check", {});
  const calls = [];
  const { page, frame, shot } = await open(pageFor("setup.html"), { tool: "snap_setup_check", input: {}, result }, (n, a) => { calls.push(n); return t.raw(n, a); }, "setup");
  await frame.getByText("Ask before every change").waitFor({ timeout: 15000 });
  assert.match(await frame.locator("main").innerText(), /Highest daily budget\s+1,000/);
  await shot("checklist");
  await frame.getByRole("button", { name: "Run check again" }).click();
  for (let i = 0; i < 150 && !calls.length; i++) await new Promise((r) => setTimeout(r, 100));
  await frame.getByText("Ask before every change").waitFor({ timeout: 15000 });
  assert.deepEqual(calls, ["snap_setup_check"]);
  await page.close();
});
