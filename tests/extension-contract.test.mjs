import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("../extensions/index.ts", import.meta.url), "utf8");

test("extension exposes strict ImplementationSpec schema", () => {
  assert.match(source, /const ImplementationSpecSchema = Type\.Object/);
  assert.match(source, /operation: Type\.Literal\("modify_symbol"\)/);
  assert.match(source, /allowed_files: Type\.Array\(NonEmptyString, \{ minItems: 1, maxItems: 2 \}\)/);
  assert.doesNotMatch(source, /spec:\s*Type\.Object\(\{\},\s*\{ additionalProperties: true \}\)/);
});

test("mechanical verification is not presented as semantic task completion", () => {
  assert.match(source, /status: "verification_passed"/);
  assert.match(source, /task_complete: false/);
  assert.doesNotMatch(source, /status: "verified"/);
});

test("tool guidelines contain no accidental literal newline escape between array items", () => {
  assert.equal(source.includes('decided.",\\n      "A verification_passed'), false);
});

test("delegated tool forbids sibling mutating calls in its guideline", () => {
  assert.match(source, /only mutating tool in its assistant turn/);
});

test("repository capsule is refreshed after session compaction", () => {
  assert.match(source, /pi\.on\("session_compact"/);
  assert.match(source, /lastRepoCapsuleFingerprint = null/);
});

test("TinyCoder nested usage is returned to Pi session accounting", () => {
  assert.match(source, /usage: nestedUsage/);
  assert.match(source, /toPiUsage\(result\.usage\)/);
});

test("delegated execution preflights verification before TinyCoder", () => {
  const preflightIndex = source.indexOf("preflightVerificationInfrastructure({");
  const tinyLoopIndex = source.indexOf("for (let attempt = 1; attempt <= maxAttempts");
  assert.ok(preflightIndex >= 0);
  assert.ok(tinyLoopIndex >= 0);
  assert.ok(preflightIndex < tinyLoopIndex);
});

test("training capture is opt-in and exposes explicit controls", () => {
  assert.match(source, /PI_OFFLINE_TRAINING_CAPTURE === "1"/);
  assert.match(source, /pi\.registerCommand\("offline-training"/);
  assert.match(source, /trainingCaptureEnabled = true/);
  assert.match(source, /trainingCaptureEnabled = false/);
});

test("training recording is best-effort and not a coding-state authority", () => {
  assert.match(source, /safeAppendTrainingRecord/);
  assert.match(source, /Training capture and its telemetry must never affect the coding task/);
});
