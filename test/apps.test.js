// MCP Apps: the cards are registered, safe by construction, and optional (the same answers still arrive as text and data).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setup } from "./helpers/harness.js";
import { APP_URIS, UI_MIME, pageFor } from "../src/apps.js";

const FILES = ["dashboard.html", "board.html", "preview.html", "history.html", "setup.html", "advice.html"];

test("the cards are served as ui:// resources with the MCP Apps type", async () => {
  const t = await setup();
  const { resources } = await t.client.listResources();
  assert.deepEqual(resources.map((r) => r.uri).sort(), Object.values(APP_URIS).sort());
  for (const r of resources) assert.equal(r.mimeType, UI_MIME);
  for (const uri of Object.values(APP_URIS)) {
    const { contents } = await t.client.readResource({ uri });
    assert.equal(contents[0].mimeType, UI_MIME);
    assert.match(contents[0].text, /^<!doctype html>/i);
    assert.ok(!contents[0].text.includes("<!--BRIDGE-->"), "the shared script is inlined");
    assert.match(contents[0].text, /ui\/initialize/, "the page starts the MCP Apps handshake");
    assert.deepEqual(contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] }, "no network access is requested");
  }
});

test("the card tools and every tool that previews a change name their card", async () => {
  const t = await setup();
  const tools = (await t.client.listTools()).tools;
  const uri = (name) => tools.find((x) => x.name === name)._meta?.ui?.resourceUri;
  assert.equal(uri("snap_dashboard"), APP_URIS.dashboard);
  assert.equal(uri("snap_campaign_board"), APP_URIS.board);
  assert.equal(tools.find((x) => x.name === "snap_dashboard")._meta["ui/resourceUri"], APP_URIS.dashboard, "older hosts read the older key");
  const withConfirm = tools.filter((x) => x.inputSchema.properties.confirm);
  assert.ok(withConfirm.length >= 30);
  for (const tool of withConfirm) assert.equal(tool._meta?.ui?.resourceUri, APP_URIS.preview, `${tool.name} shows the preview card`);
  const plainRead = tools.find((x) => x.name === "snap_list_campaigns");
  assert.equal(plainRead._meta?.ui, undefined, "ordinary tools have no card");
});

test("the cards are optional: a client that ignores them still gets the text and the data", async () => {
  const t = await setup();
  for (const [name, args] of [["snap_dashboard", {}], ["snap_campaign_board", {}]]) {
    const r = await t.raw(name, args);
    assert.ok(!r.isError, name);
    assert.equal(r.content[0].type, "text");
    assert.ok(JSON.parse(r.content[0].text).summary, `${name} has a plain-language summary`);
    assert.ok(r.structuredContent.summary);
  }
});

test("the cards have no network access, no external addresses and no way to run text as code", () => {
  for (const file of FILES) {
    const html = pageFor(file);
    const external = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]).filter((u) => u !== "http://www.w3.org/2000/svg");
    assert.deepEqual(external, [], `${file} points at no outside address`);
    for (const bad of [/\binnerHTML\b/, /\bouterHTML\b/, /\beval\s*\(/, /new Function\s*\(/, /document\.write/, /insertAdjacentHTML/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /localStorage/, /<script[^>]+src=/i, /<link[^>]+href=/i]) assert.doesNotMatch(html, bad, `${file}: ${bad}`);
  }
});

test("the cards use the host's colors when given, work in light and dark, and keep tap targets large", () => {
  for (const file of FILES) {
    const html = pageFor(file);
    assert.match(html, /--color-background-primary/, `${file} uses the host's style variables`);
    assert.match(html, /prefers-color-scheme:dark/, `${file} has a dark mode`);
    assert.match(html, /data-theme=dark/, `${file} follows the host's theme`);
    assert.match(html, /name="viewport"/, `${file} is responsive`);
    assert.match(html, /min-height:44px/, `${file} has 44 px tap targets`);
  }
});

test("every card writes what it shows with textContent or text nodes only", () => {
  const bridge = readFileSync(new URL("../src/apps/bridge.js", import.meta.url), "utf8");
  assert.match(bridge, /createTextNode/);
  assert.match(bridge, /event\.source !== window\.parent/, "only the chat app that embeds the card can talk to it");
});

test("the card pages ship in the npm package and the Desktop extension", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("src"), "src (with src/apps) is published");
});
