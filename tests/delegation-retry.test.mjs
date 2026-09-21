import test from "node:test";
import assert from "node:assert/strict";
import {
  buildModelOutputEscalation,
  buildModelOutputRepairPacket,
  canRetryModelOutput
} from "../src/delegation-retry.mjs";

test("model-output failures retry only before mutation and before max attempt", () => {
  assert.equal(canRetryModelOutput({ attempt: 1, maxAttempts: 3, workspaceModified: false }), true);
  assert.equal(canRetryModelOutput({ attempt: 3, maxAttempts: 3, workspaceModified: false }), false);
  assert.equal(canRetryModelOutput({ attempt: 1, maxAttempts: 3, workspaceModified: true }), false);
});

test("retry packet gives bounded corrective feedback without changing task scope", () => {
  const packet = buildModelOutputRepairPacket({
    attempt: 1,
    candidate: { status: "candidate", changes: [] },
    validationErrors: ["changes must contain at least one item"]
  });
  assert.equal(packet.kind, "model_output_failure");
  assert.equal(packet.repair_attempt, 1);
  assert.deepEqual(packet.validation_errors, ["changes must contain at least one item"]);
  assert.match(packet.instruction, /Do not expand scope/);
});

test("terminal model-output failure escalates separately from infrastructure", () => {
  const outcome = buildModelOutputEscalation({
    reason: "tiny_invalid_candidate",
    stage: "candidate_validation",
    attempt: 3,
    workspaceModified: false,
    changedFiles: [],
    attempts: [{ attempt: 1 }, { attempt: 2 }]
  });
  assert.equal(outcome.status, "needs_main_model");
  assert.equal(outcome.reason, "tiny_invalid_candidate");
  assert.equal(outcome.workspace_modified, false);
});
