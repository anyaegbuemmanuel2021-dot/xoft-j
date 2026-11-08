#!/usr/bin/env node
// blitz: manage your blitz.cloud apps from a terminal.
//
// One file, no dependencies, Node.js 18 or newer. It talks to the same MCP
// server AI assistants use (https://mcp.blitz.cloud) with an API key from the
// AI tools page, so it can do what the tools there do, with the same limits.
//
// Install:
//   curl -fsSL https://blitz.cloud/cli/blitz.js -o ~/.local/bin/blitz
//   chmod +x ~/.local/bin/blitz
//   blitz login
//
// Run `blitz help` for the commands. Docs: https://blitz.cloud/docs/cli/
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const VERSION = "1.0.0";
const DEFAULT_URL = "https://mcp.blitz.cloud/cli";
const PROTOCOL = "2025-06-18";

const HELP = `blitz ${VERSION}: manage your blitz.cloud apps from a terminal.

Usage: blitz <command> [arguments] [options]

Account
  login                         Save an API key from the AI tools page
  logout                        Forget the saved key
  usage                         Your plan and how much of it is used
  status                        Whether blitz.cloud itself has a problem

Apps
  apps                          List your apps
  app <app>                     Everything about one app
  deploy store <id>             Install an app from the App Store
  deploy image <image>          Put a public container image online
  deploy github <owner/name>    Build and put a GitHub project online
  rebuild <app>                 Build a GitHub app again from its newest commit
  builds <app>                  Its builds, newest first, and why one failed
  restart <app>                 Restart an app (asks first)
  pause <app>                   Take an app offline until you resume it (asks first)
  resume <app>                  Start a paused app again
  logs <app>                    The last lines an app printed

Settings
  env <app>                     An app's settings, values hidden
  env get <app> <NAME>          One value in the clear
  env set <app> <NAME> <value>  Add or change a setting (the app restarts)
  env unset <app> <NAME>        Remove a setting (asks first)

Anything else
  tools                         Every tool the server offers
  call <tool> [json]            Call one tool with JSON arguments

<app> is the app's name, its address label or its id.

Options
  --address <label>   deploy: the sub-address, e.g. status for status.<you>.blitz.cloud
  --name <name>       deploy: a display name
  --main              deploy store: put it on your main address
  --tag <tag>         deploy image: the tag (latest when left out)
  --port <port>       deploy image: the port the app listens on
  --worker            deploy image: runs in the background, with no address
  --branch <branch>   deploy github: the branch (the default one when left out)
  --folder <folder>   deploy github: build only this folder of the project
  --dockerfile <path> deploy github: a Dockerfile's path (auto when left out)
  --lines <n>         logs: how many lines, at most 500 (100 when left out)
  --previous          logs: what it printed before its last restart
  --part <part>       logs: which part, for an app of several parts
  --yes, -y           do not ask before restart, pause or env unset
  --json              print the server's answer as JSON
  --key <key>         use this API key (or set BLITZ_API_KEY)
  --url <url>         the MCP server (or set BLITZ_MCP_URL)
`;

const BOOLEAN_FLAGS = new Set(["main", "worker", "previous", "yes", "json", "help", "version"]);
const SHORT_FLAGS = { y: "yes", h: "help", v: "version" };

class CliError extends Error {}

/** Splits argv into positional words and options; `--a b`, `--a=b` and boolean flags. */
function parseArgs(argv) {
  const words = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      if (eq >= 0) {
        options[name] = arg.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(name)) {
        options[name] = true;
      } else if (i + 1 < argv.length) {
        options[name] = argv[++i];
      } else {
        throw new CliError(`--${name} needs a value.`);
      }
    } else if (arg.length > 1 && arg.startsWith("-") && SHORT_FLAGS[arg.slice(1)]) {
      options[SHORT_FLAGS[arg.slice(1)]] = true;
    } else {
      words.push(arg);
    }
  }
  return { words, options };
}

function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "blitz", "config.json");
}

function readConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * The JSON-RPC message with the given id out of an answer that is either
 * plain JSON or a server-sent event stream (the server may send other
 * messages before the one we asked for).
 */
function parseAnswer(body, id) {
  const text = body.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    const parsed = JSON.parse(text);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.find((m) => m.id === id) || messages[messages.length - 1];
  }
  let found = null;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      continue;
    }
    if (message.id === id) return message;
    found = message;
  }
  if (found) return found;
  throw new CliError("The server sent an answer this tool cannot read.");
}

/** Just enough MCP over streamable HTTP: initialize, a session, tool calls. */
class McpClient {
  constructor(url, key, fetchImpl = globalThis.fetch) {
    this.url = url;
    this.key = key;
    this.fetch = fetchImpl;
    this.session = null;
    this.nextId = 1;
  }

  async post(body) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.key}`,
      "User-Agent": `blitz-cli/${VERSION}`,
    };
    if (this.session) {
      headers["Mcp-Session-Id"] = this.session;
      headers["Mcp-Protocol-Version"] = PROTOCOL;
    }
    let response;
    try {
      response = await this.fetch(this.url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new CliError(`Could not reach ${this.url}: ${e.cause?.message || e.message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new CliError(
        "The API key was refused. Make a new one on https://dashboard.blitz.cloud/ai and run blitz login.",
      );
    }
    if (response.status === 429) {
      const wait = response.headers.get("retry-after");
      throw new CliError(`Too many requests. Try again${wait ? ` in ${wait} seconds` : " in a minute"}.`);
    }
    if (!response.ok) {
      throw new CliError(`The server answered ${response.status}. Try again in a moment.`);
    }
    return response;
  }

  async request(method, params) {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    const message = parseAnswer(await response.text(), id);
    if (message.error) {
      throw new CliError(message.error.message || "The server refused the request.");
    }
    return { message, response };
  }

  async connect() {
    const { response } = await this.request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "blitz-cli", version: VERSION },
    });
    this.session = response.headers.get("mcp-session-id");
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools() {
    const { message } = await this.request("tools/list", {});
    return message.result.tools;
  }

  /** The tool's answer as text; a refusal becomes a CliError with the server's sentence. */
  async call(name, args) {
    const { message } = await this.request("tools/call", { name, arguments: args });
    const result = message.result || {};
    const text = (result.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (result.isError) throw new CliError(text || `${name} failed.`);
    return text;
  }

  async close() {
    if (!this.session) return;
    try {
      await this.fetch(this.url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.key}`, "Mcp-Session-Id": this.session },
      });
    } catch {
      // The session runs out on its own.
    }
  }
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function table(rows) {
  if (rows.length === 0) return "";
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? "").length)));
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i === r.length - 1 ? String(cell ?? "") : String(cell ?? "").padEnd(widths[i])))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function describeApp(app) {
  const lines = [`${app.name}: ${app.statusLabel || app.status || app.desiredState || "unknown"}`];
  if (app.url) lines.push(`  ${app.url}`);
  if (app.message) lines.push(`  ${app.message}`);
  if (app.runsFrom) lines.push(`  runs ${app.runsFrom}`);
  return lines.join("\n");
}

/** How a tool's answer is printed unless --json asks for the raw answer. */
const FORMATS = {
  apps_list(value) {
    if (!Array.isArray(value)) return undefined;
    if (value.length === 0) return "No apps yet. Put one online with blitz deploy.";
    return table([
      ["NAME", "STATUS", "ADDRESS"],
      ...value.map((a) => [a.name, a.statusLabel || a.status, a.url || a.address || ""]),
    ]);
  },
  logs_tail(value) {
    if (!Array.isArray(value)) return undefined;
    return value.length === 0 ? "The app printed nothing yet." : value.join("\n");
  },
  builds_list(value) {
    if (!Array.isArray(value)) return undefined;
    if (value.length === 0) return "No builds yet.";
    return table([
      ["STATE", "COMMIT", "QUEUED", "PROBLEM"],
      ...value.map((b) => [b.state, b.commit || "", b.queuedAt || "", b.problem || ""]),
    ]);
  },
  env_list(value) {
    if (!Array.isArray(value)) return undefined;
    if (value.length === 0) return "No settings.";
    return value.map((e) => e.name ?? e.key ?? JSON.stringify(e)).join("\n");
  },
};

function render(tool, text, json) {
  const value = tryJson(text);
  if (json) return value === undefined ? JSON.stringify(text) : JSON.stringify(value, null, 2);
  if (value === undefined) return text;
  const format = FORMATS[tool];
  const formatted = format && format(value);
  if (formatted !== undefined) return formatted;
  if (value && typeof value === "object" && !Array.isArray(value) && "statusLabel" in value && "name" in value) {
    return describeApp(value);
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function need(words, index, what) {
  if (words[index] === undefined) throw new CliError(`Missing ${what}. See blitz help.`);
  return words[index];
}

function number(value, flag) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new CliError(`--${flag} needs a whole number.`);
  return n;
}

/** Drops the options that were not given, so the server uses its own defaults. */
function compact(args) {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}

/**
 * The tool call a command stands for: { tool, args, confirm } where confirm
 * is the question to ask before a destructive call, or a local command name.
 */
function plan(words, o) {
  const [command] = words;
  switch (command) {
    case "apps":
      return { tool: "apps_list", args: {} };
    case "app":
      return { tool: "apps_get", args: { app: need(words, 1, "the app") } };
    case "usage":
      return { tool: "usage_get", args: {} };
    case "status":
      return { tool: "platform_status", args: {} };
    case "deploy": {
      const kind = need(words, 1, "what to deploy (store, image or github)");
      const what = need(words, 2, kind === "store" ? "the App Store id" : kind === "image" ? "the image" : "the project");
      if (kind === "store") {
        return {
          tool: "apps_deploy_store",
          args: compact({ catalogId: what, address: o.address, name: o.name, onMainAddress: o.main ? true : undefined }),
        };
      }
      if (kind === "image") {
        return {
          tool: "apps_deploy_image",
          args: compact({
            image: what,
            tag: o.tag,
            address: o.address,
            name: o.name,
            port: number(o.port, "port"),
            worker: o.worker ? true : undefined,
          }),
        };
      }
      if (kind === "github") {
        return {
          tool: "apps_deploy_github",
          args: compact({
            repo: what,
            branch: o.branch,
            address: o.address,
            name: o.name,
            dockerfile: o.dockerfile,
            folder: o.folder,
          }),
        };
      }
      throw new CliError(`blitz deploy ${kind} is not a thing. Use store, image or github.`);
    }
    case "rebuild":
      return { tool: "builds_start", args: { app: need(words, 1, "the app") } };
    case "builds":
      return { tool: "builds_list", args: { app: need(words, 1, "the app") } };
    case "restart": {
      const app = need(words, 1, "the app");
      return { tool: "apps_restart", args: { app }, confirm: `Restart ${app}? Visitors see a short gap.` };
    }
    case "pause": {
      const app = need(words, 1, "the app");
      return { tool: "apps_pause", args: { app }, confirm: `Pause ${app}? It stays offline until you resume it.` };
    }
    case "resume":
      return { tool: "apps_resume", args: { app: need(words, 1, "the app") } };
    case "logs":
      return {
        tool: "logs_tail",
        args: compact({
          app: need(words, 1, "the app"),
          lines: number(o.lines, "lines"),
          previous: o.previous ? true : undefined,
          part: o.part,
        }),
      };
    case "env": {
      const sub = words[1];
      if (sub === "get") {
        return { tool: "env_get", args: { app: need(words, 2, "the app"), name: need(words, 3, "the setting's name") } };
      }
      if (sub === "set") {
        const app = need(words, 2, "the app");
        const pair = need(words, 3, "the setting's name");
        // Both `set app NAME value` and `set app NAME=value` work.
        const eq = pair.indexOf("=");
        if (words[4] === undefined && eq > 0) {
          return { tool: "env_set", args: { app, name: pair.slice(0, eq), value: pair.slice(eq + 1) } };
        }
        return { tool: "env_set", args: { app, name: pair, value: need(words, 4, "the value") } };
      }
      if (sub === "unset") {
        const app = need(words, 2, "the app");
        const name = need(words, 3, "the setting's name");
        return { tool: "env_delete", args: { app, name }, confirm: `Remove ${name} from ${app}? The app restarts.` };
      }
      return { tool: "env_list", args: { app: need(words, 1, "the app") } };
    }
    case "call": {
      const tool = need(words, 1, "the tool's name");
      let args = {};
      if (words[2] !== undefined) {
        args = tryJson(words[2]);
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          throw new CliError('The arguments must be a JSON object, like \'{"app": "blog"}\'.');
        }
      }
      return { tool, args };
    }
    case "tools":
    case "login":
    case "logout":
      return { local: command };
    default:
      throw new CliError(`blitz ${command} is not a command. See blitz help.`);
  }
}

async function ask(question, io) {
  const rl = readline.createInterface({ input: io.stdin, output: io.stderr, terminal: false });
  try {
    io.stderr.write(question);
    const line = await new Promise((resolve) => {
      rl.once("line", resolve);
      rl.once("close", () => resolve(""));
    });
    return String(line).trim();
  } finally {
    rl.close();
  }
}

/** Runs one command; returns the exit code. io and fetch are replaceable for tests. */
async function main(argv, io = {}) {
  io = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    fetch: globalThis.fetch,
    ...io,
  };
  const out = (s) => s && io.stdout.write(s.endsWith("\n") ? s : s + "\n");
  let client;
  try {
    const { words, options } = parseArgs(argv);
    if (options.version) {
      out(VERSION);
      return 0;
    }
    if (options.help || words.length === 0 || words[0] === "help") {
      out(HELP);
      return 0;
    }
    if (typeof io.fetch !== "function") {
      throw new CliError("blitz needs Node.js 18 or newer.");
    }
    const step = plan(words, options);
    const file = configPath(io.env);
    const config = readConfig(file);
    const url = options.url || io.env.BLITZ_MCP_URL || config.url || DEFAULT_URL;

    if (step.local === "logout") {
      if (fs.existsSync(file)) fs.rmSync(file);
      out("The saved key is gone from this computer. It still works until you revoke it on the AI tools page.");
      return 0;
    }
    if (step.local === "login") {
      const key =
        options.key || (await ask("Paste an API key from https://dashboard.blitz.cloud/ai (AI tools, Make a key): ", io));
      if (!key) throw new CliError("No key given, nothing was saved.");
      client = new McpClient(url, key, io.fetch);
      await client.connect();
      const usage = tryJson(await client.call("usage_get", {}));
      writeConfig(file, compact({ key, url: url === DEFAULT_URL ? undefined : url }));
      out(`The key works${usage && usage.plan ? ` (plan: ${usage.plan})` : ""}. Saved in ${file}.`);
      return 0;
    }

    const key = options.key || io.env.BLITZ_API_KEY || config.key;
    if (!key) {
      throw new CliError("No API key yet. Run blitz login, or set BLITZ_API_KEY.");
    }
    client = new McpClient(url, key, io.fetch);
    await client.connect();

    if (step.local === "tools") {
      const tools = await client.listTools();
      out(
        options.json
          ? JSON.stringify(tools, null, 2)
          : table(tools.map((t) => [t.name, (t.description || "").split(". ")[0]])),
      );
      return 0;
    }

    const args = { ...step.args };
    if (step.confirm) {
      if (!options.yes) {
        const answer = await ask(`${step.confirm} [y/N] `, io);
        if (!/^y(es)?$/i.test(answer)) {
          out("Nothing was changed.");
          return 1;
        }
      }
      args.confirm = true;
    }
    out(render(step.tool, await client.call(step.tool, args), options.json));
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      io.stderr.write(e.message + "\n");
      return 1;
    }
    throw e;
  } finally {
    if (client) await client.close();
  }
}

module.exports = { main, parseArgs, parseAnswer, plan, render, configPath, McpClient, VERSION };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`Something went wrong: ${e.stack || e}\n`);
      process.exitCode = 1;
    },
  );
}
