import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportTrainingData, redactString } from "../src/training-exporter.mjs";

function row({ id, passed, pathName = "src/A.cs", content = "return 2;" }) {
  return {
    schema_version: 1,
    kind: "implementation_attempt",
    run_id: "run-" + id,
    spec_id: "spec-" + id,
    model: "tiny",
    attempt: 1,
    input: {
      implementation_spec: {
        version: 1,
        spec_id: "spec-" + id,
        target: { file: pathName },
        scope: { allowed_files: [pathName] }
      },
      context: { source: "api_key=supersecret12345\nreturn 1;" },
      repair_packet: null
    },
    output: {
      candidate: {
        status: "candidate",
        changes: [{ path: pathName, operation: "replace_text", expected: "return 1;", content }]
      }
    },
    supervision: {
      outcome: passed ? "verification_passed" : "verification_failed",
      verification_passed: passed,
      diagnostics: [],
      checks: []
    }
  };
}

test("exports success-only SFT and labeled unpaired preference datasets", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-export-"));
  const input = path.join(cwd, "raw.jsonl");
  await fs.writeFile(input, [row({ id: "a", passed: true }), row({ id: "b", passed: false })]
    .map(JSON.stringify).join("\n") + "\n", "utf8");

  const result = await exportTrainingData({ cwd, inputFile: input });
  assert.equal(result.sft_examples, 1);
  assert.equal(result.preference_examples, 2);
  assert.equal(result.eval_examples, 2);

  const sft = (await fs.readFile(path.join(cwd, ".pi/offline-engine/training/export/sft.jsonl"), "utf8")).trim();
  assert.doesNotMatch(sft, /supersecret12345/);
  assert.match(sft, /REDACTED_SECRET/);
});

test("drops sensitive paths and exact duplicate examples", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-export-"));
  const input = path.join(cwd, "raw.jsonl");
  const good = row({ id: "a", passed: true });
  const duplicate = structuredClone(good);
  duplicate.run_id = "another-run";
  const sensitive = row({ id: "secret", passed: true, pathName: ".env" });
  await fs.writeFile(input, [good, duplicate, sensitive].map(JSON.stringify).join("\n") + "\n", "utf8");

  const result = await exportTrainingData({ cwd, inputFile: input });
  assert.equal(result.sft_examples, 1);
  assert.equal(result.dropped_duplicate, 1);
  assert.equal(result.dropped_sensitive, 1);
});

test("redacts common secret assignments", () => {
  assert.equal(redactString("token=abcdefghijk"), "[REDACTED_SECRET]");
});
