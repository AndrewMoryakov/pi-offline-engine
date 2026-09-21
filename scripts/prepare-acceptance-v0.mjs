#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ACCEPTANCE_MARKER, prepareAcceptanceOutputDirectory } from "../src/acceptance-output.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(root, "fixtures", "dotnet-boundary-v0");

const args = process.argv.slice(2);
const restore = args.includes("--restore");
const outIndex = args.indexOf("--out");
const output = outIndex >= 0 && args[outIndex + 1]
  ? path.resolve(args[outIndex + 1])
  : path.join(os.tmpdir(), "pi-offline-acceptance-v0");

await prepareAcceptanceOutputDirectory({ output, cwd: process.cwd(), repoRoot: root });
await fs.cp(template, output, { recursive: true });
await fs.writeFile(path.join(output, ACCEPTANCE_MARKER), "v0\n", "utf8");

run("git", ["init"], output);
run("git", ["config", "user.email", "pi-offline-acceptance@example.invalid"], output);
run("git", ["config", "user.name", "pi-offline acceptance"], output);
run("git", ["add", "."], output);
run("git", ["commit", "-m", "Acceptance v0 baseline"], output);

if (restore) {
  run("dotnet", ["restore", "tests/Acceptance.Tests/Acceptance.Tests.csproj"], output);
}

const lines = [
  "",
  "ACCEPTANCE FIXTURE READY",
  "Path: " + output,
  "",
  restore ? "NuGet restore completed." : "Run while online before disconnecting:",
  restore ? "" : "  dotnet restore tests/Acceptance.Tests/Acceptance.Tests.csproj",
  "",
  "Then validate the intended baseline:",
  "  dotnet build src/Acceptance.Core/Acceptance.Core.csproj --no-restore",
  "  dotnet test tests/Acceptance.Tests/Acceptance.Tests.csproj --no-restore",
  "",
  "Open Pi from this directory and use ACCEPTANCE_TASK.md.",
  ""
];
process.stdout.write(lines.filter(Boolean).join("\n") + "\n");

function run(command, commandArgs, cwd) {
  const executable = process.platform === "win32" && command === "git"
    ? "git.exe"
    : process.platform === "win32" && command === "dotnet"
      ? "dotnet.exe"
      : command;

  const result = spawnSync(executable, commandArgs, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.stderr.write("Command failed: " + command + " " + commandArgs.join(" ") + "\n");
    process.exit(result.status ?? 1);
  }
}

