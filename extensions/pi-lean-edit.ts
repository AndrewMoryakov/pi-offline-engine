import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import leanEdit from "pi-lean-edit";
import { engineConfigPath, readEngineConfig, resolveEditProvider } from "../src/engine-config.mjs";

// Loads the bundled pi-lean-edit (read/edit/write) unless editProvider is
// "none". Pi rejects a second registration of a tool name and aborts startup,
// and it gives extensions no way to see other packages' tools while they load,
// so another `edit` override (e.g. pi-utils) can only be resolved by choosing
// one here. The file keeps pi-lean-edit's name so the tools' source path in
// /offline-doctor still names it.
export default function leanEditProvider(pi: ExtensionAPI) {
  const { config } = readEngineConfig(engineConfigPath(getAgentDir()));
  if (resolveEditProvider({ env: process.env, config }).value !== "lean") return;
  leanEdit(pi);
}
