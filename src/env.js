import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The settings file in use: SNAP_ENV_FILE when set (one file per ad account), otherwise .env in the project folder.
export const envFile = () => process.env.SNAP_ENV_FILE || join(ROOT, ".env");

// Minimal .env loader so the server needs no extra dependency.
export function loadEnv(file = envFile(), { override = false } = {}) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      if (override || process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env is optional; real environment variables also work.
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
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, () => `${key}=${value}`) : text.replace(/\n?$/, "\n") + `${key}=${value}\n`;
  writeFileSync(file, text, { mode: 0o600 });
  // `mode` only applies when the file is created; an existing .env keeps its old permissions unless tightened here.
  try {
    chmodSync(file, 0o600);
  } catch {
    // not fatal (e.g. Windows), the value is still saved
  }
}
