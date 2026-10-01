// Static wiring guards for the extension module structure
// (docs/INDEX_REFACTOR_SPEC.md sections 7, 9 and 12). Runtime semantics are
// covered behaviorally elsewhere; these only catch dependency-direction drift.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const list = (dir, ext) => fs.readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((name) => name.endsWith(ext)).map((name) => `${dir}/${name}`);
const imports = (source) => [...source.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);

test("extensions/index.ts stays a composition root of at most 100 lines", () => {
  const source = read("extensions/index.ts");
  assert.ok(source.split("\n").length <= 100);
  assert.doesNotMatch(source, /registerTool|registerCommand|pi\.on\(/);
});

test("src modules never import from extensions/ or Pi", () => {
  for (const file of list("src", ".mjs")) {
    for (const specifier of imports(read(file))) {
      assert.ok(!specifier.includes("extensions/"), `${file} imports ${specifier}`);
      assert.ok(!specifier.startsWith("@earendil-works/"), `${file} imports ${specifier}`);
    }
  }
});

test("registration modules do not import each other", () => {
  const registration = list("extensions", ".ts").filter((file) => /\/register-/.test(file));
  assert.equal(registration.length, 3);
  for (const file of registration) {
    for (const specifier of imports(read(file))) {
      assert.ok(!/register-/.test(specifier), `${file} imports ${specifier}`);
    }
  }
});

test("only the attempt module reaches the TinyCoder transport from the delegation path", () => {
  // instanceof TinyModelOutputError must see the class the transport throws.
  for (const file of [...list("extensions", ".ts"), ...list("src", ".mjs")]) {
    const usesClient = imports(read(file)).some((specifier) => specifier.endsWith("tiny-client.mjs"));
    if (!usesClient) continue;
    assert.ok(
      ["src/delegation-attempt.mjs", "src/offline-doctor.mjs"].includes(file),
      `${file} imports tiny-client.mjs directly`
    );
  }
});
