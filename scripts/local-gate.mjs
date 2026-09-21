#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const node = process.execPath;
// Resolve the repo root from this file, not from the ambient cwd: every step
// below runs against it, so the gate behaves identically from any directory.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = (name) => path.join(repoRoot, "scripts", name);

const steps = [
  {
    // Spawned directly instead of through `npm run check` (the npm script is a
    // thin wrapper around the same command): spawning `npm.cmd` without a shell
    // fails with EINVAL on Node >= 18.20/20.12/22, which aborted the whole gate.
    name: "repository syntax",
    command: node,
    args: [script("check-syntax.mjs")]
  },
  {
    name: "unit tests",
    command: node,
    args: ["--test"]
  },
  {
    name: "offline profile dry-run",
    command: node,
    args: [script("bootstrap-offline-profile.mjs")]
  },
  {
    name: "transport smoke",
    command: node,
    args: [script("smoke-tiny-transport.mjs")]
  }
];

let failed = false;
for (const step of steps) {
  process.stdout.write(`\n==> ${step.name}\n`);
  const result = spawnSync(step.command, step.args, {
    stdio: "inherit",
    env: process.env,
    cwd: repoRoot
  });
  // A step that never started reports `status: null` plus an `error`. Without
  // this branch a spawn failure was indistinguishable from a failing test.
  if (result.error) {
    failed = true;
    process.stderr.write(`FAILED: ${step.name} (could not run: ${result.error.message})\n`);
    break;
  }
  if (result.signal) {
    failed = true;
    process.stderr.write(`FAILED: ${step.name} (killed by ${result.signal})\n`);
    break;
  }
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`FAILED: ${step.name} (exit ${String(result.status)})\n`);
    break;
  }
}

if (failed) process.exit(1);
process.stdout.write("\nLOCAL GATE: PASS\n");
