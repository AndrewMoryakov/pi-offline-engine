export function applyCodeToolPolicy(systemPromptOptions) {
  const options = systemPromptOptions ?? {};
  if (!options.selectedTools?.includes("code")) return false;

  const guidelines = options.promptGuidelines ?? (options.promptGuidelines = []);
  const prefix = "pi-offline-engine:";
  const desired = [
    `${prefix} Use the code tool for read-only filtering, aggregation, search composition, and mechanical analysis.`,
    `${prefix} Do not invoke bash/edit/write from inside the code tool in this profile; those bridged calls bypass top-level edit/LSP extension lifecycles.`,
    `${prefix} Perform mutations through the active top-level edit/write tools or execute_delegated_implementation.`
  ];

  for (const guideline of desired) {
    if (!guidelines.includes(guideline)) guidelines.push(guideline);
  }
  return true;
}

export function selectActiveToolObjects(allTools, activeToolNames) {
  const active = new Set(activeToolNames ?? []);
  return (allTools ?? []).filter((tool) => active.has(tool.name));
}
