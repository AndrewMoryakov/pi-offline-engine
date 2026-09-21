import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { snapshotAllowedFiles } from "../src/workspace-snapshot.mjs";
import { applyCandidate } from "../src/apply-candidate.mjs";

function spec(files = ["src/A.cs"]) {
  return {
    version: 1,
    spec_id: "apply-001",
    operation: "modify_symbol",
    goal: { summary: "Change A" },
    target: { file: "src/A.cs", symbol: "A.Run" },
    requirements: ["Change return value"],
    scope: { allowed_files: files, allow_new_files: files.includes("src/B.cs") },
    verification: { build: { project: "src/App.csproj" } }
  };
}

async function workspace() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-offline-"));
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "A.cs"), "class A { int Run() => 1; }\n", "utf8");
  return cwd;
}

test("applies exact replacement against captured preimage", async () => {
  const cwd = await workspace();
  const s = spec();
  const snapshot = await snapshotAllowedFiles(cwd, s);
  const candidate = {
    status: "candidate",
    changes: [{ path: "src/A.cs", operation: "replace_text", expected: "=> 1", content: "=> 2" }]
  };

  const result = await applyCandidate(cwd, { spec: s, candidate, snapshot });
  assert.deepEqual(result.changedFiles, ["src/A.cs"]);
  assert.match(await fs.readFile(path.join(cwd, "src", "A.cs"), "utf8"), /=> 2/);
});

test("rejects stale file before writing", async () => {
  const cwd = await workspace();
  const s = spec();
  const snapshot = await snapshotAllowedFiles(cwd, s);
  await fs.writeFile(path.join(cwd, "src", "A.cs"), "class A { int Run() => 9; }\n", "utf8");

  const candidate = {
    status: "candidate",
    changes: [{ path: "src/A.cs", operation: "replace_text", expected: "=> 1", content: "=> 2" }]
  };

  await assert.rejects(() => applyCandidate(cwd, { spec: s, candidate, snapshot }), /stale candidate/);
  assert.match(await fs.readFile(path.join(cwd, "src", "A.cs"), "utf8"), /=> 9/);
});

test("preflights every edit before any write", async () => {
  const cwd = await workspace();
  const s = spec();
  const snapshot = await snapshotAllowedFiles(cwd, s);
  const original = await fs.readFile(path.join(cwd, "src", "A.cs"), "utf8");

  const candidate = {
    status: "candidate",
    changes: [
      { path: "src/A.cs", operation: "replace_text", expected: "=> 1", content: "=> 2" },
      { path: "src/A.cs", operation: "replace_text", expected: "missing text", content: "x" }
    ]
  };

  await assert.rejects(() => applyCandidate(cwd, { spec: s, candidate, snapshot }), /occur exactly once/);
  assert.equal(await fs.readFile(path.join(cwd, "src", "A.cs"), "utf8"), original);
});

test("creates an explicitly allowed new file", async () => {
  const cwd = await workspace();
  const s = spec(["src/A.cs", "src/B.cs"]);
  const snapshot = await snapshotAllowedFiles(cwd, s);
  const candidate = {
    status: "candidate",
    changes: [{ path: "src/B.cs", operation: "create_file", content: "class B {}\n" }]
  };

  await applyCandidate(cwd, { spec: s, candidate, snapshot });
  assert.equal(await fs.readFile(path.join(cwd, "src", "B.cs"), "utf8"), "class B {}\n");
});


test("apply implementation registers each target for rollback before writing", async () => {
  const source = await fs.readFile(new URL("../src/apply-candidate.mjs", import.meta.url), "utf8");
  const pushIndex = source.indexOf("written.push(item);");
  const writeIndex = source.indexOf('await fs.writeFile(item.absolute, item.next, "utf8");');
  assert.ok(pushIndex >= 0);
  assert.ok(writeIndex >= 0);
  assert.ok(pushIndex < writeIndex, "rollback registration precedes the actual write");
});


test("replacement content is inserted literally without String.replace expansion", async () => {
  const cwd = await workspace();
  const s = spec();
  const snapshot = await snapshotAllowedFiles(cwd, s);
  const candidate = {
    status: "candidate",
    changes: [{
      path: "src/A.cs",
      operation: "replace_text",
      expected: "=> 1",
      content: '=> "P$\'Q $$ $&"'
    }]
  };

  await applyCandidate(cwd, { spec: s, candidate, snapshot });
  const text = await fs.readFile(path.join(cwd, "src", "A.cs"), "utf8");
  assert.match(text, /P\$'Q \$\$ \$&/);
});
