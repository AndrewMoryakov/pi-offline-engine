import { endpointHost, isLocalHost } from "./endpoint-locality.mjs";

// Hybrid edit provider: pi-lean-edit's range edit is registered under this
// name, and the tool registered as `edit` by another package (pi-utils' script
// edit) or by Pi itself stays beside it.
// Spec: docs/HYBRID_EDIT_V0.md HE-2, HE-4.
export const LINE_EDIT_TOOL = "line_edit";
export const SCRIPT_EDIT_TOOL = "edit";

// pi-lean-edit hard-codes the name `edit`, and its prompt guidelines address
// the tool by that name ("edit: use after read ..."). Renaming only the
// registration would leave the model told to call a tool it cannot see, so
// the guidelines are rewritten with it, and one line says when to use which.
// Spec: docs/HYBRID_EDIT_V0.md HE-4.
export function renameLeanEditTool(tool) {
  if (!tool || tool.name !== "edit") return tool;
  const guidelines = (tool.promptGuidelines ?? []).map((line) =>
    line.replace(/^edit:/, `${LINE_EDIT_TOOL}:`).replace(/\bedit returns\b/g, `${LINE_EDIT_TOOL} returns`)
  );
  guidelines.push(
    `${LINE_EDIT_TOOL}: prefer it for targeted changes to lines you have read. When a tool named ${SCRIPT_EDIT_TOOL} is also available, it edits files by running a script and suits one mechanical change repeated across many files.`
  );
  return {
    ...tool,
    name: LINE_EDIT_TOOL,
    label: LINE_EDIT_TOOL,
    promptGuidelines: guidelines
  };
}

// true / false when the model's baseUrl can be judged, null when it cannot
// (no model yet, or a provider without a baseUrl).
// Spec: docs/HYBRID_EDIT_V0.md HE-5.
export function isLocalModel(model) {
  const host = endpointHost(model?.baseUrl);
  return host === null ? null : isLocalHost(host);
}

// Decides whether the script edit should be offered for this model, and
// returns the new active tool list. Only SCRIPT_EDIT_TOOL is ever added or
// removed, and it is added back only if this policy removed it: /offline-tools
// minimal and the user's own tool choices stay untouched.
// Spec: docs/HYBRID_EDIT_V0.md HE-5, HE-6 (policy values), HE-7 (touch only `edit`).
export function planScriptEditActivation({ allToolNames, activeToolNames, model, policy, hiddenByPolicy }) {
  const unchanged = (reason) => ({ activeToolNames, hiddenByPolicy, changed: false, reason });
  const all = new Set(allToolNames);
  if (!all.has(LINE_EDIT_TOOL) || !all.has(SCRIPT_EDIT_TOOL)) {
    return unchanged("hybrid needs both line_edit and edit registered");
  }

  const local = isLocalModel(model);
  const hide = policy === "never" || (policy === "cloud-only" && local === true);
  const active = activeToolNames.includes(SCRIPT_EDIT_TOOL);
  const reason = describeDecision(policy, local, hide);
  if (policy === "cloud-only" && local === null) return unchanged(reason);

  if (hide && active) {
    return {
      activeToolNames: activeToolNames.filter((name) => name !== SCRIPT_EDIT_TOOL),
      hiddenByPolicy: true,
      changed: true,
      reason
    };
  }
  if (!hide && !active && hiddenByPolicy) {
    return { activeToolNames: [...activeToolNames, SCRIPT_EDIT_TOOL], hiddenByPolicy: false, changed: true, reason };
  }
  return unchanged(reason);
}

function describeDecision(policy, local, hide) {
  if (policy === "never") return "scriptEditPolicy=never";
  if (policy === "always") return "scriptEditPolicy=always";
  if (local === null) return "model locality unknown; edit left as is";
  return hide ? "local model (scriptEditPolicy=cloud-only)" : "remote model (scriptEditPolicy=cloud-only)";
}
