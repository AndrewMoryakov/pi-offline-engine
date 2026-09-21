#!/usr/bin/env node
// Loads this repository's extension through the installed pi runtime, without
// an LLM request, and asserts pi actually registered its commands.
//
// This previously ran `pi --list-models`, which exits 0 even when an extension
// throws during load, so it could never fail. RPC mode exits 1 on a load error
// and reports registered commands, so both failure shapes are observable.
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandNames, extensionErrors, runPiRpc, runPiSync } from "./lib/pi-rpc.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_COMMANDS = ["offline-setup", "offline-doctor", "offline-status"];

const version = runPiSync(["--version"], { cwd: repoRoot });
if (version.error || version.status !== 0) {
  const reason = version.error ? version.error.message : `exit ${String(version.status)}`;
  process.stderr.write(`PI LOAD GATE: FAIL - pi could not start (${reason}).\n`);
  process.exit(2);
}
process.stdout.write(`Pi: ${String(version.stdout || version.stderr).trim()}\n`);

const result = await runPiRpc({
  cwd: repoRoot,
  args: [
    "--no-session",
    "--no-extensions",
    "-e", "./extensions/index.ts",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files"
  ],
  requests: [{ type: "get_commands" }],
  until: (events) => commandNames(events) !== null
});

const names = commandNames(result.events);
const errors = extensionErrors(result.events);
const missing = names ? REQUIRED_COMMANDS.filter((name) => !names.includes(name)) : REQUIRED_COMMANDS;

if (!names || missing.length > 0 || errors.length > 0) {
  process.stderr.write("PI LOAD GATE: FAIL\n");
  if (result.timedOut) process.stderr.write("  pi did not answer get_commands before the timeout\n");
  if (result.exitCode !== null) process.stderr.write(`  pi exited with ${String(result.exitCode)}\n`);
  if (missing.length > 0) process.stderr.write(`  missing commands: ${missing.join(", ")}\n`);
  for (const error of errors) process.stderr.write(`  extension_error: ${error.error}\n`);
  if (result.stderr.trim()) process.stderr.write(`  stderr: ${result.stderr.trim()}\n`);
  process.exit(1);
}

process.stdout.write(`Registered: ${REQUIRED_COMMANDS.join(", ")}\n`);
process.stdout.write("PI LOAD GATE: PASS\n");
