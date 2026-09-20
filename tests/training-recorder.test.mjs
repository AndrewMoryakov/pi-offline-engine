import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendTrainingRecord,
  createTrainingRunId,
  hasSensitiveTrainingPath,
  makeImplementationAttemptRecord
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
