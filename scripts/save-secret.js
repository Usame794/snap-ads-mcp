#!/usr/bin/env node
// Saves the client secret into .env after checking that it looks like a secret. Prints nothing secret.
// Usage: node scripts/save-secret.js            reads the system clipboard (macOS, Linux with wl-paste/xclip/xsel, Windows) and clears it
//        node scripts/save-secret.js --stdin    reads the secret from standard input instead (e.g. `pbpaste | node scripts/save-secret.js --stdin`)
import { readFileSync } from "node:fs";
import { setEnvValue } from "../src/env.js";
import { clearClipboard, readClipboard, secretProblems } from "../src/clipboard.js";

const fromStdin = process.argv.includes("--stdin");
const text = fromStdin ? readFileSync(0, "utf8").trim() : readClipboard();
if (text === null) {
  console.error("No clipboard tool was found. Run it as: node scripts/save-secret.js --stdin   and paste the secret, or add SNAP_CLIENT_SECRET=... to .env yourself (chmod 600 .env).");
  process.exit(1);
}
const problems = secretProblems(text);
if (problems.length) {
  console.error(`The text does not look like a client secret: ${problems.join("; ")}. Nothing was saved. Copy the secret again and rerun.`);
  process.exit(1);
}
setEnvValue("SNAP_CLIENT_SECRET", text);
const cleared = fromStdin ? false : clearClipboard();
console.log(`Saved SNAP_CLIENT_SECRET to .env (${text.length} chars).${cleared ? " Clipboard cleared." : fromStdin ? "" : " Clear your clipboard yourself."}`);
