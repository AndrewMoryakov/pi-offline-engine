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
  verification: {
    build: { project: "src/App.csproj" },
    tests: { project: "tests/App.Tests.csproj", names: ["RetryPolicyTests.Cancellation"] }
  }
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

test("rejects more than two delegated files", () => {
  const bad = structuredClone(spec);
  bad.scope.allowed_files = ["src/RetryPolicy.cs", "src/A.cs", "src/B.cs"];
  assert.equal(validateImplementationSpec(bad).ok, false);
});

test("rejects candidate outside allowed scope", () => {
  const candidate = {
    status: "candidate",
    changes: [{ path: "src/Other.cs", operation: "replace_text", expected: "old", content: "new" }]
  };
  const result = validateCandidate(candidate, spec);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /outside allowed scope/);
});

test("accepts exact replacement candidate", () => {
  const candidate = {
    status: "candidate",
    changes: [{ path: "src/RetryPolicy.cs", operation: "replace_text", expected: "Task.Delay(delay)", content: "Task.Delay(delay, cancellationToken)" }]
  };
  assert.equal(validateCandidate(candidate, spec).ok, true);
});

test("create_file requires explicit permission and allowed path", () => {
  const candidate = { status: "candidate", changes: [{ path: "src/New.cs", operation: "create_file", content: "class New {}" }] };
  assert.equal(validateCandidate(candidate, spec).ok, false);

  const allowed = structuredClone(spec);
  allowed.scope.allowed_files.push("src/New.cs");
  allowed.scope.allow_new_files = true;
  assert.equal(validateCandidate(candidate, allowed).ok, true);
});


test("rejects unknown spec operations", () => {
  const bad = structuredClone(spec);
  bad.operation = "do_whatever";
  assert.equal(validateImplementationSpec(bad).ok, false);
});

test("requires explicit scope policy booleans", () => {
  const bad = structuredClone(spec);
  delete bad.scope.allow_new_files;
  assert.equal(validateImplementationSpec(bad).ok, false);
});
