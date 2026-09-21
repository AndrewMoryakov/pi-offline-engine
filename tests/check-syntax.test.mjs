import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("syntax walker checks tests directory rather than only runtime files", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-syntax-check-"));
  await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
  await fs.writeFile(path.join(cwd, "tests", "broken.test.mjs"), "const x = ;\n", "utf8");

  const script = fileURLToPath(new URL("../scripts/check-syntax.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Syntax check failed/);
  assert.match(result.stderr, /broken\.test\.mjs/);
});

test("fails instead of passing vacuously when no source files are found", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-syntax-empty-"));

  const script = fileURLToPath(new URL("../scripts/check-syntax.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /found no \.mjs\/\.ts files/);
  assert.doesNotMatch(result.stdout, /PASS/);
});
