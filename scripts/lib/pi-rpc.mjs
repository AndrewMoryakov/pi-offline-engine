import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";

// Resolve the host under test from this repository, even when a gate is run
// directly or from an isolated staging cwd. PATH may contain a different Pi.
// Use its declared bin through Node: no Windows .cmd shim or shell is needed.
function piInvocation(args) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return { command: process.execPath, args: [path.resolve(root, manifest.bin.pi), ...args] };
}

export function shellArg(value) {
  if (!isWindows) return value;
  return /[\s"&|<>^()]/.test(value) ? `"${String(value).replace(/"/g, '""')}"` : value;
}

export function commandInvocation(command, args = []) {
  if (!isWindows) return { command, args };
  const line = [command, ...args].map(shellArg).join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", line]
  };
}

export function runPiSync(args, options = {}) {
  const invocation = piInvocation(args);
  return spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    ...options
  });
}

// Drives `pi --mode rpc`: writes JSONL requests, collects JSON events from
// stdout, and stops once `until(events)` holds, the process exits, or the
// bounded timeout elapses (pi startup is measured in seconds; a hang is a
// failure, not a slow success).
export function runPiRpc({ args = [], requests = [], until, cwd, env = process.env, timeoutMs = 120_000 }) {
  return new Promise((resolve) => {
    const fullArgs = ["--mode", "rpc", ...args];
    const invocation = piInvocation(fullArgs);
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const events = [];
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      resolve({ events, stderr, exitCode, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      finish(null);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          events.push({ type: "raw", line });
        }
      }
      if (until && until(events)) finish(null);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      stderr += `\nspawn error: ${error.message}`;
      finish(null);
    });
    child.on("exit", (code) => finish(code));

    for (const request of requests) child.stdin.write(JSON.stringify(request) + "\n");
  });
}

// Pi may start worker/companion processes; stop the whole tree on Windows so
// gates do not leave those children behind.
function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

export function commandNames(events) {
  const response = events.find((e) => e.type === "response" && e.command === "get_commands");
  return response?.success ? (response.data?.commands ?? []).map((c) => c.name) : null;
}

export function notifications(events) {
  return events
    .filter((e) => e.type === "extension_ui_request" && e.method === "notify")
    .map((e) => ({ message: String(e.message ?? ""), level: e.notifyType ?? "info" }));
}

export function extensionErrors(events) {
  return events.filter((e) => e.type === "extension_error");
}
