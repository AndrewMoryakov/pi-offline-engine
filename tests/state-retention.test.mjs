import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_KEEP_ENTRIES, DEFAULT_MAX_BYTES, pruneStateDir, pruneStateSubdir, stateRetentionLimits } from "../src/state-retention.mjs";
import { compactToolResult } from "../src/tool-result-compactor.mjs";
import { saveCandidateRecord } from "../src/candidate-store.mjs";

async function tempDir(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

// Files named f00..fNN, f00 the oldest.
async function filesWithAges(dir, count, size = 10) {
  await fs.mkdir(dir, { recursive: true });
  const base = Date.now() / 1000 - 10_000;
  for (let i = 0; i < count; i += 1) {
    const file = path.join(dir, `f${String(i).padStart(2, "0")}.log`);
    await fs.writeFile(file, "x".repeat(size));
    await fs.utimes(file, base + i, base + i);
  }
}

const names = async (dir) => (await fs.readdir(dir)).filter((name) => name !== ".gitignore").sort();

test("keeps the newest entries up to the count and removes the rest", async () => {
  const dir = await tempDir("pi-retention-");
  await filesWithAges(dir, 30);
  await fs.writeFile(path.join(dir, ".gitignore"), "*\n");
  const result = await pruneStateDir(dir, { keep: 20, maxBytes: DEFAULT_MAX_BYTES });
  assert.equal(result.removed.length, 10);
  assert.deepEqual(await names(dir), Array.from({ length: 20 }, (_, i) => `f${String(i + 10).padStart(2, "0")}.log`));
  assert.equal(await fs.readFile(path.join(dir, ".gitignore"), "utf8"), "*\n");
});

test("keeps within the size limit but always keeps the newest entry", async () => {
  const dir = await tempDir("pi-retention-");
  await filesWithAges(dir, 5, 400);
  await pruneStateDir(dir, { keep: 20, maxBytes: 1000 });
  assert.deepEqual(await names(dir), ["f03.log", "f04.log"]);

  const big = await tempDir("pi-retention-");
  await filesWithAges(big, 3, 5000);
  await pruneStateDir(big, { keep: 20, maxBytes: 1000 });
  assert.deepEqual(await names(big), ["f02.log"]);
});

test("never removes the entry the writer protects", async () => {
  const dir = await tempDir("pi-retention-");
  await filesWithAges(dir, 5);
  await pruneStateDir(dir, { keep: 2, maxBytes: DEFAULT_MAX_BYTES, protect: ["f00.log"] });
  assert.deepEqual(await names(dir), ["f00.log", "f03.log", "f04.log"]);
});

test("measures and removes test-result folders as a whole", async () => {
  const dir = await tempDir("pi-retention-");
  const base = Date.now() / 1000 - 1000;
  for (let i = 0; i < 4; i += 1) {
    const run = path.join(dir, `run${i}`);
    await fs.mkdir(run, { recursive: true });
    await fs.writeFile(path.join(run, "results.trx"), "y".repeat(600));
    await fs.utimes(run, base + i, base + i);
  }
  await pruneStateDir(dir, { keep: 20, maxBytes: 1300 });
  assert.deepEqual(await names(dir), ["run2", "run3"]);
});

test("a missing folder is not an error", async () => {
  const result = await pruneStateDir(path.join(os.tmpdir(), "pi-retention-missing", String(Date.now())));
  assert.deepEqual(result, { kept: 0, keptBytes: 0, removed: [] });
});

test("only the four regenerable folders can be pruned", async () => {
  const cwd = await tempDir("pi-retention-");
  for (const name of ["training", "export", "events.jsonl", "..", ""]) {
    await assert.rejects(pruneStateSubdir(cwd, name), /not a pruned state folder/);
  }
});

test("PI_OFFLINE_STATE_KEEP sets the count; bad values keep the default", () => {
  assert.deepEqual(stateRetentionLimits({}), { keep: DEFAULT_KEEP_ENTRIES, maxBytes: DEFAULT_MAX_BYTES });
  assert.deepEqual(stateRetentionLimits({ PI_OFFLINE_STATE_KEEP: "5" }), { keep: 5, maxBytes: DEFAULT_MAX_BYTES });
  assert.deepEqual(stateRetentionLimits({ PI_OFFLINE_STATE_KEEP: "100" }), { keep: 100, maxBytes: 100 * 512 * 1024 });
  for (const bad of ["0", "-3", "2.5", "many", "100000"]) {
    assert.equal(stateRetentionLimits({ PI_OFFLINE_STATE_KEEP: bad }).keep, DEFAULT_KEEP_ENTRIES, bad);
  }
});

test("compaction keeps at most 20 full logs in tool-results", async () => {
  const cwd = await tempDir("pi-retention-compact-");
  const text = [...Array.from({ length: 500 }, (_, i) => `  restore and build noise line ${i} with unrelated detail`), "src/A.cs(1,1): error CS0001: broken", "Build FAILED."].join("\n");
  let last;
  for (let i = 0; i < 25; i += 1) {
    last = await compactToolResult({ cwd, toolName: "bash", toolCallId: `call-${i}`, input: { command: "dotnet build" }, content: [{ type: "text", text }] });
  }
  const dir = path.join(cwd, ".pi", "offline-engine", "tool-results");
  const kept = await names(dir);
  assert.equal(kept.length, 20);
  assert.ok(kept.includes("call-24.log"));
  await fs.access(path.join(cwd, last.artifact));
});

test("candidate records are limited the same way", async () => {
  const cwd = await tempDir("pi-retention-candidates-");
  for (let i = 0; i < 23; i += 1) {
    await saveCandidateRecord(cwd, { spec: { spec_id: `spec-${i}` }, attempt: 1, candidate: { status: "candidate" } });
  }
  assert.equal((await names(path.join(cwd, ".pi", "offline-engine", "candidates"))).length, 20);
  await fs.access(path.join(cwd, ".pi", "offline-engine", ".gitignore"));
});
