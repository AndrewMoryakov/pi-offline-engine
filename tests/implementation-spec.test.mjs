import test from "node:test";
import assert from "node:assert/strict";
import { validateImplementationSpec, validateCandidate, isSafeRelativePath } from "../src/implementation-spec.mjs";

const spec = {
  version: 1,
  spec_id: "retry-001",
  operation: "modify_symbol",
  goal: { summary: "Propagate cancellation into delay" },
  target: { file: "src/RetryPolicy.cs", symbol: "RetryPolicy.ExecuteAsync" },
  requirements: ["Pass cancellation token to Task.Delay"],
  scope: { allowed_files: ["src/RetryPolicy.cs"], allow_new_files: false },
  verification: { build: { project: "src/App.csproj" }, tests: ["RetryPolicyTests.Cancellation"] }
};

test("accepts a bounded implementation spec", () => {
  assert.equal(validateImplementationSpec(spec).ok, true);
});

test("rejects traversal paths", () => {
  const bad = structuredClone(spec);
  bad.target.file = "../secret";
  bad.scope.allowed_files = ["../secret"];
  assert.equal(validateImplementationSpec(bad).ok, false);
  assert.equal(isSafeRelativePath("../x"), false);
  assert.equal(isSafeRelativePath("src/x.cs"), true);
});

test("rejects candidate outside allowed scope", () => {
  const candidate = {
    status: "candidate",
    changes: [{ path: "src/Other.cs", operation: "replace_symbol", symbol: "Other.Run", content: "void Run() {}" }]
  };
  const result = validateCandidate(candidate, spec);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /outside allowed scope/);
});

test("accepts bounded candidate", () => {
  const candidate = {
    status: "candidate",
    changes: [{ path: "src/RetryPolicy.cs", operation: "replace_symbol", symbol: "RetryPolicy.ExecuteAsync", content: "async Task ExecuteAsync() {}" }]
  };
  assert.equal(validateCandidate(candidate, spec).ok, true);
});
