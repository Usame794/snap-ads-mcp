// The three cards, run in a real browser inside a fake chat app that speaks the MCP Apps protocol. The fake app answers
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

test("board: Pause shows a preview, Confirm applies it, and the row updates", { skip }, async () => {
  const t = await setup();
  const result = await t.raw("snap_campaign_board", {});
  const { page, frame, shot } = await open(pageFor("board.html"), { tool: "snap_campaign_board", input: {}, result }, (n, a) => t.raw(n, a), "board");
  await frame.getByText("Campaign c1").waitFor({ timeout: 15000 });
  await shot("list");
  await frame.locator(".row", { hasText: "Campaign c1" }).getByRole("button", { name: "Pause" }).click();
  await frame.getByRole("button", { name: "Confirm pause" }).waitFor({ timeout: 15000 });
  assert.equal(t.writes().length, 0, "nothing is sent while only previewing");
  const panel = await frame.locator(".panel").innerText();
  assert.match(panel, /Change/);
  assert.match(panel, /Campaign c1: ACTIVE to PAUSED/);
  assert.doesNotMatch(panel, /\[object/, "every value is shown as text");
  await shot("preview");
  await frame.getByRole("button", { name: "Confirm pause" }).click();
  await frame.locator(".row", { hasText: "Campaign c1" }).getByRole("button", { name: "Resume" }).waitFor({ timeout: 15000 });
  assert.equal(t.writes().length, 1, "exactly one write, after the click");
  assert.equal(t.writes()[0].body.campaigns?.[0]?.status ?? t.writes()[0].body.status, "PAUSED");
  await shot("done");
  await page.close();
});

test("board: with read-only on, the preview cannot be confirmed", { skip }, async () => {
  const t = await setup({ env: { SNAP_READ_ONLY: "1" } });
  const result = await t.raw("snap_campaign_board", {});
  const { page, frame } = await open(pageFor("board.html"), { tool: "snap_campaign_board", input: {}, result }, (n, a) => t.raw(n, a), "board-ro");
  await frame.locator(".row", { hasText: "Campaign c1" }).getByRole("button", { name: "Pause" }).click();
  await frame.getByText(/SNAP_READ_ONLY is on/).waitFor({ timeout: 15000 });
  assert.equal(await frame.getByRole("button", { name: "Confirm pause" }).isDisabled(), true);
  assert.equal(t.writes().length, 0);
  await page.close();
});

test("preview card: Apply uses the token from the preview and the same arguments", { skip }, async () => {
  const t = await setup();
  const input = { adsquad_ids: ["s1"], mode: "set", value: 12 };
  const result = await t.raw("snap_set_daily_budget", input);
  const { page, frame, shot } = await open(pageFor("preview.html"), { tool: "snap_set_daily_budget", input, result }, (n, a) => t.raw(n, a), "preview");
  await frame.getByText("Preview: nothing has changed yet").waitFor({ timeout: 15000 });
  const card = await frame.locator(".card").innerText();
  assert.doesNotMatch(card, /\[object/, "every value is shown as text");
  assert.match(card, /set daily budget/i);
  assert.match(card, /Squad s1: daily budget 10 -> 12/, "what would change is shown as a line, not as raw data");
  assert.doesNotMatch(card, /\bnull\b/);
  await shot("before");
  assert.equal(t.writes().length, 0);
  await frame.getByRole("button", { name: "Apply" }).click();
  await frame.getByText("Applied", { exact: true }).first().waitFor({ timeout: 15000 });
  assert.equal(t.writes().length >= 1, true);
  await shot("after");
  await page.close();
});

test("preview card: a read-only server cannot be applied from the card", { skip }, async () => {
  const t = await setup({ env: { SNAP_READ_ONLY: "1" } });
  const input = { entity: "adsquad", id: "s1", status: "PAUSED" };
  const result = await t.raw("snap_set_status", input);
  const { page, frame } = await open(pageFor("preview.html"), { tool: "snap_set_status", input, result }, (n, a) => t.raw(n, a), "preview-ro");
  await frame.getByText(/SNAP_READ_ONLY is on/).first().waitFor({ timeout: 15000 });
  assert.equal(await frame.getByRole("button", { name: "Apply" }).isDisabled(), true);
  await page.close();
});

test("dashboard: tiles, one bar per day, and the period switch reloads the data", { skip }, async () => {
  const now = new Date("2026-11-21T10:00:00Z");
  const data = (days) => dashboardData(statsClient({ days }), { adAccountId: "acc-1", days, currency: "USD", now });
  const asResult = (d) => ({ content: [{ type: "text", text: JSON.stringify(d) }], structuredContent: d });
  const calls = [];
  const { page, frame, shot } = await open(pageFor("dashboard.html"), { tool: "snap_dashboard", input: { days: 7 }, result: asResult(await data(7)) }, async (n, a) => { calls.push([n, a]); return asResult(await data(a.days)); }, "dashboard");
  await frame.getByText("Spend USD").waitFor({ timeout: 15000 });
  assert.match(await frame.locator("#kpis").innerText(), /280/);
  assert.equal(await frame.locator("svg rect.bar").count(), 7);
  await shot("7days");
  await frame.getByRole("button", { name: "14 days" }).click();
  await frame.locator("svg rect.bar").nth(13).waitFor({ timeout: 15000 });
  assert.equal(await frame.locator("svg rect.bar").count(), 14);
  assert.deepEqual(calls, [["snap_dashboard", { days: 14 }]]);
  assert.equal(await frame.getByRole("button", { name: "14 days" }).getAttribute("aria-pressed"), "true");
  await shot("14days");
  await page.close();
});

test("names that look like code are shown as text and never run", { skip }, async () => {
  const t = await setup();
  const evil = '<img src=x onerror="window.top.postMessage(1,\'*\');document.title=\'pwned\'">';
  t.db.campaigns.c1 = { ...t.db.campaigns.c1, name: evil };
  const result = await t.raw("snap_campaign_board", {});
  const { page, frame } = await open(pageFor("board.html"), { tool: "snap_campaign_board", input: {}, result }, (n, a) => t.raw(n, a), "xss");
  await frame.getByText(evil, { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(await frame.locator("img").count(), 0, "no element was created from the name");
  assert.equal(await frame.locator("body").evaluate(() => document.title), "Campaigns");
  await page.close();
});

test("dark theme and a narrow window still render the board", { skip }, async () => {
  const t = await setup();
  const result = await t.raw("snap_campaign_board", {});
  const { page, frame, shot } = await open(pageFor("board.html"), { tool: "snap_campaign_board", input: {}, result }, (n, a) => t.raw(n, a), "board-dark", "dark");
  await frame.getByText("Campaign c1").waitFor({ timeout: 15000 });
  assert.equal(await frame.locator("html").getAttribute("data-theme"), "dark");
  await page.evaluate(() => { document.getElementById("f").style.width = "320px"; });
  await frame.getByText("Campaign c1").waitFor();
  await shot("narrow");
  const overflow = await frame.locator("body").evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false, "no sideways scrolling at 320 px");
  await page.close();
});
