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
