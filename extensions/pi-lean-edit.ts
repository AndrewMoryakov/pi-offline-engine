import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import leanEdit from "pi-lean-edit";
import { engineConfigPath, readEngineConfig, resolveEditProvider, resolveScriptEditPolicy } from "../src/engine-config.mjs";
import { planScriptEditActivation, renameLeanEditTool } from "../src/edit-routing.mjs";

// Loads the bundled pi-lean-edit (read/edit/write) unless editProvider is
// "none". Pi rejects a second registration of a tool name and aborts startup,
// and it gives extensions no way to see other packages' tools while they load,
// so another `edit` override (e.g. pi-utils) can only be resolved by choosing
// one here. The file keeps pi-lean-edit's name so the tools' source path in
// /offline-doctor still names it.
//
// "hybrid" registers pi-lean-edit's edit as `line_edit` instead, so the other
// `edit` loads too, and offers that `edit` to the model per scriptEditPolicy.
export default function leanEditProvider(pi: ExtensionAPI) {
  const { config } = readEngineConfig(engineConfigPath(getAgentDir()));
  const provider = resolveEditProvider({ env: process.env, config }).value;
  if (provider === "lean") {
    leanEdit(pi);
    return;
  }
  if (provider !== "hybrid") return;

  // pi's API object may rely on `this`, so every other member is passed
  // through bound to the original.
  const renaming = new Proxy(pi, {
    get(target, key) {
      if (key === "registerTool") return (tool: any) => target.registerTool(renameLeanEditTool(tool));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  leanEdit(renaming);

  const policy = resolveScriptEditPolicy({ env: process.env, config }).value;
  let hiddenByPolicy = false;
  const apply = (model: ExtensionContext["model"]) => {
    const plan = planScriptEditActivation({
      allToolNames: pi.getAllTools().map((tool) => tool.name),
      activeToolNames: pi.getActiveTools(),
      model,
      policy,
      hiddenByPolicy
    });
    hiddenByPolicy = plan.hiddenByPolicy;
    if (plan.changed) pi.setActiveTools(plan.activeToolNames);
  };
  pi.on("session_start", async (_event, ctx) => apply(ctx.model));
  pi.on("model_select", async (event) => apply(event.model));
}
