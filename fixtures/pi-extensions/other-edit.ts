import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Stands in for another package that overrides `edit` (pi-utils' script
// edit), so gate:edit can reproduce the startup conflict without it. The
// probe command reports the registered and active tool names as JSON.
// Spec: docs/HYBRID_EDIT_V0.md HE-9.
export default function otherEdit(pi: ExtensionAPI) {
  // GATE_FIXTURE_NO_EDIT=1 loads only the probe, for the lean-mode schema check.
  if (process.env.GATE_FIXTURE_NO_EDIT !== "1") pi.registerTool({
    name: "edit",
    label: "edit",
    description: "Fixture edit tool (gate:edit).",
    parameters: { type: "object", properties: {} } as any,
    async execute() {
      return { content: [{ type: "text", text: "fixture" }], details: undefined };
    }
  });
  pi.registerCommand("probe-edit-tools", {
    description: "gate:edit probe",
    handler: async (_args, ctx) => {
      const all = pi.getAllTools().map((tool) => ({
        name: tool.name,
        source: tool.sourceInfo?.path ?? "",
        topLevelUnion: Array.isArray((tool.parameters as any)?.anyOf) && (tool.parameters as any)?.properties === undefined
      }));
      ctx.ui.notify(`PROBE ${JSON.stringify({ all, active: pi.getActiveTools() })}`, "info");
    }
  });
}
