#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const pi = process.platform === "win32" ? "pi.cmd" : "pi";

const version = spawnSync(pi, ["--version"], { encoding: "utf8" });
if (version.status !== 0) {
  process.stderr.write("PI LOAD GATE: FAIL - pi executable was not found or could not start.\n");
  process.exit(2);
}

process.stdout.write(`Pi: ${String(version.stdout || version.stderr).trim()}\n`);

const args = [
  "--no-extensions",
  "-e", "./extensions/index.ts",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-session",
  "--list-models"
];

const load = spawnSync(pi, args, {
  stdio: "inherit",
  env: process.env
});

if (load.status !== 0) {
  process.stderr.write(`PI LOAD GATE: FAIL (exit ${String(load.status)})\n`);
  process.exit(load.status ?? 1);
}

process.stdout.write("PI LOAD GATE: PASS\n");
