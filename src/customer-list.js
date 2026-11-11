// Customer-list audiences: read a local CSV, normalise and SHA-256 hash on this machine, upload only hashes.
// Raw emails and phone numbers are never printed, logged or sent.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { logChange } from "./changes.js";

export const MAX_ROWS = 500_000;
export const BATCH = 10_000;
const SCHEMAS = { email: "EMAIL_SHA256", phone: "PHONE_SHA256" };
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function normalizeEmail(raw) {
  const e = String(raw ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

// Digits only, with the country code. A number written with + or 00 already carries its country code. A local number (leading 0,
// or too short to include one) needs defaultCountryCode; without one it counts as invalid, because guessing a code would hash the
// wrong number. Longer numbers without + are taken as already including their country code.
export function normalizePhone(raw, defaultCountryCode) {
  const text = String(raw ?? "").trim();
  let d = text.replace(/\D/g, "");
  const international = text.startsWith("+") || d.startsWith("00");
  if (d.startsWith("00")) d = d.slice(2);
  if (!international) {
    if (d.startsWith("0")) {
      if (!defaultCountryCode) return null;
      d = defaultCountryCode + d.slice(1);
    } else if (d.length <= 9 && !(defaultCountryCode && d.startsWith(defaultCountryCode))) {
      if (!defaultCountryCode) return null;
      d = defaultCountryCode + d;
    }
  }
  return d.length >= 10 && d.length <= 15 ? d : null;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function readIdentifiers(filePath, { kind, column, defaultCountryCode }) {
  if (!SCHEMAS[kind]) throw new Error("kind must be email or phone");
  // Only spreadsheet exports are read. Without this, the "columns are..." hint below would echo the first line of any file.
  if (!/\.(csv|tsv|txt)$/i.test(String(filePath))) throw new Error("file_path must be a .csv (or .tsv/.txt) export with a header row");
  let size;
  try { size = statSync(filePath).size; } catch { throw new Error(`File not found: ${filePath}`); }
  if (size > 100 * 1024 * 1024) throw new Error("File is over 100 MB");
  const lines = readFileSync(filePath, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("The file needs a header row and at least one data row");
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  let idx = column ? header.indexOf(String(column).trim().toLowerCase()) : header.findIndex((h) => (kind === "email" ? /e-?mail/.test(h) : /phone|mobile|mob|tel|cell|جوال|هاتف/.test(h)));
  if (idx < 0) {
    // Header names only, shortened, and never anything that looks like a value (an address, a number, a key=value pair).
    const names = header.slice(0, 20).map((h) => (/[@=]|\d{6,}/.test(h) ? "(hidden)" : h.slice(0, 30)));
    throw new Error(`Could not find a ${kind} column. Columns are: ${names.join(", ")}${header.length > 20 ? ", ..." : ""}. Pass \`column\`.`);
  }
  if (lines.length - 1 > MAX_ROWS) throw new Error(`Too many rows (${lines.length - 1}, limit ${MAX_ROWS})`);
  const seen = new Set();
  let invalid = 0;
  let duplicates = 0;
  for (const line of lines.slice(1)) {
    const raw = parseCsvLine(line)[idx];
    const norm = kind === "email" ? normalizeEmail(raw) : normalizePhone(raw, defaultCountryCode);
    if (!norm) { invalid++; continue; }
    const h = sha256(norm);
    if (seen.has(h)) duplicates++;
    else seen.add(h);
  }
  return { column: header[idx], rows: lines.length - 1, valid: seen.size, invalid, duplicates, hashes: [...seen] };
}

export function buildCustomerSegment({ adAccountId, name, description }) {
  const n = String(name ?? "").trim();
  if (n.length < 3) throw new Error("name must be at least 3 characters");
  return { ad_account_id: adAccountId, name: n, description: description ?? "Customer list uploaded locally (hashed)", source_type: "FIRST_PARTY", retention_in_days: 9999 };
}

export async function uploadCustomerList({ client, segmentId, hashes, kind, logFile }) {
  let sent = 0;
  try {
    for (let i = 0; i < hashes.length; i += BATCH) {
      const chunk = hashes.slice(i, i + BATCH);
      await client.request("POST", `/segments/${segmentId}/users`, { body: { users: [{ schema: [SCHEMAS[kind]], data: chunk.map((h) => [h]) }] } });
      sent += chunk.length;
    }
  } catch (e) {
    logChange({ entity: "customer_list", id: segmentId, change: `upload FAILED after ${sent}: ${e.message}` }, logFile);
    throw new Error(`${e.message}. ${sent} identifiers were uploaded before the failure (segment ${segmentId}).`);
  }
  logChange({ entity: "customer_list", id: segmentId, change: `uploaded ${sent} hashed ${kind} identifiers` }, logFile);
  return sent;
}
