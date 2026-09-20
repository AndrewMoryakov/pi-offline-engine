import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runVerification } from "../src/verification.mjs";

const baseSpec = {
  spec_id: "verify-001",
  verification: {
    build: { project: "src/App.csproj" },
    tests: { project: "tests/App.Tests.csproj", names: ["RetryTests.Cancellation", "RetryTests.Backoff"] }
  }
};

test("runs build before filtered tests", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, args]);
    return { code: 0, killed: false, stdout: "ok", stderr: "" };
  };

  const result = await runVerification({ cwd, spec: baseSpec, exec, attempt: 1 });
  assert.equal(result.passed, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][1].slice(0, 2), ["build", "src/App.csproj"]);
  assert.equal(calls[1][1][0], "test");
  assert.ok(calls[1][1].includes("--filter"));
});

test("does not run tests after failed build", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
  let calls = 0;
  const exec = async () => {
    calls += 1;
    return { code: 1, killed: false, stdout: "Program.cs(1,1): error CS1002: ; expected", stderr: "" };
  };

  const result = await runVerification({ cwd, spec: baseSpec, exec, attempt: 1 });
  assert.equal(result.passed, false);
  assert.equal(calls, 1);
  assert.match(result.diagnostics.join("\n"), /CS1002/);
});
