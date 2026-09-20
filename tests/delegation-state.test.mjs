import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRuntimeFailureOutcome,
  buildTinyTerminalOutcome,
  failureReasonForStage
} from "../src/delegation-state.mjs";

test("classifies execution stages without conflating invalid output with transport", () => {
  assert.equal(failureReasonForStage("tiny_call"), "tiny_transport_failure");
  assert.equal(failureReasonForStage("candidate_validation"), "tiny_invalid_candidate");
  assert.equal(failureReasonForStage("verification"), "verification_execution_failure");
  assert.equal(failureReasonForStage("apply"), "candidate_apply_failure");
});

test("runtime failure outcome preserves workspace mutation state and changed files", () => {
  const outcome = buildRuntimeFailureOutcome({
    stage: "verification",
    workspaceModified: true,
    error: "dotnet failed to start",
    attempts: [{ attempt: 1 }],
    changedFiles: ["src/B.cs", "src/A.cs", "src/A.cs"]
  });

  assert.equal(outcome.status, "needs_main_model");
  assert.equal(outcome.workspace_modified, true);
  assert.equal(outcome.workspace_state_uncertain, false);
  assert.equal(outcome.reason, "verification_execution_failure");
  assert.deepEqual(outcome.changed_files, ["src/A.cs", "src/B.cs"]);
  assert.equal(outcome.attempts.length, 1);
});

test("apply failures conservatively report uncertain modified workspace", () => {
  const outcome = buildRuntimeFailureOutcome({
    stage: "apply",
    workspaceModified: false,
    error: "write failed"
  });

  assert.equal(outcome.workspace_modified, true);
  assert.equal(outcome.workspace_state_uncertain, true);
  assert.equal(outcome.reason, "candidate_apply_failure");
});

test("terminal TinyCoder status escalates after prior mutation", () => {
  const outcome = buildTinyTerminalOutcome({
    terminalStatus: "insufficient_spec",
    reason: "need another API signature",
    attempt: 2,
    usage: { inputTokens: 10, outputTokens: 2 },
    workspaceModified: true,
    changedFiles: ["src/A.cs"]
  });

  assert.equal(outcome.status, "needs_main_model");
  assert.equal(outcome.terminal_status, "insufficient_spec");
  assert.equal(outcome.workspace_modified, true);
  assert.deepEqual(outcome.changed_files, ["src/A.cs"]);
});

test("terminal TinyCoder status remains terminal before any mutation", () => {
  const outcome = buildTinyTerminalOutcome({
    terminalStatus: "cannot_safely_implement",
    reason: "scope ambiguous",
    attempt: 1,
    usage: null,
    workspaceModified: false,
    changedFiles: []
  });

  assert.equal(outcome.status, "cannot_safely_implement");
  assert.equal(outcome.workspace_modified, false);
  assert.deepEqual(outcome.changed_files, []);
});
