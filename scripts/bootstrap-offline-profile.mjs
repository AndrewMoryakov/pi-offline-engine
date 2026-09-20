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

const tiers = new Set(["required"]);
if (includeOptional) tiers.add("optional");
if (includeDeferred) tiers.add("deferred");

const selected = profile.packages.filter((pkg) => tiers.has(pkg.tier));
const piCommand = process.platform === "win32" ? "pi.cmd" : "pi";

console.log(`Profile: ${profile.name}`);
console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
console.log("");

for (const pkg of selected) {
  const spec = `npm:${pkg.name}@${pkg.version}`;
  console.log(`[${pkg.tier}] ${piCommand} install ${spec}`);
  console.log(`  ${pkg.purpose}`);
  if (!apply) continue;

  const result = spawnSync(piCommand, ["install", spec], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`Failed to install ${spec}; stopping.`);
    process.exit(result.status ?? 1);
  }
}

console.log("");
console.log("Recommended offline environment:");
for (const [key, value] of Object.entries(profile.environment)) {
  console.log(`  ${key}=${value}`);
}

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
