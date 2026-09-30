import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runCandidateDelegation } from "../src/delegation-candidate-workflow.mjs";
import { makeWorkspace } from "./helpers/extension-harness.mjs";

const spec = {
  version: 1,
  spec_id: "candidate-workflow",
  operation: "modify_symbol",
  goal: { summary: "Return two." },
  target: { file: "src/A.cs", symbol: "A.Value" },
  requirements: ["Value returns 2."],
  scope: { allowed_files: ["src/A.cs"], allow_new_files: false, allow_dependencies: false, allow_public_api_change: false },
  verification: { build: { project: "src/A.csproj" } }
};
const usage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7 };

function harness(reply) {
  const events = [];
  const calls = [];
  const saved = [];
  return {
    events,
    calls,
    saved,
    options: {
      endpoint: "http://tiny",
      model: "tiny",
      signal: undefined,
      appendEvent: async (_cwd, event) => { events.push(event); },
      saveCandidate: async (_cwd, record) => { saved.push(record); return "record.json"; },
      callTiny: async (request) => {
        calls.push(request);
        if (reply instanceof Error) throw reply;
        return { candidate: reply, usage, latencyMs: 12 };
      }
    }
  };
}

test("rejected spec performs no snapshot, event or TinyCoder call", async () => {
  const h = harness({ status: "insufficient_spec" });
  const outcome = await runCandidateDelegation({ ...h.options, cwd: "/does/not/exist", spec: { ...spec, version: 2 }, context: {} });
  assert.deepEqual(outcome, { kind: "spec_rejected", errors: ["version must be 1"] });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.events, []);
});

test("valid terminal response is returned unchanged and not persisted", async () => {
  const cwd = await makeWorkspace();
  const reply = { status: "insufficient_spec", reason: "need more" };
  const h = harness(reply);
  const outcome = await runCandidateDelegation({ ...h.options, cwd, spec, context: undefined });
  assert.deepEqual(outcome, { kind: "accepted", candidate: reply, usage, latencyMs: 12 });
  assert.deepEqual(h.saved, []);
  assert.deepEqual(h.calls[0].context, {});
  assert.deepEqual(h.events.map((e) => e.type), ["tiny_started", "tiny_finished"]);
});

test("invalid candidate returns errors, candidate, usage and latency", async () => {
  const cwd = await makeWorkspace();
  const reply = { status: "candidate", changes: [{ path: "src/B.cs", operation: "replace_text", expected: "a", content: "b" }] };
  const h = harness(reply);
  const outcome = await runCandidateDelegation({ ...h.options, cwd, spec, context: {} });
  assert.deepEqual(outcome, { kind: "invalid_candidate", candidate: reply, usage, latencyMs: 12, errors: ["path outside allowed scope: src/B.cs"] });
  assert.equal(h.events[1].candidateValid, false);
  assert.deepEqual(h.saved, []);
});

test("valid candidate is persisted but never applied", async () => {
  const cwd = await makeWorkspace();
  const reply = { status: "candidate", changes: [{ path: "src/A.cs", operation: "replace_text", expected: "=> 1;", content: "=> 2;" }] };
  const h = harness(reply);
  const outcome = await runCandidateDelegation({ ...h.options, cwd, spec, context: {} });
  assert.equal(outcome.kind, "accepted");
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].attempt, 1);
  assert.equal(h.saved[0].snapshot.files["src/A.cs"].exists, true);
  assert.equal(await fs.readFile(path.join(cwd, "src", "A.cs"), "utf8"), "class A { int Value() => 1; }\n");
});

test("transport failure emits tiny_failed and throws the current error contract", async () => {
  const cwd = await makeWorkspace();
  const h = harness(new Error("connection refused"));
  await assert.rejects(
    runCandidateDelegation({ ...h.options, cwd, spec, context: {} }),
    { message: "Tiny implementer failed: connection refused" }
  );
  assert.deepEqual(h.events.map((e) => e.type), ["tiny_started", "tiny_failed"]);
  assert.equal(h.events[1].error, "connection refused");
});
