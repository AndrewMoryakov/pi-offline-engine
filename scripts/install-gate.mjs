#!/usr/bin/env node
// End-to-end check of the turnkey install path, without touching ~/.pi.
//
//   1. stage this working tree the way `git clone` would see it
//   2. run exactly what pi runs for a git package: `npm install --omit=dev`
//   3. check every extension listed in the package manifest exists on disk
//   4. `pi install <staged dir>` into a throwaway PI_CODING_AGENT_DIR
//   5. start pi in RPC mode with that agent dir, run /offline-doctor and
//      assert the engine and the bundled companion tools actually loaded
//
// The npm step is not time-bounded: its duration depends on the network and on
// native prebuild downloads. Its raw output goes to a log file whose path is
// printed first, so progress can be followed while it runs.
//
// Options:
//   --package-dir <dir>  reuse an already staged and npm-installed package
//   --keep               keep the temporary directory for inspection
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { commandNames, extensionErrors, notifications, runPiRpc, runPiSync, shellArg } from "./lib/pi-rpc.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const packageDirIndex = argv.indexOf("--package-dir");
const reusedPackageDir = packageDirIndex >= 0 ? path.resolve(argv[packageDirIndex + 1] ?? "") : null;

const REQUIRED_COMMANDS = ["offline-setup", "offline-doctor", "offline-status"];
// Doctor lines that prove each bundled companion extension registered its tools.
const REQUIRED_DOCTOR_LINES = [
  { label: "pi-knowledge", pattern: /^✓ tool:knowledge_search:/m },
  { label: "pi-lsp-extension", pattern: /^✓ tool:lsp_diagnostics:/m },
  { label: "pi-code-tool", pattern: /^✓ tool:code:/m },
  { label: "pi-lean-edit", pattern: /^✓ edit_provider:.*pi-lean-edit/m }
];

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-offline-install-gate-"));
const failures = [];
const step = (text) => process.stdout.write(`\n==> ${text}\n`);

try {
  const packageDir = reusedPackageDir ?? stagePackage(path.join(workRoot, "pi-offline-engine"));

  if (!reusedPackageDir) {
    step("npm install --omit=dev (what pi runs for git packages)");
    const log = path.join(workRoot, "npm-install.log");
    process.stdout.write(`log: ${log}\n`);
    const code = await runLogged(isWindows ? "npm.cmd" : "npm", ["install", "--omit=dev"], packageDir, log);
    if (code !== 0) throw new Error(`npm install exited with ${String(code)}; see ${log}`);
  } else {
    step(`reusing installed package at ${packageDir}`);
  }

  step("manifest extensions present on disk");
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  for (const entry of manifest.pi?.extensions ?? []) {
    const present = fs.existsSync(path.join(packageDir, entry));
    process.stdout.write(`  ${present ? "✓" : "✗"} ${entry}\n`);
    if (!present) failures.push(`manifest extension missing after install: ${entry}`);
  }
  if (failures.length > 0) throw new Error("installed package is incomplete");

  const agentDir = path.join(workRoot, "agent");
  const projectDir = path.join(workRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  const env = isolatedEnv(agentDir);

  step("pi install <package> into an isolated agent dir");
  const install = runPiSync(["install", packageDir], { cwd: projectDir, env });
  if (install.error || install.status !== 0) {
    throw new Error(`pi install failed: ${install.error?.message ?? `exit ${install.status}`}\n${install.stdout}${install.stderr}`);
  }
  const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  process.stdout.write(`  settings.packages: ${JSON.stringify(settings.packages)}\n`);

  step("load through pi (RPC) and run /offline-doctor");
  const result = await runPiRpc({
    cwd: projectDir,
    env,
    args: ["--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"],
    requests: [
      { type: "get_commands" },
      { id: "doctor", type: "prompt", message: "/offline-doctor" }
    ],
    until: (events) => notifications(events).some((n) => n.message.includes("OFFLINE READY:")),
    timeoutMs: 300_000
  });

  const names = commandNames(result.events);
  if (!names) failures.push("pi never answered get_commands");
  else {
    const missing = REQUIRED_COMMANDS.filter((name) => !names.includes(name));
    if (missing.length > 0) failures.push(`missing engine commands: ${missing.join(", ")}`);
  }
  for (const error of extensionErrors(result.events)) {
    failures.push(`extension_error in ${error.extensionPath}: ${error.error}`);
  }

  const doctor = notifications(result.events).find((n) => n.message.includes("OFFLINE READY:"));
  if (!doctor) {
    failures.push(result.timedOut ? "/offline-doctor produced no report before the timeout" : "/offline-doctor produced no report");
  } else {
    process.stdout.write(doctor.message.split("\n").map((line) => `  ${line}`).join("\n") + "\n");
    for (const { label, pattern } of REQUIRED_DOCTOR_LINES) {
      if (!pattern.test(doctor.message)) failures.push(`${label}: its tool is not active in the loaded session`);
    }
  }

  for (const note of notifications(result.events).filter((n) => !n.message.includes("OFFLINE READY:"))) {
    process.stdout.write(`  notify(${note.level}): ${note.message}\n`);
  }
  if (result.exitCode !== null && failures.length > 0) {
    failures.push(`pi exited with ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  if (keep || failures.length > 0) process.stdout.write(`\nWork dir kept: ${workRoot}\n`);
  else fs.rmSync(workRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(`\nINSTALL GATE: FAIL\n${failures.map((x) => `  - ${x}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("\nINSTALL GATE: PASS\n");

function stagePackage(target) {
  step("stage working tree as a clone would see it");
  const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: repoRoot, encoding: "utf8" });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const files = listed.stdout.split("\0").filter(Boolean);
  for (const file of files) {
    const from = path.join(repoRoot, file);
    if (!fs.existsSync(from)) continue;
    const to = path.join(target, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  process.stdout.write(`  ${files.length} files -> ${target}\n`);
  return target;
}

// A throwaway agent dir plus no inherited engine settings, so the result does
// not depend on the developer's own ~/.pi or exported PI_OFFLINE_* variables.
function isolatedEnv(agentDir) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_OFFLINE_")) delete env[key];
  }
  return env;
}

function runLogged(command, args, cwd, logFile) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, "w");
    const child = spawn(command, isWindows ? args.map(shellArg) : args, {
      cwd,
      shell: isWindows,
      stdio: ["ignore", out, out]
    });
    child.on("error", (error) => {
      fs.appendFileSync(logFile, `\nspawn error: ${error.message}\n`);
      resolve(null);
    });
    child.on("exit", (code) => {
      fs.closeSync(out);
      resolve(code);
    });
  });
}
