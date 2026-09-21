import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCodeToolPolicy,
  selectActiveToolObjects
} from "../src/extension-policy.mjs";

test("code policy mutates prompt guidelines only when code tool is active", () => {
  const options = { selectedTools: ["read", "code"], promptGuidelines: [] };
  assert.equal(applyCodeToolPolicy(options), true);
  assert.equal(options.promptGuidelines.length, 3);
  assert.match(options.promptGuidelines[0], /read-only filtering/);

  applyCodeToolPolicy(options);
  assert.equal(options.promptGuidelines.length, 3, "policy is idempotent");

  const inactive = { selectedTools: ["read"], promptGuidelines: [] };
  assert.equal(applyCodeToolPolicy(inactive), false);
  assert.deepEqual(inactive.promptGuidelines, []);
});

test("active tool selection excludes registered but inactive tools", () => {
  const all = [{ name: "read" }, { name: "code" }, { name: "edit" }];
  assert.deepEqual(
    selectActiveToolObjects(all, ["read", "edit"]).map((x) => x.name),
    ["read", "edit"]
  );
});
