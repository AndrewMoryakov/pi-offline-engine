// Composition root of the pi-offline-engine extension: captures the engine
// config at module evaluation, then per factory invocation builds the
// runtime and registers tools, lifecycle hooks and commands, in that order.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { engineConfigPath } from "../src/engine-config.mjs";
import { applyCompanionEnvDefaults, createExtensionRuntime, readInitialEngineConfig } from "./extension-runtime.ts";
import { registerDelegationTools } from "./register-delegation-tools.ts";
import { registerLifecycleHooks } from "./register-lifecycle-hooks.ts";
import { registerOfflineCommands } from "./register-offline-commands.ts";

// Captured while this module is evaluated; each factory invocation builds its
// own runtime (and mutable config facade) from this snapshot.
const initialConfig = readInitialEngineConfig(engineConfigPath(getAgentDir()), process.env);

export default function offlineEngine(pi: ExtensionAPI) {
  const runtime = createExtensionRuntime({
    pi,
    env: process.env,
    initialConfig,
    companionEnv: applyCompanionEnvDefaults(process.env)
  });
  registerDelegationTools(pi, runtime);
  registerLifecycleHooks(pi, runtime);
  registerOfflineCommands(pi, runtime);
}
