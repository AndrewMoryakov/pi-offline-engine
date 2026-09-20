import test from "node:test";
import assert from "node:assert/strict";
import { buildMinimalToolSet } from "../src/tool-profile.mjs";

function tools(names) {
  return names.map((name) => ({ name }));
}

test("minimal profile prefers code, knowledge and LSP when present", () => {
  const selected = buildMinimalToolSet(tools([
    "read", "edit", "write", "bash", "grep", "find", "ls",
    "code", "knowledge_search", "knowledge_symbol_search",
    "lsp_diagnostics", "lsp_definition", "lsp_references",
    "execute_delegated_implementation", "delegate_implementation"
  ]), "linux");

  assert.ok(selected.includes("code"));
  assert.ok(selected.includes("knowledge_search"));
  assert.ok(selected.includes("lsp_diagnostics"));
  assert.equal(selected.includes("grep"), false);
  assert.equal(selected.includes("find"), false);
});

test("minimal profile keeps builtin search fallbacks when higher-level tools are absent", () => {
  const selected = buildMinimalToolSet(tools([
    "read", "edit", "write", "bash", "grep", "find", "ls",
    "execute_delegated_implementation", "delegate_implementation"
  ]), "linux");

  assert.ok(selected.includes("grep"));
  assert.ok(selected.includes("find"));
  assert.ok(selected.includes("ls"));
});


test("minimal profile falls back to bash on Windows when powershell tool is absent", () => {
  const selected = buildMinimalToolSet(tools([
    "read", "edit", "write", "bash", "grep", "find", "ls",
    "execute_delegated_implementation", "delegate_implementation"
  ]), "win32");

  assert.ok(selected.includes("bash"));
});
