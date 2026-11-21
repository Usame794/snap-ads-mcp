// Shared by the three cards. Talks to the chat app over postMessage using the MCP Apps protocol (2026-01-26): it starts with
// ui/initialize, receives the tool's input and result as notifications, and can call this server's tools through the app.
// Everything shown is written as text nodes (never as markup), because names in an ad account are untrusted text.
(function () {
  const pending = new Map();
  const handlers = {};
  const state = { ctx: {}, nextId: 1 };
  const post = (msg) => window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, msg), "*");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = state.nextId++;
      pending.set(id, { resolve, reject });
      post({ id, method, params });
    });
  const notify = (method, params) => post({ method, params });

  function applyContext(ctx) {
    if (!ctx) return;
    Object.assign(state.ctx, ctx);
    const root = document.documentElement;
    if (ctx.theme) root.setAttribute("data-theme", ctx.theme);
    const vars = ctx.styles && ctx.styles.variables;
    if (vars) for (const k in vars) if (vars[k]) root.style.setProperty(k, vars[k]);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && m.method === undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || "Request failed"));
      else p.resolve(m.result);
      return;
    }
    if (!m.method) return;
    if (m.method === "ui/notifications/host-context-changed") applyContext(m.params);
    const handler = handlers[m.method];
    try {
      if (handler) handler(m.params);
    } catch (e) {
      console.error(e);
    }
    if (m.id !== undefined) post({ id: m.id, result: {} }); // the host asked something (ping, teardown): answer it
  });

  function resize() {
    notify("ui/notifications/size-changed", { height: Math.ceil(document.documentElement.scrollHeight) });
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === "class") node.className = attrs[k];
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) node.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    }
    for (const c of children.flat(Infinity)) if (c !== undefined && c !== null && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
    return node;
  }
  const num = (n, d) => (n === null || n === undefined || Number.isNaN(Number(n)) ? "n/a" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d === undefined ? 2 : d }));
  const textOf = (r) => ((r && r.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  // The data of a tool result: structuredContent when the app sent it, otherwise the JSON text.
  const dataOf = (r) => {
    if (r && r.structuredContent) return r.structuredContent;
    try {
      return JSON.parse(textOf(r));
    } catch {
      return null;
    }
  };

  function connect(on) {
    Object.assign(handlers, on || {});
    request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "Ads MCP for Snapchat", version: "1" }, appCapabilities: {} })
      .then((res) => {
        applyContext(res && res.hostContext);
        notify("ui/notifications/initialized", {});
        if (handlers.ready) handlers.ready(state.ctx);
      })
      .catch((e) => handlers.error && handlers.error(e));
    if (window.ResizeObserver) new ResizeObserver(resize).observe(document.body);
  }

  window.snapApp = {
    connect,
    el,
    num,
    textOf,
    dataOf,
    resize,
    call: (name, args) => request("tools/call", { name, arguments: args || {} }),
    get ctx() {
      return state.ctx;
    },
  };
})();
