import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { envFile, ROOT } from "./env.js";

// Creates the settings file from .env.example, private to the user. Never overwrites an existing file.
export function init(file = envFile()) {
  if (existsSync(file)) return { created: false, file };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  copyFileSync(join(ROOT, ".env.example"), file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // not fatal (e.g. Windows)
  }
  return { created: true, file };
}
