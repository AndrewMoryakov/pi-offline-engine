import test from "node:test";
import assert from "node:assert/strict";
import { isLocalModel, planScriptEditActivation, renameLeanEditTool } from "../src/edit-routing.mjs";
import { resolveScriptEditPolicy } from "../src/engine-config.mjs";
import { buildMinimalToolSet } from "../src/tool-profile.mjs";

const LOCAL = { baseUrl: "http://127.0.0.1:8080/v1" };
const REMOTE = { baseUrl: "https://chatgpt.com/backend-api" };
const BOTH = ["read", "line_edit", "edit", "write", "bash"];

function plan(overrides) {
  return planScriptEditActivation({
    allToolNames: BOTH,
    activeToolNames: BOTH,
    model: REMOTE,
    policy: "cloud-only",
    hiddenByPolicy: false,
    ...overrides
  });
}

test("renaming pi-lean-edit's edit rewrites the guidelines that name it", () => {
  const renamed = renameLeanEditTool({
    name: "edit",
    label: "edit",
    description: "Edit text file by line ranges.",
    promptGuidelines: [
      "edit: use after read for same file/ranges; if requested text was not read or has changed, edit returns the current text without applying.",
      "edit: use edits[] for multiple non-overlapping ranges."
    ],
    execute: () => "unchanged"
  });
  assert.equal(renamed.name, "line_edit");
  assert.equal(renamed.label, "line_edit");
  assert.equal(renamed.execute(), "unchanged");
  assert.match(renamed.promptGuidelines[0], /^line_edit: use after read/);
  assert.match(renamed.promptGuidelines[0], /line_edit returns the current text/);
  assert.match(renamed.promptGuidelines[1], /^line_edit: use edits\[\]/);
  assert.equal(renamed.promptGuidelines.some((line) => /^edit:/.test(line)), false);
  assert.match(renamed.promptGuidelines.at(-1), /tool named edit is also available/);
});

test("renaming leaves pi-lean-edit's read and write alone", () => {
  const read = { name: "read", label: "read" };
  assert.equal(renameLeanEditTool(read), read);
});

test("model locality comes from baseUrl, and is unknown without one", () => {
  assert.equal(isLocalModel(LOCAL), true);
  assert.equal(isLocalModel({ baseUrl: "http://192.168.1.20:1234" }), true);
  assert.equal(isLocalModel(REMOTE), false);
  assert.equal(isLocalModel(undefined), null);
  assert.equal(isLocalModel({ baseUrl: "" }), null);
});

test("cloud-only hides the script edit for a local model and brings it back for a remote one", () => {
  const hidden = plan({ model: LOCAL });
  assert.equal(hidden.changed, true);
  assert.deepEqual(hidden.activeToolNames, ["read", "line_edit", "write", "bash"]);
  assert.equal(hidden.hiddenByPolicy, true);

  const back = plan({ model: REMOTE, activeToolNames: hidden.activeToolNames, hiddenByPolicy: true });
  assert.equal(back.changed, true);
  assert.deepEqual(back.activeToolNames, ["read", "line_edit", "write", "bash", "edit"]);
  assert.equal(back.hiddenByPolicy, false);
});

test("an edit the user turned off is not turned back on", () => {
  const result = plan({ model: REMOTE, activeToolNames: ["read", "line_edit", "write"], hiddenByPolicy: false });
  assert.equal(result.changed, false);
  assert.deepEqual(result.activeToolNames, ["read", "line_edit", "write"]);
});

test("always and never ignore the model", () => {
  assert.equal(plan({ model: LOCAL, policy: "always" }).changed, false);
  const never = plan({ model: REMOTE, policy: "never" });
  assert.equal(never.changed, true);
  assert.equal(never.activeToolNames.includes("edit"), false);
});

test("unknown locality under cloud-only changes nothing", () => {
  const result = plan({ model: undefined, activeToolNames: ["read", "line_edit"], hiddenByPolicy: true });
  assert.equal(result.changed, false);
  assert.equal(result.hiddenByPolicy, true);
});

test("without both tools registered the policy does nothing", () => {
  const onlyLean = plan({ allToolNames: ["read", "line_edit"], activeToolNames: ["read", "line_edit"], model: LOCAL });
  assert.equal(onlyLean.changed, false);
  const onlyEdit = plan({ allToolNames: ["read", "edit"], activeToolNames: ["read", "edit"], model: LOCAL });
  assert.equal(onlyEdit.changed, false);
});

test("scriptEditPolicy resolves env over config over default and skips unknown values", () => {
  assert.deepEqual(resolveScriptEditPolicy({}), { value: "cloud-only", source: "default" });
  assert.deepEqual(resolveScriptEditPolicy({ config: { scriptEditPolicy: "Always" } }), { value: "always", source: "config" });
  assert.deepEqual(
    resolveScriptEditPolicy({ env: { PI_OFFLINE_SCRIPT_EDIT_POLICY: "never" }, config: { scriptEditPolicy: "always" } }),
    { value: "never", source: "env" }
  );
  assert.deepEqual(
    resolveScriptEditPolicy({ env: { PI_OFFLINE_SCRIPT_EDIT_POLICY: "sometimes" }, config: { scriptEditPolicy: "always" } }),
    { value: "always", source: "config" }
  );
});

test("minimal tool set keeps line_edit and does not revive a hidden script edit", () => {
  const all = BOTH.map((name) => ({ name }));
  assert.deepEqual(buildMinimalToolSet(all, "linux", BOTH).slice(0, 4), ["read", "edit", "line_edit", "write"]);
  const hiddenEdit = buildMinimalToolSet(all, "linux", ["read", "line_edit", "write", "bash"]);
  assert.equal(hiddenEdit.includes("edit"), false);
  assert.equal(hiddenEdit.includes("line_edit"), true);
});
