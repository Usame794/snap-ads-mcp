// `npx ads-mcp-for-snapchat setup`: one guided command from nothing to a working, registered server.
// Asks for the OAuth app's Client ID and secret (hidden), opens the approval page, takes the address the browser lands on,
// saves the refresh token, lets the person pick an ad account from a list, sets the first safety settings and registers the
// server in Claude Code. Every input and side effect goes through `io`/`deps`, so it is tested without a terminal or network.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { envFile, ROOT, setEnvValue, dataDir } from "./env.js";
import { secretProblems } from "./clipboard.js";
import { authorizeUrl, DEFAULT_REDIRECT, exchangeCode, extractCode, listAdAccounts, looksLikeClientId, newState } from "./oauth.js";
import { SnapClient } from "./snap.js";
import { brokerUrlFrom, startBrokerLogin } from "./broker.js";
import { init } from "./init.js";

const readSettings = (file) => {
  const out = {};
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // no file yet
  }
  return out;
};

// Terminal input. Lines are queued as they arrive, so answers typed ahead or piped in are never lost between questions.
// The secret prompt echoes nothing.
export function terminalIO({ input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  let muted = false;
  const write = rl._writeToOutput?.bind(rl);
  if (write) rl._writeToOutput = (s) => (muted ? undefined : write(s));
  const lines = [];
  const waiting = [];
  let closed = false;
  rl.on("line", (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
  rl.on("close", () => {
    closed = true;
    while (waiting.length) waiting.shift()(null);
  });
  const ask = async (q) => {
    output.write(q);
    const line = lines.length ? lines.shift() : closed ? null : await new Promise((resolve) => waiting.push(resolve));
    if (line === null) throw new Error("Input ended before setup finished.");
    return line.trim();
  };
  return {
    print: (s = "") => output.write(`${s}\n`),
    ask,
    askSecret: async (q) => {
      muted = true;
      try {
        output.write(q);
        const line = lines.length ? lines.shift() : closed ? null : await new Promise((resolve) => waiting.push(resolve));
        if (line === null) throw new Error("Input ended before setup finished.");
        return line.trim();
      } finally {
        muted = false;
        output.write("\n");
      }
    },
    close: () => rl.close(),
  };
}

export function openInBrowser(url, { platform = process.platform, spawn = spawnSync } = {}) {
  const [cmd, args] = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    return spawn(cmd, args, { stdio: "ignore", timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

const hasClaude = (exec = execFileSync) => {
  try {
    exec("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// How an MCP client should start this server: the npm package for an installed copy, the file itself for a git checkout.
export function launchCommand(root = ROOT) {
  return root.split(/[\\/]/).includes("node_modules") ? { command: "npx", args: ["-y", "ads-mcp-for-snapchat"] } : { command: "node", args: [join(root, "src", "index.js")] };
}

async function askUntil(io, question, check) {
  for (let i = 0; i < 5; i++) {
    const answer = await io.ask(question);
    const problem = check(answer);
    if (!problem) return answer;
    io.print(`  ${problem}`);
  }
  throw new Error("Too many invalid answers. Run setup again when you have the details.");
}

export async function runSetup({ io, file = envFile(), fetchImpl = fetch, open = openInBrowser, exec = execFileSync, claudeAvailable = hasClaude, root = ROOT, broker, startLogin = startBrokerLogin } = {}) {
  const say = io.print;
  const created = init(file).created;
  let cur = readSettings(file);
  say("");
  say("Ads MCP for Snapchat: setup");
  say(`Settings file: ${file}${created ? " (new)" : ""}`);
  say("Nothing here can change your ads. It only connects the account and saves settings on this computer.");
  say("");

  // The shared login: no OAuth app to create. Offered only on a fresh settings file (own app credentials are never replaced here).
  let clientId = null;
  let secret = null;
  let token = null;
  let shared = false;
  const brokerUrl = broker === undefined ? brokerUrlFrom(process.env) : broker;
  if (brokerUrl && !cur.SNAP_CLIENT_SECRET) {
    say("There are two ways to connect:");
    say("  1. Shared login (easiest): just log in with Snapchat. No OAuth app to create.");
    say("  2. Your own Snapchat OAuth app (about 5 minutes).");
    say(`     The shared login uses ${brokerUrl}, which only passes your login along and stores nothing. See PRIVACY.md.`);
    const choice = await askUntil(io, "Choose 1 or 2 [1]: ", (a) => (!a || a === "1" || a === "2" ? null : "Type 1 or 2."));
    shared = choice !== "2";
  }
  if (shared) {
    say("");
    say("STEPS 1 and 2 of 5: log in with Snapchat (no OAuth app needed)");
    const login = await startLogin({ brokerUrl });
    const opened = open(login.url);
    say(opened ? "  Your browser opened. Log in to Snapchat and click Continue." : "  Open this link, log in to Snapchat and click Continue:");
    if (!opened) say(`  ${login.url}`);
    say("  Waiting for you to finish in the browser (up to 5 minutes)...");
    token = await login.done;
    setEnvValue("SNAP_BROKER_URL", brokerUrl, file);
    setEnvValue("SNAP_REFRESH_TOKEN", token, file);
    say("  Connected. Access saved on this computer only.");
    say("");
  } else {
    // 1. OAuth app
    say("STEP 1 of 5: your Snapchat OAuth app (one time, about 3 minutes)");
    say("  1. Open https://business.snapchat.com and go to Business Details > OAuth Apps > + OAuth App.");
    say(`  2. Any app name. Redirect URI: ${DEFAULT_REDIRECT}`);
    say("  3. Create it. Copy the Client ID, and the Client Secret (shown only once).");
    say("");
    const keepId = looksLikeClientId(cur.SNAP_CLIENT_ID ?? "");
    const idAnswer = await askUntil(io, keepId ? "Client ID (Enter keeps the saved one): " : "Client ID: ", (a) => (keepId && !a) || looksLikeClientId(a) ? null : "That is not a Client ID. It looks like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.");
    clientId = idAnswer || cur.SNAP_CLIENT_ID;
    if (clientId !== cur.SNAP_CLIENT_ID) setEnvValue("SNAP_CLIENT_ID", clientId, file);

    const keepSecret = Boolean(cur.SNAP_CLIENT_SECRET) && !secretProblems(cur.SNAP_CLIENT_SECRET).length && clientId === cur.SNAP_CLIENT_ID;
    secret = null;
    for (let i = 0; i < 5 && secret === null; i++) {
      const a = await io.askSecret(keepSecret ? "Client Secret (hidden; Enter keeps the saved one): " : "Client Secret (hidden while you type or paste): ");
      if (!a && keepSecret) secret = cur.SNAP_CLIENT_SECRET;
      else if (secretProblems(a).length) say(`  That does not look like a secret: ${secretProblems(a).join(", ")}. Copy it again.`);
      else secret = a;
    }
    if (secret === null) throw new Error("No valid secret was entered.");
    if (secret !== cur.SNAP_CLIENT_SECRET) setEnvValue("SNAP_CLIENT_SECRET", secret, file);
    const redirectUri = cur.SNAP_REDIRECT_URI || DEFAULT_REDIRECT;
    if (!cur.SNAP_REDIRECT_URI) setEnvValue("SNAP_REDIRECT_URI", redirectUri, file);
    say("  Saved.");
    say("");

    // 2. Authorize
    say("STEP 2 of 5: approve access in the browser");
    token = null;
    for (let i = 0; i < 3 && !token; i++) {
      const state = newState();
      const url = authorizeUrl({ clientId, redirectUri, state });
      const opened = open(url);
      say(opened ? "  Your browser opened. Log in to Snapchat and click Continue." : "  Open this link, log in to Snapchat and click Continue:");
      if (!opened) say(`  ${url}`);
      say("  The browser then shows an error page ('can't connect' is normal). Copy the whole address from its address bar.");
      const pasted = await io.ask("Paste that address here: ");
      try {
        token = await exchangeCode({ clientId, clientSecret: secret, redirectUri, code: extractCode(pasted, state), fetchImpl });
      } catch (e) {
        say(`  ${e.message}`);
      }
    }
    if (!token) throw new Error("Could not connect. Check the Redirect URI on the OAuth app is exactly " + redirectUri + ", then run setup again.");
    setEnvValue("SNAP_REFRESH_TOKEN", token, file);
    say("  Connected. Access saved on this computer only.");
    say("");

  }

  // 3. Ad account
  say("STEP 3 of 5: choose the ad account");
  const client = new SnapClient({ env: shared ? { SNAP_REFRESH_TOKEN: token, SNAP_BROKER_URL: brokerUrl } : { SNAP_CLIENT_ID: clientId, SNAP_CLIENT_SECRET: secret, SNAP_REFRESH_TOKEN: token }, fetchImpl });
  const me = (await client.request("GET", "/me")).me ?? {};
  say(`  Logged in as ${me.display_name ?? me.email ?? "your Snapchat login"}.`);
  const accounts = await listAdAccounts(client);
  if (!accounts.length) throw new Error("This login cannot see any ad account. Ask the account's admin to add you, then run setup again.");
  accounts.forEach((a, i) => say(`  ${String(i + 1).padStart(2)}. ${a.name} (${a.organization}, ${a.status}, ${a.currency})`));
  const pick = await askUntil(io, `Number of the ad account (1-${accounts.length}): `, (a) => (Number.isInteger(Number(a)) && Number(a) >= 1 && Number(a) <= accounts.length ? null : `Type a number from 1 to ${accounts.length}.`));
  const chosen = accounts[Number(pick) - 1];
  if (chosen.id !== cur.SNAP_AD_ACCOUNT_ID) {
    setEnvValue("SNAP_AD_ACCOUNT_ID", chosen.id, file);
    // A pixel or brand profile from another account must never be used on this one.
    if (cur.SNAP_AD_ACCOUNT_ID && cur.SNAP_PIXEL_ID) setEnvValue("SNAP_PIXEL_ID", "", file);
    if (cur.SNAP_AD_ACCOUNT_ID && cur.SNAP_BRAND_PROFILE_ID) setEnvValue("SNAP_BRAND_PROFILE_ID", "", file);
  }
  if (chosen.currency && /^[A-Z]{3}$/.test(chosen.currency)) setEnvValue("SNAP_ACCOUNT_CURRENCY", chosen.currency, file);
  say(`  Using ${chosen.name}.`);
  say("");

  // 4. Safety
  cur = readSettings(file);
  say("STEP 4 of 5: safety settings (Enter keeps the value in brackets)");
  const budget = await askUntil(io, `  Highest daily budget the AI may set, in ${chosen.currency ?? "account currency"} [${cur.SNAP_MAX_DAILY_BUDGET || 1000}]: `, (a) => (!a || (/^\d+(\.\d+)?$/.test(a) && Number(a) > 0) ? null : "A plain number, such as 300."));
  if (budget) setEnvValue("SNAP_MAX_DAILY_BUDGET", budget, file);
  const country = await askUntil(io, `  Main country, 2 letters such as us, sa, ae (Enter to skip) [${cur.SNAP_DEFAULT_COUNTRY || ""}]: `, (a) => (!a || /^[a-z]{2}$/i.test(a) ? null : "Two letters, such as us."));
  if (country) setEnvValue("SNAP_DEFAULT_COUNTRY", country.toLowerCase(), file);
  const ro = await io.ask("  Start in read-only mode, so nothing can be changed until you are ready? [Y/n]: ");
  setEnvValue("SNAP_READ_ONLY", /^n/i.test(ro) ? "0" : "1", file);
  say("  Saved.");
  say("");

  // 5. Register
  say("STEP 5 of 5: add it to your AI app");
  const launch = launchCommand(root);
  const defaultFile = join(dataDir({ root }), ".env");
  const envArgs = file === defaultFile ? [] : ["-e", `SNAP_ENV_FILE=${file}`];
  const name = (await io.ask("  Name for this server in Claude [snapchat-ads]: ")) || "snapchat-ads";
  let registered = false;
  if (claudeAvailable(exec)) {
    try {
      // The server name must come before -e: -e takes every value after it.
      exec("claude", ["mcp", "add", "--scope", "user", name, ...envArgs, "--", launch.command, ...launch.args], { stdio: "ignore" });
      registered = true;
      say(`  Added to Claude Code as "${name}". Restart Claude Code, then ask: "call ${name} snap_ping".`);
    } catch {
      say(`  Claude Code did not accept it (maybe "${name}" exists already: claude mcp remove ${name}).`);
    }
  }
  if (!registered) {
    const quoted = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
    say("  Claude Code, run:");
    say(`    claude mcp add --scope user ${name} ${envArgs.map(quoted).join(" ")} -- ${[launch.command, ...launch.args].map(quoted).join(" ")}`.replace(/  +/g, " "));
  }
  const desktop = { mcpServers: { [name]: { command: launch.command, args: launch.args, ...(envArgs.length ? { env: { SNAP_ENV_FILE: file } } : {}) } } };
  say("  Claude Desktop, Cursor or VS Code: add this to the MCP settings:");
  say(JSON.stringify(desktop, null, 2).split("\n").map((l) => `    ${l}`).join("\n"));
  say("");
  say(`Done. ${/^n/i.test(ro) ? "Changes are allowed; every change still needs your approval." : "Read-only for now: set SNAP_READ_ONLY=0 in the settings file when you want changes."}`);
  say("For another ad account: npx -y ads-mcp-for-snapchat setup --file ~/.ads-mcp-for-snapchat/.env.account2");
  return { file, account: chosen, registered, name };
}

// For the CLI: `setup [--file PATH]`.
export async function setupCommand(args) {
  const i = args.indexOf("--file");
  const file = i >= 0 && args[i + 1] ? args[i + 1].replace(/^~(?=$|[\\/])/, process.env.HOME ?? "~") : envFile();
  const io = terminalIO();
  try {
    await runSetup({ io, file });
  } catch (e) {
    io.print(`\nSetup stopped: ${e.message}`);
    process.exitCode = 1;
  } finally {
    io.close();
  }
}
