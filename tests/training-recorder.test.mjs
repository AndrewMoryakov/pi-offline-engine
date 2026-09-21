import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendTrainingRecord,
  createTrainingRunId,
  hasSensitiveTrainingPath,
  makeImplementationAttemptRecord,
  safeAppendTrainingRecord
} from "../src/training-recorder.mjs";

test("creates stable-safe run ids", () => {
  const id = createTrainingRunId("retry policy/001");
  assert.match(id, /^retry_policy_001-[a-f0-9]{16}$/);
});

test("blocks obvious secret-bearing paths from full training capture", () => {
  assert.equal(hasSensitiveTrainingPath({
    target: { file: ".env.production" },
    scope: { allowed_files: [".env.production"] }
  }), true);
  assert.equal(hasSensitiveTrainingPath({
    target: { file: "src/A.cs" },
    scope: { allowed_files: ["src/A.cs"] }
  }), false);
});

test("records a self-contained implementation attempt", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-training-"));
  const record = makeImplementationAttemptRecord({
    runId: "r1",
    model: "tiny",
    attempt: 1,
    spec: { spec_id: "s1", target: { file: "src/A.cs" }, scope: { allowed_files: ["src/A.cs"] } },
    context: { source: "return 1;" },
    repairPacket: null,
    candidate: { status: "candidate", changes: [] },
    verification: { passed: false, diagnostics: ["CS1002"], checks: [] },
    outcome: "verification_failed",
    usage: { inputTokens: 10, outputTokens: 2 },
    latencyMs: 123
  });

  const file = await appendTrainingRecord(cwd, record);
  const rows = (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run_id, "r1");
  assert.equal(rows[0].supervision.verification_passed, false);
  assert.equal(rows[0].input.context.source, "return 1;");
});


test("best-effort append returns an error instead of throwing into the coding path", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-training-fail-"));
  const blocker = path.join(cwd, ".pi");
  await fs.writeFile(blocker, "not a directory", "utf8");

  const result = await safeAppendTrainingRecord(cwd, { kind: "test" });
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});


test("candidate paths are included in sensitive-path detection", () => {
  const spec = {
    target: { file: "src/A.cs" },
    scope: { allowed_files: ["src/A.cs"] }
  };
  assert.equal(hasSensitiveTrainingPath(spec, {
    status: "candidate",
    changes: [{ path: ".env", operation: "create_file", content: "x" }]
  }), true);
});

test("best-effort raw capture skips a sensitive candidate path", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-training-sensitive-"));
  const result = await safeAppendTrainingRecord(cwd, {
    input: { implementation_spec: { target: { file: "src/A.cs" }, scope: { allowed_files: ["src/A.cs"] } } },
    output: { candidate: { changes: [{ path: "keys/private.pem" }] } }
  });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.error, "sensitive_path");
});
