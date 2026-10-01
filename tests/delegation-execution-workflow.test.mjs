// Behavioral tests of the Pi-free execution workflow with injected
// capabilities (scripted TinyCoder transport, fake dotnet, recording event
// writer and mutation queue) over real files in disposable workspaces.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { prepareDelegatedExecution, runDelegatedExecution } from "../src/delegation-execution-workflow.mjs";
import { formatExecutionResult } from "../src/delegation-results.mjs";
import { TinyModelOutputError } from "../src/tiny-client.mjs";
import { fakeDotnet, makeWorkspace, readJsonLines, trxDocument } from "./helpers/extension-harness.mjs";

const spec = {
  version: 1,
  spec_id: "workflow",
  operation: "modify_symbol",
  goal: { summary: "Return two." },
  target: { file: "src/A.cs", symbol: "A.Value" },
  requirements: ["Value returns 2."],
  scope: { allowed_files: ["src/A.cs"], allow_new_files: false, allow_dependencies: false, allow_public_api_change: false },
  verification: { build: { project: "src/A.csproj" } }
};

const change = (expected, content, file = "src/A.cs") => ({ status: "candidate", changes: [{ path: file, operation: "replace_text", expected, content }] });
const RED = { code: 1, stdout: "src/A.cs(1,1): error CS1002: ; expected" };

// A reply is a candidate object, an Error instance to throw, or "malformed".
function scriptedTiny(replies) {
  const requests = [];
  const callTiny = async (request) => {
    requests.push(request);
    const reply = replies[Math.min(requests.length, replies.length) - 1];
    if (reply === "malformed") throw new TinyModelOutputError("tiny model did not return a JSON object");
    if (reply instanceof Error) throw reply;
    const n = requests.length;
    return { candidate: reply, usage: { inputTokens: 10 * n, outputTokens: n, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11 * n }, latencyMs: 1 };
  };
  return { callTiny, requests };
}

async function run({ replies, dotnet = {}, maxAttempts = 3, trainingRunId = null, failEvent, specOverride, setup } = {}) {
  const cwd = await makeWorkspace();
  if (setup) await setup(cwd);
  const tiny = scriptedTiny(replies);
  const events = [];
  const queued = [];
  const outcome = await runDelegatedExecution({
    spec: specOverride ?? spec,
    context: {},
    cwd,
    signal: undefined,
    endpoint: "http://tiny",
    model: "tiny",
    maxAttempts,
    trainingRunId,
    callTiny: tiny.callTiny,
    exec: fakeDotnet(dotnet),
    withMutationQueues: async (paths, fn) => {
      queued.push(paths);
      return fn();
    },
    appendEvent: async (_cwd, event) => {
      if (failEvent?.(event)) throw new Error(`ledger write failed for ${event.type}`);
      events.push(event);
    }
  });
  return { outcome, events, tiny, queued, cwd };
}

test("preflight failure is infrastructure at attempt 0 with no TinyCoder call", async () => {
  const { outcome, events, tiny } = await run({
    replies: [change("=> 1;", "=> 2;")],
    specOverride: { ...spec, verification: { tests: { project: "tests/ATests.csproj" } } },
    dotnet: { help: { code: 1 } }
  });
  assert.equal(outcome.kind, "preflight_failure");
  assert.equal(outcome.outcome.reason, "verification_infrastructure_failure");
  assert.equal(outcome.outcome.workspace_modified, false);
  assert.equal(tiny.requests.length, 0);
  assert.deepEqual(events.map((e) => [e.type, e.attempt]), [["delegated_implementation_runtime_failure", 0]]);
  assert.equal("usage" in formatExecutionResult(outcome), false);
});

test("invalid candidate retries up to the bounded maximum, then escalates", async () => {
  const { outcome, tiny } = await run({ replies: [change("=> 1;", "=> 2;", "src/B.cs")] });
  assert.equal(tiny.requests.length, 3);
  assert.equal(outcome.kind, "model_output_escalation");
  assert.equal(outcome.outcome.reason, "tiny_invalid_candidate");
  assert.equal(outcome.attempts.length, 3);
  assert.equal(tiny.requests[2].repairPacket.prior_repair_packet.kind, "model_output_failure");
});

test("malformed repair output after red verification retains the verification RepairPacket", async () => {
  const { outcome, tiny } = await run({ replies: [change("=> 1;", "=> 2;"), "malformed"], dotnet: { build: [RED] } });
  assert.equal(outcome.kind, "model_output_escalation");
  assert.equal(outcome.outcome.reason, "tiny_invalid_output");
  assert.equal(outcome.outcome.workspace_modified, true);
  assert.deepEqual(outcome.outcome.changed_files, ["src/A.cs"]);
  const third = tiny.requests[2].repairPacket;
  assert.equal(third.kind, "model_output_failure");
  assert.equal(third.repair_attempt, 2);
  // Attempt 2 was malformed; its retry packet chains the attempt-1
  // verification RepairPacket, so compiler evidence survives.
  assert.equal(third.prior_repair_packet.repair_attempt, 1);
  assert.ok(third.prior_repair_packet.verification.diagnostics.length > 0);
});

test("terminal TinyCoder status before mutation is not an escalation", async () => {
  const { outcome, events } = await run({ replies: [{ status: "insufficient_spec", reason: "why" }] });
  assert.equal(outcome.kind, "terminal_model_status");
  assert.equal(outcome.workspaceModified, false);
  assert.equal(outcome.outcome.status, "insufficient_spec");
  assert.equal(events.at(-1).type, "tiny_terminal_status");
});

test("terminal TinyCoder status after mutation escalates with cumulative files", async () => {
  const { outcome, events } = await run({
    replies: [change("=> 1;", "=> 2;"), { status: "cannot_safely_implement" }],
    dotnet: { build: [RED] }
  });
  assert.equal(outcome.kind, "terminal_model_status");
  assert.equal(outcome.workspaceModified, true);
  assert.equal(outcome.outcome.reason, "tiny_cannot_safely_implement_after_mutation");
  assert.deepEqual(outcome.outcome.changed_files, ["src/A.cs"]);
  assert.equal(events.at(-1).type, "delegated_implementation_escalated");
});

test("successful verification is reported as not task-complete", async () => {
  const { outcome, queued, cwd } = await run({ replies: [change("=> 1;", "=> 2;")] });
  assert.equal(outcome.kind, "verification_passed");
  const body = JSON.parse(formatExecutionResult(outcome).content[0].text);
  assert.equal(body.task_complete, false);
  assert.deepEqual(queued, [[path.join(cwd, "src", "A.cs")]]);
});

test("exhausted red verifications retain the final verification and cumulative files", async () => {
  const { outcome } = await run({
    replies: [change("=> 1;", "=> 2;"), change("=> 2;", "=> 3;"), change("=> 3;", "=> 4;")],
    dotnet: { build: [RED] }
  });
  assert.equal(outcome.kind, "attempts_exhausted");
  assert.equal(outcome.workspaceModified, true);
  assert.deepEqual(outcome.changedFiles, ["src/A.cs"]);
  assert.equal(outcome.verification.passed, false);
  assert.equal(outcome.attempts.length, 3);
});

for (const [name, options, reason] of [
  ["transport", { replies: [new Error("connect ECONNREFUSED")] }, "tiny_transport_failure"],
  ["apply", { replies: [change("=> 42;", "=> 43;")] }, "candidate_apply_failure"],
  ["verification", { replies: [change("=> 1;", "=> 2;")], dotnet: { build: ["throw"] } }, "verification_execution_failure"]
]) {
  test(`${name} failure does not enter the model-output retry path`, async () => {
    const { outcome, tiny } = await run(options);
    assert.equal(tiny.requests.length, 1);
    assert.equal(outcome.kind, "runtime_failure");
    assert.equal(outcome.outcome.reason, reason);
  });
}

test("usage is summed across all attempts", async () => {
  const { outcome } = await run({
    replies: [change("=> 1;", "=> 2;", "src/B.cs"), "malformed", change("=> 1;", "=> 2;")]
  });
  assert.equal(outcome.kind, "verification_passed");
  // Attempts 1 and 3 returned usage; the malformed attempt 2 reported none.
  assert.equal(outcome.nestedUsage.input, 10 + 30);
  assert.equal(outcome.nestedUsage.totalTokens, 11 + 33);
});

test("training recorder failure never changes the workflow result", async () => {
  const normal = await run({ replies: [change("=> 1;", "=> 2;")] });
  const broken = await run({
    replies: [change("=> 1;", "=> 2;")],
    trainingRunId: "run-1",
    setup: (cwd) => fs.mkdir(path.join(cwd, ".pi", "offline-engine", "training", "raw.jsonl"), { recursive: true })
  });
  assert.equal(broken.outcome.kind, normal.outcome.kind);
  assert.deepEqual(broken.outcome.changedFiles, normal.outcome.changedFiles);
  assert.ok(broken.events.some((event) => event.type === "training_capture_failed"));
});

test("a failed decision-event write becomes a runtime failure at that attempt's stage", async () => {
  const { outcome } = await run({
    replies: [change("=> 1;", "=> 2;")],
    failEvent: (event) => event.type === "verification_finished"
  });
  assert.equal(outcome.kind, "runtime_failure");
  assert.equal(outcome.outcome.stage, "verification");
  assert.equal(outcome.outcome.reason, "verification_execution_failure");
  assert.equal(outcome.outcome.workspace_modified, true);
  assert.equal(outcome.attempts.length, 1, "the attempt record was pushed before the write");

  const terminal = await run({ replies: [{ status: "insufficient_spec" }], failEvent: (event) => event.type === "tiny_terminal_status" });
  assert.equal(terminal.outcome.kind, "runtime_failure");
  assert.equal(terminal.outcome.outcome.reason, "tiny_invalid_candidate");
});

test("a failed malformed-output retry-event write propagates", async () => {
  await assert.rejects(
    run({ replies: ["malformed"], failEvent: (event) => event.type === "tiny_model_retry_scheduled" }),
    /ledger write failed for tiny_model_retry_scheduled/
  );
});

test("a failed runtime-failure event write propagates", async () => {
  await assert.rejects(
    run({ replies: [new Error("down")], failEvent: (event) => event.type === "delegated_implementation_runtime_failure" }),
    /ledger write failed for delegated_implementation_runtime_failure/
  );
});

test("prepareDelegatedExecution rejects an invalid spec and records sensitive-path skips", async () => {
  const cwd = await makeWorkspace();
  await assert.rejects(
    prepareDelegatedExecution({ spec: { ...spec, version: 2 }, cwd, trainingCaptureEnabled: true, appendEvent: async () => {} }),
    { message: "ImplementationSpec rejected: version must be 1" }
  );

  const events = [];
  const appendEvent = async (_cwd, event) => { events.push(event); };
  const sensitive = { ...spec, target: { file: "src/.env", symbol: "X" }, scope: { ...spec.scope, allowed_files: ["src/.env"] } };
  assert.deepEqual(await prepareDelegatedExecution({ spec: sensitive, cwd, trainingCaptureEnabled: true, appendEvent }), { trainingRunId: null });
  assert.deepEqual(events, [{ type: "training_capture_skipped_sensitive_path", specId: "workflow" }]);

  const opened = await prepareDelegatedExecution({ spec, cwd, trainingCaptureEnabled: true, appendEvent, newTrainingRunId: (id) => `${id}-fixed` });
  assert.deepEqual(opened, { trainingRunId: "workflow-fixed" });
  assert.deepEqual(await prepareDelegatedExecution({ spec, cwd, trainingCaptureEnabled: false, appendEvent }), { trainingRunId: null });
});

test("training capture writes one record per attempt plus infrastructure failures", async () => {
  const { cwd } = await run({
    replies: [change("=> 1;", "=> 2;"), new Error("down")],
    dotnet: { build: [RED] },
    trainingRunId: "run-2"
  });
  const rows = await readJsonLines(path.join(cwd, ".pi", "offline-engine", "training", "raw.jsonl"));
  assert.deepEqual(rows.map((row) => [row.kind, row.attempt, row.supervision?.outcome ?? row.reason]), [
    ["implementation_attempt", 1, "verification_failed"],
    ["infrastructure_failure", 2, "tiny_transport_failure"]
  ]);
});

test("TRX-backed tests pass through the workflow", async () => {
  const { outcome } = await run({
    replies: [change("=> 1;", "=> 2;")],
    specOverride: { ...spec, verification: { build: { project: "src/A.csproj" }, tests: { project: "tests/ATests.csproj" } } },
    dotnet: { test: [{ code: 0, trx: trxDocument() }] }
  });
  assert.equal(outcome.kind, "verification_passed");
  assert.equal(outcome.verification.checks[1].executedTestCount, 1);
});
