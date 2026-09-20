import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeFailureOutcome, failureReasonForStage } from "../src/delegation-state.mjs";

test("classifies execution stages without conflating invalid output with transport", () => {
  assert.equal(failureReasonForStage("tiny_call"), "tiny_transport_failure");
  assert.equal(failureReasonForStage("candidate_validation"), "tiny_invalid_candidate");
  assert.equal(failureReasonForStage("verification"), "verification_execution_failure");
  assert.equal(failureReasonForStage("apply"), "candidate_apply_failure");
});

test("runtime failure outcome preserves workspace mutation state", () => {
  const outcome = buildRuntimeFailureOutcome({
    stage: "verification",
    workspaceModified: true,
    error: "dotnet failed to start",
    attempts: [{ attempt: 1 }]
  });

  assert.equal(outcome.status, "needs_main_model");
  assert.equal(outcome.workspace_modified, true);
  assert.equal(outcome.reason, "verification_execution_failure");
  assert.equal(outcome.attempts.length, 1);
});
