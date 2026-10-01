// The engine attaches the current text of scope.allowed_files to each
// implementer request, read from the same bytes the preimage snapshot hashes.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { captureAllowedFiles, MAX_CURRENT_FILE_BYTES } from "../src/workspace-snapshot.mjs";
import { runDelegatedExecution } from "../src/delegation-execution-workflow.mjs";
import { runCandidateDelegation } from "../src/delegation-candidate-workflow.mjs";
import { resolveEngineSettings } from "../src/engine-config.mjs";
import { fakeDotnet, makeWorkspace } from "./helpers/extension-harness.mjs";

const spec = {
  version: 1,
  spec_id: "current-files",
  operation: "modify_symbol",
  goal: { summary: "Return two." },
  target: { file: "src/A.cs", symbol: "A.Value" },
  requirements: ["Value returns 2."],
  scope: { allowed_files: ["src/A.cs", "src/New.cs"], allow_new_files: true, allow_dependencies: false, allow_public_api_change: false },
  verification: { build: { project: "src/A.csproj" } }
};

test("captured content is the hashed content; large and missing files are marked", async () => {
  const cwd = await makeWorkspace({ "src/A.cs": "class A {}\n", "src/Big.cs": "x".repeat(MAX_CURRENT_FILE_BYTES + 1) });
  const bigSpec = { ...spec, scope: { ...spec.scope, allowed_files: ["src/A.cs", "src/Big.cs", "src/Missing.cs"] } };
  const { snapshot, currentFiles } = await captureAllowedFiles(cwd, bigSpec, { withContent: true });

  assert.deepEqual(currentFiles["src/A.cs"], { exists: true, content: "class A {}\n" });
  assert.equal(snapshot.files["src/A.cs"].sha256, crypto.createHash("sha256").update("class A {}\n").digest("hex"));
  assert.equal(currentFiles["src/Big.cs"].content, undefined);
  assert.match(currentFiles["src/Big.cs"].omitted, /exceeds the 16384-byte limit/);
  assert.deepEqual(currentFiles["src/Missing.cs"], { exists: false });

  assert.equal((await captureAllowedFiles(cwd, bigSpec)).currentFiles, null);
});

test("every execute attempt sees the files as they are now, including after a red attempt", async () => {
  const cwd = await makeWorkspace();
  const requests = [];
  const replies = [
    { status: "candidate", changes: [{ path: "src/A.cs", operation: "replace_text", expected: "=> 1;", content: "=> 3;" }] },
    { status: "candidate", changes: [{ path: "src/A.cs", operation: "replace_text", expected: "=> 3;", content: "=> 2;" }] }
  ];
  const outcome = await runDelegatedExecution({
    spec, context: {}, cwd, signal: undefined, endpoint: "http://tiny", model: "tiny", maxAttempts: 3, trainingRunId: null,
    callTiny: async (request) => {
      requests.push(request);
      return { candidate: replies[requests.length - 1], usage: {}, latencyMs: 1 };
    },
    exec: fakeDotnet({ build: [{ code: 1, stdout: "src/A.cs(1,1): error CS0029: wrong value" }, { code: 0 }] }),
    withMutationQueues: async (_paths, fn) => fn(),
    appendEvent: async () => {},
    attachCurrentFiles: true
  });

  assert.equal(outcome.kind, "verification_passed");
  assert.equal(requests[0].currentFiles["src/A.cs"].content, "class A { int Value() => 1; }\n");
  assert.equal(requests[1].currentFiles["src/A.cs"].content, "class A { int Value() => 3; }\n");
  assert.deepEqual(requests[1].currentFiles["src/New.cs"], { exists: false });
});

test("candidate-only delegation attaches the files too, and nothing when disabled", async () => {
  const cwd = await makeWorkspace();
  const seen = [];
  const callTiny = async (request) => {
    seen.push(request);
    return { candidate: { status: "insufficient_spec", reason: "test" }, usage: {}, latencyMs: 1 };
  };
  const base = { spec, context: {}, cwd, signal: undefined, endpoint: "http://tiny", model: "tiny", callTiny, appendEvent: async () => {} };
  await runCandidateDelegation({ ...base, attachCurrentFiles: true });
  await runCandidateDelegation({ ...base, attachCurrentFiles: false });
  assert.equal(seen[0].currentFiles["src/A.cs"].content, "class A { int Value() => 1; }\n");
  assert.equal("currentFiles" in seen[1], false);
});

test("attaching is on by default and PI_OFFLINE_ATTACH_CURRENT_FILES=0 turns it off", () => {
  assert.equal(resolveEngineSettings({ env: {} }).attachCurrentFiles, true);
  assert.equal(resolveEngineSettings({ env: { PI_OFFLINE_ATTACH_CURRENT_FILES: "0" } }).attachCurrentFiles, false);
});
