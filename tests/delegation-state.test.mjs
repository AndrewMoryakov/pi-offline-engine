import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRuntimeFailureOutcome,
  buildTinyTerminalOutcome,
  failureReasonForStage,
  summarizeVerification
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

test("summarizeVerification keeps the verdict, the failures and the log paths, not the executed test list", () => {
  const summary = summarizeVerification({
    passed: false,
    diagnostics: ["Result: Tests FAILED, 1 failed, 2 passed, 0 skipped of 3"],
    checks: [{ kind: "tests", passed: false, code: 2, killed: false, diagnostics: ["x"], artifact: "a.log", resultArtifact: "r.trx", executedTestIdentities: ["A.B", "A.C"], runner: "mtp" }]
  }, 2);
  assert.equal(summary.attempt, 2);
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.checks[0], { kind: "tests", passed: false, code: 2, killed: false, diagnostics: ["x"], artifact: "a.log", resultArtifact: "r.trx" });
  assert.equal(summarizeVerification(null), null);
});

test("terminal status after mutation includes the last verification when it is given", () => {
  const outcome = buildTinyTerminalOutcome({
    terminalStatus: "cannot_safely_implement",
    reason: "outside scope",
    attempt: 2,
    usage: null,
    workspaceModified: true,
    changedFiles: ["src/A.cs"],
    lastVerification: { attempt: 1, passed: false, checks: [] }
  });
  assert.deepEqual(outcome.last_verification, { attempt: 1, passed: false, checks: [] });
});
