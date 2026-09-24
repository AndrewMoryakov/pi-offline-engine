export function buildMinimalToolSet(allTools, platform = process.platform, activeToolNames = null) {
  const names = new Set(allTools.map((tool) => tool.name));
  // Hybrid edit: `edit` hidden by scriptEditPolicy stays hidden in minimal.
  // Spec: docs/HYBRID_EDIT_V0.md HE-7.
  if (names.has("line_edit") && activeToolNames && !activeToolNames.includes("edit")) names.delete("edit");
  const selected = [];

  const add = (name) => {
    if (names.has(name) && !selected.includes(name)) selected.push(name);
  };

  add("read");
  add("edit");
  add("line_edit");
  add("write");

  if (platform === "win32" && names.has("powershell")) add("powershell");
  else if (names.has("bash")) add("bash");
  else if (names.has("powershell")) add("powershell");

  if (names.has("code")) add("code");
  else {
    add("grep");
    add("find");
    add("ls");
  }

  if (names.has("knowledge_search")) {
    add("knowledge_search");
    add("knowledge_symbol_search");
  } else {
    add("grep");
    add("find");
  }

  if (names.has("lsp_diagnostics")) {
    add("lsp_diagnostics");
    add("lsp_definition");
    add("lsp_references");
  } else {
    add("list_symbols");
    add("find_definition");
    add("get_symbol_body");
  }

  add("execute_delegated_implementation");
  add("delegate_implementation");

  return selected;
}
