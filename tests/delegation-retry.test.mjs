import test from "node:test";
import assert from "node:assert/strict";
import {
  buildModelOutputEscalation,
  buildModelOutputRepairPacket,
  canRetryModelOutput
} from "../src/delegation-retry.mjs";

test("model-output failures retry through the bounded attempt limit", () => {
  assert.equal(canRetryModelOutput({ attempt: 1, maxAttempts: 3 }), true);
  assert.equal(canRetryModelOutput({ attempt: 2, maxAttempts: 3 }), true);
  assert.equal(canRetryModelOutput({ attempt: 3, maxAttempts: 3 }), false);
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


test("model-output retry preserves prior verification context", () => {
  const prior = { kind: "verification_failure", diagnostics: ["CS1002"] };
  const packet = buildModelOutputRepairPacket({
    attempt: 2,
    error: "malformed JSON",
    priorRepairPacket: prior
  });
  assert.deepEqual(packet.prior_repair_packet, prior);
});
