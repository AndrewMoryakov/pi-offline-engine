import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { flattenLeanEditTool, flattenObjectUnion } from "../src/tool-schema.mjs";

// Spec: docs/HYBRID_EDIT_V0.md HE-11. The fixture is pi-lean-edit 0.3.6's edit
// schema as pi reports it through getAllTools().
const leanEditParameters = JSON.parse(fs.readFileSync(new URL("./fixtures/pi-lean-edit-0.3.6-edit-parameters.json", import.meta.url), "utf8"));

test("pi-lean-edit's union schema becomes one object with top-level properties", () => {
  const flat = flattenObjectUnion(leanEditParameters);
  assert.equal("anyOf" in flat, false);
  assert.equal(flat.type, "object");
  assert.deepEqual(Object.keys(flat.properties).sort(), ["edits", "endColumn", "endLine", "newText", "path", "startColumn", "startLine"]);
  assert.deepEqual(flat.required, ["path"]);
  assert.equal(flat.additionalProperties, false);
  assert.equal(flat.properties.startLine.type, "integer");
});

test("array items are flattened too, keeping what every item variant requires", () => {
  const items = flattenObjectUnion(leanEditParameters).properties.edits.items;
  assert.equal("anyOf" in items, false);
  assert.deepEqual(items.required.sort(), ["newText", "startLine"]);
  assert.deepEqual(Object.keys(items.properties).sort(), ["endColumn", "endLine", "newText", "startColumn", "startLine"]);
});

test("schemas that already have properties, or unions of non-objects, are left alone", () => {
  const plain = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  assert.deepEqual(flattenObjectUnion(plain), plain);
  const scalars = { anyOf: [{ type: "string" }, { type: "number" }] };
  assert.deepEqual(flattenObjectUnion(scalars), scalars);
});

test("only pi-lean-edit's edit is touched, and nothing but its parameters", () => {
  const read = { name: "read", parameters: leanEditParameters };
  assert.equal(flattenLeanEditTool(read), read);
  const edit = { name: "edit", label: "edit", parameters: leanEditParameters, execute: () => "same" };
  const flat = flattenLeanEditTool(edit);
  assert.equal(flat.name, "edit");
  assert.equal(flat.execute(), "same");
  assert.equal("anyOf" in flat.parameters, false);
  assert.equal("anyOf" in leanEditParameters, true, "the input schema must not be mutated");
});
