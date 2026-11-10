#!/usr/bin/env node
// Saves the client secret from the macOS clipboard into .env, after checking it looks like a secret.
// Usage: node scripts/save-secret.js     (copy the secret first). Prints nothing secret and clears the clipboard.
import { execFileSync } from "node:child_process";
import { setEnvValue } from "../src/env.js";

const clip = execFileSync("pbpaste", { encoding: "utf8" }).trim();
const problems = [];
if (clip.length < 20) problems.push(`too short (${clip.length} chars)`);
if (/\s/.test(clip)) problems.push("contains spaces or line breaks");
if (!/^[A-Za-z0-9._~+\-\/=]+$/.test(clip)) problems.push("contains characters a secret normally doesn't");
if (problems.length) {
  console.error(`Clipboard does not look like a client secret: ${problems.join("; ")}. Nothing was saved. Copy the secret again and rerun.`);
  process.exit(1);
}
setEnvValue("SNAP_CLIENT_SECRET", clip);
execFileSync("pbcopy", { input: "" });
console.log(`Saved SNAP_CLIENT_SECRET to .env (${clip.length} chars). Clipboard cleared.`);
