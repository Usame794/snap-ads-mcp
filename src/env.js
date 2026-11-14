import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Where settings, the change log and exports live. A git checkout keeps them in the project folder, as before. A copy installed
// from npm (inside node_modules, including the npx cache) must not: that folder is replaced on every update, so it uses
// ~/.ads-mcp-for-snapchat instead. SNAP_HOME overrides both.
export function dataDir({ root = ROOT, env = process.env, home = homedir() } = {}) {
  if (env.SNAP_HOME) return env.SNAP_HOME;
  return root.split(sep).includes("node_modules") ? join(home, ".ads-mcp-for-snapchat") : root;
}
export const DATA_DIR = dataDir();

// The settings file in use: SNAP_ENV_FILE when set (one file per ad account), otherwise .env in the data folder.
export const envFile = () => process.env.SNAP_ENV_FILE || join(dataDir(), ".env");

// Minimal .env loader so the server needs no extra dependency.
export function loadEnv(file = envFile(), { override = false } = {}) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return; // .env is optional; real environment variables also work.
  }
  // When a key appears twice in the file, the LAST line wins (as in dotenv), so a line appended at the end, such as
  // SNAP_READ_ONLY=1, really takes effect. A real environment variable still wins over the file unless override is set.
  const values = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    values[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  for (const [key, value] of Object.entries(values)) {
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

// Writes or replaces KEY=value in the settings file in use (see envFile) without printing the value. With SNAP_ENV_FILE set,
// authorizing a second account writes that account's file and never touches the first one.
export function setEnvValue(key, value, file = envFile()) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // create the file if missing
  }
  // Every line of this key is replaced: the first keeps its place, later duplicates are removed. Otherwise a duplicate further
  // down would win when the file is read (see loadEnv) and the new value would be silently ignored.
  const re = new RegExp(`^${key}=.*(?:\n|$)`, "gm");
  let seen = false;
  if (re.test(text)) {
    text = text.replace(re, (line) => {
      if (seen) return "";
      seen = true;
      return `${key}=${value}${line.endsWith("\n") ? "\n" : ""}`;
    });
  } else {
    text = text.replace(/\n?$/, "\n") + `${key}=${value}\n`;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  // `mode` only applies when the file is created; an existing .env keeps its old permissions unless tightened here.
  try {
    chmodSync(file, 0o600);
  } catch {
    // not fatal (e.g. Windows), the value is still saved
  }
}
