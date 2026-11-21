// Data for the interactive cards that are not reports: the change history (with what can be undone) and the connection and
// safety check. Both only read. Their cards change things only through snap_undo, with its own preview and approval.
import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import { readLog, undoableEntries } from "./changes.js";

const MONEY = new Set(["daily_budget_micro", "bid_micro", "lifetime_budget_micro"]);
const LABEL = { status: "Status", daily_budget_micro: "Daily budget", bid_micro: "Bid", lifetime_budget_micro: "Lifetime budget", targeting: "Targeting", start_time: "Start", end_time: "End", name: "Name", cap_and_exclusion_config: "Frequency cap", ad_scheduling_config: "Ad schedule", placement_v2: "Placement", bid_strategy: "Bid strategy" };
const KIND = { status: "status", daily_budget_micro: "budget", bid_micro: "bid", targeting: "targeting", start_time: "schedule", end_time: "schedule", name: "rename" };

const shown = (field, v) => {
  if (v === null || v === undefined) return "none";
  if (MONEY.has(field) && typeof v === "number") return String(Math.round(v / 1e4) / 100);
  if (typeof v === "object") {
    const t = JSON.stringify(v);
    return t.length > 160 ? `${t.slice(0, 160)}…` : t;
  }
  return String(v);
};

// Newest first. `undo_position` is the n_from_last that snap_undo needs to revert this entry; it is set only for entries
// snap_undo would accept (a recorded before-value, not undone yet, not itself an undo).
export function changeHistory(logFile, { limit = 30, kind = null } = {}) {
  const all = readLog(5000, logFile).filter((e) => e && e.change && e.kind !== "audit" && !e.warning);
  let undoable = [];
  try {
    undoable = undoableEntries(logFile);
  } catch {
    undoable = [];
  }
  const positionOf = new Map(undoable.map((e, i) => [`${e.at}|${e.id}`, undoable.length - i]));
  const undone = new Set(all.filter((e) => e.undoes).map((e) => e.undoes));
  const rows = all
    .slice()
    .reverse()
    .map((e) => {
      const fields = Object.keys(e.patch ?? {});
      const type = e.undoes ? "undo" : KIND[fields[0]] ?? (String(e.entity).includes("create") || ["copy", "copy_adsquad", "clone_ad", "media_upload", "customer_list"].includes(e.entity) ? "create" : e.entity === "delete" ? "delete" : "other");
      return {
        at: e.at,
        entity: e.entity,
        id: e.id ?? null,
        name: e.name ?? null,
        type,
        summary: e.change,
        verified: e.verified ?? null,
        fields: fields.map((f) => ({ field: LABEL[f] ?? f, before: shown(f, e.before?.[f]), after: shown(f, e.after?.[f] ?? e.patch?.[f]) })),
        undone: undone.has(e.at),
        undo_position: positionOf.get(`${e.at}|${e.id}`) ?? null,
      };
    })
    .filter((r) => !kind || r.type === kind);
  return {
    summary: rows.length ? `${rows.length} change${rows.length === 1 ? "" : "s"} made through this server, newest first.` : "No changes have been made through this server yet.",
    log_file: logFile,
    items: rows.slice(0, limit),
    total: rows.length,
    has_more: rows.length > limit,
    how_to_undo: "Undo one with snap_undo and its n_from_last = undo_position. It previews first and is checked like any change.",
  };
}

// What is connected and which safety settings are on, as a checklist. No secrets are returned.
export async function setupCheck(client, { cfg, policy, logFile }) {
  const checks = [];
  const add = (id, label, state, detail, fix = null) => checks.push({ id, label, state, detail, ...(fix ? { fix } : {}) });
  let me = null;
  try {
    const r = await client.request("GET", "/me");
    me = r.me ?? r;
    add("login", "Snapchat login", "ok", `Connected${me.display_name ? ` as ${me.display_name}` : ""}.`);
  } catch (e) {
    add("login", "Snapchat login", "error", `Not connected (${String(e.message).slice(0, 140)}).`, "Ask: connect my Snapchat ad account (snap_connect).");
  }
  let account = null;
  if (!cfg.account) add("account", "Ad account", "error", "No ad account is chosen.", "Ask: connect my Snapchat ad account, then pick one.");
  else if (me) {
    try {
      const a = (await client.request("GET", `/adaccounts/${cfg.account}`)).adaccounts?.[0]?.adaccount ?? {};
      account = { id: a.id ?? cfg.account, name: a.name ?? null, status: a.status ?? null, currency: a.currency ?? null, timezone: a.timezone ?? null };
      const curOk = !policy.currency || policy.currency === a.currency;
      add("account", "Ad account", a.status === "ACTIVE" && curOk ? "ok" : "warn", `${a.name ?? cfg.account} · ${a.status ?? "status unknown"} · ${a.currency ?? "?"}${curOk ? "" : ` (settings say ${policy.currency}: writes are refused)`}`);
    } catch (e) {
      add("account", "Ad account", "error", `Cannot read ${cfg.account} (${String(e.message).slice(0, 120)}).`);
    }
  }
  add("pixel", "Pixel", cfg.pixel ? "ok" : "warn", cfg.pixel ? `Set (${cfg.pixel}).` : "Not set. Purchase goals, pixel audiences and catalog retargeting need one.", cfg.pixel ? null : "Set SNAP_PIXEL_ID in the settings (snap_list_pixels shows the ids).");
  add("profile", "Brand profile", cfg.profile ? "ok" : "warn", cfg.profile ? "Set: new ads post under it." : "Not set. Creating creatives needs one.", cfg.profile ? null : "Set SNAP_BRAND_PROFILE_ID in the settings.");
  add("country", "Main country", policy.defaultCountry ? "ok" : "warn", policy.defaultCountry ? `${policy.defaultCountry.toUpperCase()}: used when a new ad squad names no country.` : "Not set. Every new ad squad must name its countries.", policy.defaultCountry ? null : "Set SNAP_DEFAULT_COUNTRY, e.g. sa.");
  let logOk = true;
  try {
    accessSync(dirname(logFile), constants.W_OK);
  } catch {
    logOk = false;
  }
  add("log", "Change log", logOk ? "ok" : "error", logOk ? "Writable: changes are recorded and can be undone." : "Not writable: every change will be refused.");
  add("approval", "Ask before every change", policy.humanApproval === "elicit" ? "ok" : "warn", policy.humanApproval === "elicit" ? "On: you approve each change in the app; changes that add spending also need a code." : "Off: the assistant can apply a change it previewed without asking you.", policy.humanApproval === "elicit" ? null : "Set SNAP_HUMAN_APPROVAL=elicit in the settings and restart.");
  const cur = account?.currency ?? policy.currency ?? "";
  return {
    summary: `${checks.filter((c) => c.state === "ok").length} of ${checks.length} checks are fine${checks.some((c) => c.state === "error") ? "; something blocks work" : checks.some((c) => c.state === "warn") ? "; some settings are missing" : ""}.`,
    account,
    checks,
    limits: {
      currency: cur || null,
      max_daily_budget: policy.maxDailyBudget,
      max_added_per_24h: policy.maxAddedDailyBudget24h,
      max_started_per_call: policy.maxActivationDailyBudget,
      max_bid: policy.maxBid,
      max_increase_pct: policy.maxIncreasePct,
      read_only: policy.readOnly,
      human_approval: policy.humanApproval,
    },
  };
}
