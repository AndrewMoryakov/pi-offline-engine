#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const node = process.execPath;
const steps = [
  {
    name: "unit tests",
    command: node,
    args: ["--test"]
  },
  {
    name: "runtime syntax",
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "check"]
  },
  {
    name: "extension syntax",
    command: node,
    args: ["--experimental-strip-types", "--check", "extensions/index.ts"]
  },
  {
    name: "offline profile dry-run",
    command: node,
    args: ["scripts/bootstrap-offline-profile.mjs"]
  },
  {
    name: "transport smoke",
    command: node,
    args: ["scripts/smoke-tiny-transport.mjs"]
  }
];

let failed = false;
for (const step of steps) {
  process.stdout.write(`\n==> ${step.name}\n`);
  const result = spawnSync(step.command, step.args, {
    stdio: "inherit",
    env: process.env
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`FAILED: ${step.name} (exit ${String(result.status)})\n`);
    break;
  }
}

if (failed) process.exit(1);
process.stdout.write("\nLOCAL GATE: PASS\n");
