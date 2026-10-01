import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runDelegationAttempt, uniqueAbsolutePaths } from "../src/delegation-attempt.mjs";
import { TinyModelOutputError } from "../src/tiny-client.mjs";
import { fakeDotnet, makeWorkspace } from "./helpers/extension-harness.mjs";

const spec = {
  version: 1,
  spec_id: "attempt",
  operation: "modify_symbol",
  goal: { summary: "Return two." },
  target: { file: "src/A.cs", symbol: "A.Value" },
  requirements: ["Value returns 2."],
  scope: { allowed_files: ["src/A.cs"], allow_new_files: false, allow_dependencies: false, allow_public_api_change: false },
  verification: { build: { project: "src/A.csproj" } }
};
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 };

async function attempt(reply, { dotnet = {}, stage = "verification_preflight", onAttemptStart } = {}) {
  const cwd = await makeWorkspace();
  const events = [];
  const outcome = await runDelegationAttempt({
    attempt: 1,
    maxAttempts: 3,
    stage,
    spec,
    context: {},
    cwd,
    signal: undefined,
    endpoint: "http://tiny",
    model: "tiny",
    repairPacket: null,
    trainingRunId: null,
    verificationPreflight: null,
    callTiny: async () => {
      if (reply instanceof Error) throw reply;
      return { candidate: reply, usage, latencyMs: 1 };
    },
    appendEvent: async (_cwd, event) => { events.push(event.type); },
    exec: fakeDotnet(dotnet),
    withMutationQueues: (_paths, fn) => fn(),
    onAttemptStart
  });
  return { outcome, events, cwd };
}

const GOOD = { status: "candidate", changes: [{ path: "src/A.cs", operation: "replace_text", expected: "=> 1;", content: "=> 2;" }] };

test("valid candidate that verifies green", async () => {
  const { outcome, events, cwd } = await attempt(GOOD);
  assert.equal(outcome.kind, "verification_passed");
  assert.equal(outcome.stage, "verification");
  assert.deepEqual(outcome.applied.changedFiles, ["src/A.cs"]);
  assert.equal(outcome.verification.passed, true);
  assert.deepEqual(events, ["tiny_started", "tiny_finished", "candidate_applied"]);
  assert.match(await fs.readFile(path.join(cwd, "src", "A.cs"), "utf8"), /=> 2;/);
});

test("valid candidate that verifies red", async () => {
  const { outcome } = await attempt(GOOD, { dotnet: { build: [{ code: 1, stdout: "error CS1" }] } });
  assert.equal(outcome.kind, "verification_failed");
  assert.equal(outcome.verification.passed, false);
});

test("invalid candidate stops at candidate_validation without writing", async () => {
  const { outcome, cwd } = await attempt({ status: "candidate", changes: [{ path: "src/B.cs", operation: "replace_text", expected: "a", content: "b" }] });
  assert.equal(outcome.kind, "invalid_model_output");
  assert.equal(outcome.source, "candidate");
  assert.equal(outcome.stage, "candidate_validation");
  assert.deepEqual(outcome.validationErrors, ["path outside allowed scope: src/B.cs"]);
  assert.equal(outcome.applied, null);
  assert.equal(await fs.readFile(path.join(cwd, "src", "A.cs"), "utf8"), "class A { int Value() => 1; }\n");
});

test("malformed TinyCoder output is classified by error class", async () => {
  const { outcome } = await attempt(new TinyModelOutputError("bad json"));
  assert.deepEqual({ kind: outcome.kind, source: outcome.source, stage: outcome.stage, error: outcome.error, tinyResult: outcome.tinyResult },
    { kind: "invalid_model_output", source: "tiny_output", stage: "tiny_call", error: "bad json", tinyResult: null });
});

test("terminal status", async () => {
  const { outcome } = await attempt({ status: "insufficient_spec" });
  assert.equal(outcome.kind, "terminal_model_status");
  assert.equal(outcome.tinyResult.candidate.status, "insufficient_spec");
});

test("apply failure is a runtime failure at apply with nothing applied", async () => {
  const { outcome } = await attempt({ status: "candidate", changes: [{ path: "src/A.cs", operation: "replace_text", expected: "=> 9;", content: "=> 2;" }] });
  assert.equal(outcome.kind, "runtime_failure");
  assert.equal(outcome.stage, "apply");
  assert.equal(outcome.applied, null);
});

test("a throwing progress callback is classified by the carried-in stage", async () => {
  const { outcome } = await attempt(GOOD, { stage: "tiny_call", onAttemptStart: () => { throw new Error("ui"); } });
  assert.deepEqual({ kind: outcome.kind, stage: outcome.stage, error: outcome.error }, { kind: "runtime_failure", stage: "tiny_call", error: "ui" });
});

test("uniqueAbsolutePaths resolves, de-duplicates and sorts candidate targets inside the workspace", () => {
  const root = path.resolve("/ws");
  const candidate = { changes: [{ path: "b.cs" }, { path: "a.cs" }, { path: "b.cs" }] };
  assert.deepEqual(uniqueAbsolutePaths(root, candidate), [path.join(root, "a.cs"), path.join(root, "b.cs")]);
  assert.throws(() => uniqueAbsolutePaths(root, { changes: [{ path: "../x.cs" }] }), /escapes workspace/);
});
