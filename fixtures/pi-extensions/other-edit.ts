import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Stands in for another package that overrides `edit` (pi-utils' script
// edit), so gate:edit can reproduce the startup conflict without it. The
// probe command reports the registered and active tool names as JSON.
// Spec: docs/HYBRID_EDIT_V0.md HE-9.
export default function otherEdit(pi: ExtensionAPI) {
  pi.registerTool({
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
      const all = pi.getAllTools().map((tool) => ({ name: tool.name, source: tool.sourceInfo?.path ?? "" }));
      ctx.ui.notify(`PROBE ${JSON.stringify({ all, active: pi.getActiveTools() })}`, "info");
    }
  });
}
