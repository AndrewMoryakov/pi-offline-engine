import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ACCEPTANCE_MARKER,
  prepareAcceptanceOutputDirectory
} from "../src/acceptance-output.mjs";

test("refuses current directory and its ancestors", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-acceptance-safe-"));
  const repoRoot = path.join(cwd, "repo");
  await fs.mkdir(repoRoot);

  await assert.rejects(
    () => prepareAcceptanceOutputDirectory({ output: cwd, cwd, repoRoot }),
    /Refusing to use a destructive/
  );
});

test("refuses deleting an existing unmarked directory", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "pi-acceptance-safe-"));
  const output = path.join(base, "existing");
  const cwd = path.join(base, "work");
  const repoRoot = path.join(cwd, "repo");
  await fs.mkdir(output);
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.writeFile(path.join(output, "important.txt"), "keep", "utf8");

  await assert.rejects(
    () => prepareAcceptanceOutputDirectory({ output, cwd, repoRoot }),
    /without acceptance marker/
  );
  assert.equal(await fs.readFile(path.join(output, "important.txt"), "utf8"), "keep");
});

test("deletes only a previously marked acceptance directory", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "pi-acceptance-safe-"));
  const output = path.join(base, "fixture");
  const cwd = path.join(base, "work");
  const repoRoot = path.join(cwd, "repo");
  await fs.mkdir(output);
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.writeFile(path.join(output, ACCEPTANCE_MARKER), "v0\n", "utf8");
  await fs.writeFile(path.join(output, "old.txt"), "old", "utf8");

  await prepareAcceptanceOutputDirectory({ output, cwd, repoRoot });
  await assert.rejects(() => fs.stat(output), /ENOENT/);
});
