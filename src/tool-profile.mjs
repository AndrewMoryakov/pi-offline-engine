export function buildMinimalToolSet(allTools, platform = process.platform) {
  const names = new Set(allTools.map((tool) => tool.name));
  const selected = [];

  const add = (name) => {
    if (names.has(name) && !selected.includes(name)) selected.push(name);
  };

  add("read");
  add("edit");
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
