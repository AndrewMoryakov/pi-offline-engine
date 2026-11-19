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
