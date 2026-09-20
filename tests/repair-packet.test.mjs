import test from "node:test";
import assert from "node:assert/strict";
import { buildRepairPacket } from "../src/repair-packet.mjs";

test("repair packet carries previous generated content for stateless retries", () => {
  const packet = buildRepairPacket({
    spec: { spec_id: "retry-1", goal: { summary: "fix retry" } },
    attempt: 1,
    candidate: {
      changes: [
        {
          path: "src/Retry.cs",
          operation: "replace_text",
          expected: "return 1;",
          content: "return 2;"
        }
      ]
    },
    verification: {
      passed: false,
      diagnostics: ["Retry.cs(10,1): error CS1002"],
      checks: [{ kind: "build", passed: false, code: 1, killed: false, artifact: ".pi/x.log" }]
    }
  });

  assert.equal(packet.previous_changes[0].content, "return 2;");
  assert.equal(packet.verification.diagnostics.length, 1);
  assert.equal(packet.repair_attempt, 1);
});


test("repair packet carries runner and executed-test evidence", () => {
  const packet = buildRepairPacket({
    spec: { spec_id: "retry-tests", goal: { summary: "repair failing test" } },
    attempt: 2,
    candidate: {
      changes: [{ path: "src/A.cs", operation: "replace_text", expected: "old", content: "new" }]
    },
    verification: {
      passed: false,
      diagnostics: ["zero tests executed"],
      checks: [{
        kind: "tests-1",
        passed: false,
        code: 0,
        killed: false,
        artifact: ".pi/build.log",
        resultArtifact: ".pi/results.trx",
        runner: "vstest",
        testPattern: "A.Tests.Case",
        expectedTestPatterns: ["A.Tests.Case"],
        testCount: 0,
        executedTestCount: 0
      }]
    }
  });

  const check = packet.verification.checks[0];
  assert.equal(check.runner, "vstest");
  assert.equal(check.testPattern, "A.Tests.Case");
  assert.equal(check.executedTestCount, 0);
  assert.equal(check.resultArtifact, ".pi/results.trx");
});
