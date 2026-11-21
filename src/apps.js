// MCP Apps: small interactive cards that some AI apps (Claude, ChatGPT and others) show inside the chat. Each card is one HTML page
// served as a `ui://` resource. A tool names its card in `_meta.ui.resourceUri`; apps that do not support cards ignore it and use
// the tool's text and data as before. The pages contain no network access (nothing is declared in the CSP) and write text with
// textContent only, so names that come from ads can never run as code.
import { readFileSync } from "node:fs";

export const UI_MIME = "text/html;profile=mcp-app";
export const APP_URIS = {
  dashboard: "ui://snap-ads/dashboard",
  board: "ui://snap-ads/board",
  preview: "ui://snap-ads/preview",
  history: "ui://snap-ads/history",
  setup: "ui://snap-ads/setup",
  advice: "ui://snap-ads/advice",
};
// Which tool shows which card. Every tool that previews a change (it has `confirm`) shows the preview card.
export const APP_TOOLS = { snap_dashboard: APP_URIS.dashboard, snap_campaign_board: APP_URIS.board, snap_change_history: APP_URIS.history, snap_setup_check: APP_URIS.setup, snap_budget_advice: APP_URIS.advice };

const read = (name) => readFileSync(new URL(`./apps/${name}`, import.meta.url), "utf8");
const BRIDGE = read("bridge.js");
export const pageFor = (file) => read(file).replace("<!--BRIDGE-->", () => `<script>\n${BRIDGE}\n</script>`);

export function uiMeta(uri) {
  // `ui/resourceUri` is the older spelling, kept so older hosts still find the card.
  return { ui: { resourceUri: uri }, "ui/resourceUri": uri };
}

export function registerApps(server) {
  const pages = [
    ["snap-ads-dashboard", APP_URIS.dashboard, "dashboard.html", "Account dashboard: spend, ROAS, purchases and pacing, with a 7, 14 or 30 day switch."],
    ["snap-ads-board", APP_URIS.board, "board.html", "Campaign list with pause and resume buttons that go through the usual preview and approval."],
    ["snap-ads-preview", APP_URIS.preview, "preview.html", "Preview of a change, with an Apply button that uses the approval token, and Undo after it is applied."],
    ["snap-ads-history", APP_URIS.history, "history.html", "Change history with before and after values and Undo buttons that go through the usual preview and approval."],
    ["snap-ads-setup", APP_URIS.setup, "setup.html", "Connection and safety checklist with how to fix anything missing."],
    ["snap-ads-advice", APP_URIS.advice, "advice.html", "Budget suggestions to tick and apply together; each still previews and uses its approval token."],
  ];
  for (const [name, uri, file, description] of pages) {
    server.registerResource(name, uri, { description, mimeType: UI_MIME }, async () => ({ contents: [{ uri, mimeType: UI_MIME, text: pageFor(file), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] }));
  }
}
