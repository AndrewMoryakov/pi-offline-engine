import assert from "node:assert/strict";
import test from "node:test";
import { formatExecutionResult } from "../src/delegation-results.mjs";

const attempts = [
  { attempt: 1, changedFiles: ["src/A.cs"], verificationPassed: false },
  { attempt: 2, changedFiles: ["src/A.cs"], verificationPassed: false },
  { attempt: 3, changedFiles: ["src/A.cs"], verificationPassed: false }
];

test("attempts is the list of per-attempt records in both content and details when attempts are exhausted", () => {
  const result = formatExecutionResult({
    kind: "attempts_exhausted",
    maxAttempts: 3,
    attempts,
    workspaceModified: true,
    changedFiles: new Set(["src/A.cs"]),
    verification: { passed: false },
    nestedUsage: undefined
  });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.reason, "tiny_implementation_attempts_exhausted");
  assert.deepEqual(body.attempts, attempts);
  assert.deepEqual(result.details.attempts, attempts);
});

test("exhausted attempts return the last verification as a summary without the executed test names", () => {
  const verification = {
    passed: false,
    diagnostics: ["Result: Tests FAILED, 1 failed, 2 passed, 0 skipped of 3"],
    checks: [{ kind: "tests", passed: false, code: 2, killed: false, diagnostics: ["Result: Tests FAILED, 1 failed, 2 passed, 0 skipped of 3"], artifact: "a.log", resultArtifact: "r.trx", executedTestIdentities: ["A.B", "A.C", "A.D"], runner: "mtp", testCount: 3 }]
  };
  const result = formatExecutionResult({
    kind: "attempts_exhausted", maxAttempts: 3, attempts, workspaceModified: true, changedFiles: new Set(["src/A.cs"]),
    verification, verificationAttempt: 3, nestedUsage: undefined
  });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.verification, undefined);
  assert.equal(body.last_verification.attempt, 3);
  assert.equal(body.last_verification.checks[0].resultArtifact, "r.trx");
  assert.equal(JSON.stringify(body).includes("executedTestIdentities"), false);
  // The details object for the host keeps the full verification.
  assert.deepEqual(result.details.verification, verification);
});
