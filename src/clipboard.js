// Reads text from the system clipboard without extra dependencies. Returns null when no clipboard tool is available.
import { execFileSync } from "node:child_process";

const READERS = {
  darwin: [["pbpaste", []]],
  linux: [["wl-paste", ["--no-newline"]], ["xclip", ["-selection", "clipboard", "-o"]], ["xsel", ["--clipboard", "--output"]]],
  win32: [["powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]]],
};
const CLEARERS = {
  darwin: [["pbcopy", []]],
  linux: [["wl-copy", ["--clear"]], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--clear"]]],
  win32: [["powershell", ["-NoProfile", "-Command", "Set-Clipboard -Value $null"]]],
};

export function readClipboard({ platform = process.platform, exec = execFileSync } = {}) {
  for (const [cmd, args] of READERS[platform] ?? []) {
    try {
      return String(exec(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).trim();
    } catch {
      // try the next tool
    }
  }
  return null;
}

export function clearClipboard({ platform = process.platform, exec = execFileSync } = {}) {
  for (const [cmd, args] of CLEARERS[platform] ?? []) {
    try {
      exec(cmd, args, { input: "", stdio: ["pipe", "ignore", "ignore"] });
      return true;
    } catch {
      // try the next tool
    }
  }
  return false;
}

// What a client secret should look like. Anything else is refused, so a wrong paste is never saved.
export function secretProblems(text) {
  const problems = [];
  if (text.length < 20) problems.push(`too short (${text.length} chars)`);
  if (/\s/.test(text)) problems.push("contains spaces or line breaks");
  if (!/^[A-Za-z0-9._~+\-\/=]+$/.test(text)) problems.push("contains characters a secret normally doesn't");
  return problems;
}
