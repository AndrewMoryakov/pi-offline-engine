import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const isWindows = process.platform === "win32";

// `pi.cmd` is a batch shim; since the CVE-2024-27980 fix Node refuses to spawn
// .cmd/.bat directly (EINVAL). Invoke cmd.exe explicitly rather than using
// `shell: true`: this avoids Node's unsafe implicit argument concatenation and
// keeps the command construction in one reviewed helper.
export function piCommand() {
  return isWindows ? "pi.cmd" : "pi";
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
  const invocation = commandInvocation(piCommand(), args);
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
    const invocation = commandInvocation(piCommand(), fullArgs);
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

// With `shell: true`, child.kill() stops cmd.exe but not the node process
// running pi underneath; kill the whole tree so gates leave no orphans.
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
