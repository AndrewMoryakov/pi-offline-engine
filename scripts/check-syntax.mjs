#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const roots = ["src", "scripts", "tests", "extensions"];
const files = [];

for (const root of roots) {
  await collect(path.resolve(root));
}

// A missing root is tolerated (the walker is also used on partial trees), but
// finding nothing at all means the check ran against the wrong directory.
// Passing vacuously here would let `npm run check` certify an empty result.
if (files.length === 0) {
  process.stderr.write(
    "Syntax check found no .mjs/.ts files under " + roots.join(", ") +
    " relative to " + process.cwd() + "\n"
  );
  process.exit(1);
}

files.sort();
for (const file of files) {
  const isTs = file.endsWith(".ts");
  const args = isTs
    ? ["--experimental-strip-types", "--check", file]
    : ["--check", file];
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.stderr.write("Syntax check failed: " + path.relative(process.cwd(), file) + "\n");
    process.exit(result.status ?? 1);
  }
}

process.stdout.write("SYNTAX CHECK: PASS (" + files.length + " files)\n");

async function collect(target) {
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".pi") continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (entry.isFile() && (full.endsWith(".mjs") || full.endsWith(".ts"))) files.push(full);
  }
}
