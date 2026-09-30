// Owner of the extension-lifetime state: one runtime per extension factory
// invocation. Holds the mutable session toggles, the engine-config facade and
// the two Pi capabilities the delegation workflows need (exec and file
// mutation queues). Deliberately not a service locator.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  readEngineConfig,
  resolveEditProvider,
  resolveEngineSettings,
  resolveScriptEditPolicy,
  writeEngineConfig
} from "../src/engine-config.mjs";

type Env = Record<string, string | undefined>;
type ConfigState = { config: Record<string, unknown>; error: string | null };
type Choice = { value: string; source: string };

export interface InitialEngineConfig {
  file: string;
  state: ConfigState;
  editProviderAtLoad: Choice;
  scriptEditPolicyAtLoad: Choice;
}

export interface ExtensionRuntimeState {
  savedActiveTools: string[] | null;
  compactToolResults: boolean;
  repoCapsuleEnabled: boolean;
  lastRepoCapsuleFingerprint: string | null;
  trainingCaptureEnabled: boolean;
  autoSetupAttempted: boolean;
}

export interface CompanionEnvEntry {
  name: string;
  value: string | undefined;
  source: string;
}

// Read once while index.ts is evaluated. extensions/pi-lean-edit.ts decides
// its edit provider once, at load; the doctor must report that decision, not
// a config edited since (it takes effect on the next start). Spec:
// docs/HYBRID_EDIT_V0.md HE-8: the doctor reports the policy read at load.
export function readInitialEngineConfig(file: string, env: Env): InitialEngineConfig {
  const state = readEngineConfig(file);
  return {
    file,
    state,
    editProviderAtLoad: resolveEditProvider({ env, config: state.config }),
    scriptEditPolicyAtLoad: resolveScriptEditPolicy({ env, config: state.config })
  };
}

// The bundled pi-knowledge reads its settings lazily from the environment.
// Apply the profile's slow-local-model search default unless the user chose
// one. PI_KNOWLEDGE_OFFLINE is deliberately not forced: it would block the
// first download of the local embedding model. /offline-status reports this,
// so the write into another package's environment is never silent.
export function applyCompanionEnvDefaults(env: Env): CompanionEnvEntry[] {
  const knowledgeProfileSource = env.PI_KNOWLEDGE_SEARCH_PROFILE === undefined ? "default" : "env";
  env.PI_KNOWLEDGE_SEARCH_PROFILE ??= "low_token";
  return [{
    name: "PI_KNOWLEDGE_SEARCH_PROFILE",
    value: env.PI_KNOWLEDGE_SEARCH_PROFILE,
    source: knowledgeProfileSource
  }];
}

export function createExtensionRuntime({ pi, env, initialConfig, companionEnv }: {
  pi: ExtensionAPI;
  env: Env;
  initialConfig: InitialEngineConfig;
  companionEnv: CompanionEnvEntry[];
}) {
  // User-level engine config (endpoint/model chosen by /offline-setup or by
  // the first-run discovery). Environment variables still override it.
  let configState = initialConfig.state;
  const file = initialConfig.file;
  const reload = () => {
    configState = readEngineConfig(file);
  };
  const config = {
    file,
    error: () => configState.error,
    reload,
    save(patch: Record<string, unknown>) {
      writeEngineConfig(file, patch);
      reload();
    },
    // Precedence for every setting: environment > engine config file >
    // built-in default (see src/engine-config.mjs). The API key is read from
    // the environment only; the config file never stores it.
    settings: () => resolveEngineSettings({ env, config: configState.config })
  };

  const state: ExtensionRuntimeState = {
    savedActiveTools: null,
    compactToolResults: env.PI_OFFLINE_COMPACT_TOOL_RESULTS !== "0",
    repoCapsuleEnabled: env.PI_OFFLINE_REPO_CAPSULE !== "0",
    lastRepoCapsuleFingerprint: null,
    trainingCaptureEnabled: env.PI_OFFLINE_TRAINING_CAPTURE === "1",
    autoSetupAttempted: false
  };

  return {
    env,
    state,
    config,
    companionEnv,
    editProviderAtLoad: initialConfig.editProviderAtLoad,
    scriptEditPolicyAtLoad: initialConfig.scriptEditPolicyAtLoad,
    exec: (command: string, args: string[], options?: any) => pi.exec(command, args, options),
    withMutationQueues
  };
}

export type ExtensionRuntime = ReturnType<typeof createExtensionRuntime>;

// Nests one Pi file mutation queue per target path, outermost first, so every
// candidate target is protected for the duration of `fn`.
async function withMutationQueues<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  let wrapped = fn;
  for (const target of [...paths].reverse()) {
    const next = wrapped;
    wrapped = () => withFileMutationQueue(target, next);
  }
  return wrapped();
}
