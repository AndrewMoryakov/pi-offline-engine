#!/usr/bin/env node
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = path.join(root, "profiles", "offline-dotnet-v1.json");
const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const includeOptional = args.has("--include-optional");
const includeDeferred = args.has("--include-deferred");
const installCsharpLs = args.has("--install-csharp-ls");

// "bundled" packages arrive with pi-offline-engine itself (package.json
// dependencies + pi manifest) and are never installed from here: a second
// `pi install` would register a duplicate copy of the same tools.
const tiers = new Set();
if (includeOptional) tiers.add("optional");
if (includeDeferred) tiers.add("deferred");

const bundled = profile.packages.filter((pkg) => pkg.tier === "bundled");
const selected = profile.packages.filter((pkg) => tiers.has(pkg.tier));
const isWindows = process.platform === "win32";
const piCommand = isWindows ? "pi.cmd" : "pi";

console.log(`Profile: ${profile.name}`);
console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
console.log("");

console.log("Bundled with pi-offline-engine (installed automatically, nothing to do):");
for (const pkg of bundled) console.log(`  ${pkg.name}@${pkg.version} — ${pkg.purpose}`);
console.log("");

if (selected.length === 0) {
  console.log("No optional packages selected (--include-optional / --include-deferred).");
}

for (const pkg of selected) {
  const spec = `npm:${pkg.name}@${pkg.version}`;
  console.log(`[${pkg.tier}] ${piCommand} install ${spec}`);
  console.log(`  ${pkg.purpose}`);
  if (!apply) continue;

  // pi.cmd is a batch shim: Node refuses to spawn it without a shell (EINVAL).
  // `spec` is built from the reviewed, pinned profile, never from user input.
  const result = spawnSync(piCommand, ["install", spec], { stdio: "inherit", shell: isWindows });
  if (result.error || result.status !== 0) {
    console.error(`Failed to install ${spec}; stopping.`);
    process.exit(result.status ?? 1);
  }
}

console.log("");
console.log("Optional environment for fully offline work:");
for (const [key, value] of Object.entries(profile.environment)) {
  console.log(`  ${key}=${value}`);
}
if (profile.notes?.environment) console.log(`  (${profile.notes.environment})`);

if (installCsharpLs) {
  const dotnet = spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8" });
  const hasNet10 = dotnet.status === 0 && /^10\./m.test(dotnet.stdout ?? "");
  if (!hasNet10) {
    console.error("\n.NET 10 SDK was not detected; csharp-ls currently requires .NET 10 or newer.");
    process.exit(2);
  }

  const existing = spawnSync("csharp-ls", ["--version"], { encoding: "utf8" });
  if (existing.status === 0) {
    console.log("\ncsharp-ls is already available.");
  } else if (apply) {
    console.log("\nInstalling csharp-ls as a global dotnet tool...");
    const result = spawnSync("dotnet", ["tool", "install", "--global", "csharp-ls"], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  } else {
    console.log("\nDRY RUN: dotnet tool install --global csharp-ls");
  }
}

if (!apply) {
  console.log("\nNothing was changed. Re-run with --apply after reviewing the package sources.");
}
