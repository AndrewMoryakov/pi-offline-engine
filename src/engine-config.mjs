import fs from "node:fs";
import path from "node:path";

// llama-server (llama.cpp and ik_llama.cpp) listens on 8080 unless told otherwise.
export const DEFAULT_SETTINGS = Object.freeze({
  endpoint: "http://127.0.0.1:8080",
  model: "qwen2.5-coder-3b-instruct",
  maxAttempts: 3
});

const MIN_ATTEMPTS = 1;
const MAX_ATTEMPTS = 3;

// Keys this engine is willing to persist. Credentials are deliberately absent:
// an API key stays in the environment and is never written to disk by us.
const PERSISTED_KEYS = new Set(["endpoint", "model", "maxAttempts", "configuredBy", "configuredAt", "backend", "editProvider", "scriptEditPolicy"]);

// Who supplies Pi's read/edit/write tools. "lean" loads the bundled
// pi-lean-edit; "none" leaves them to another package (pi-utils overrides
// `edit` too, and Pi aborts startup when two extensions register one tool
// name) or to Pi's built-ins. "hybrid" loads pi-lean-edit with its edit
// renamed to `line_edit`, so the other `edit` can stay registered beside it.
// Spec: docs/HYBRID_EDIT_V0.md HE-3 (opt-in, default stays lean), HE-4 (rename).
export const EDIT_PROVIDERS = Object.freeze(["lean", "none", "hybrid"]);
export const DEFAULT_EDIT_PROVIDER = "lean";

// Hybrid only: when the other `edit` is offered to the model. "cloud-only"
// hides it while the session model's baseUrl is local (small local models do
// better with range edits than with writing scripts); "always" never hides
// it; "never" keeps it registered but always hidden.
// Spec: docs/HYBRID_EDIT_V0.md HE-5, HE-6.
export const SCRIPT_EDIT_POLICIES = Object.freeze(["cloud-only", "always", "never"]);
export const DEFAULT_SCRIPT_EDIT_POLICY = "cloud-only";

export function engineConfigPath(agentDir) {
  return path.join(agentDir, "pi-offline-engine", "config.json");
}

export function readEngineConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { config: {}, error: null };
    return { config: {}, error: `cannot read ${file}: ${error.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { config: {}, error: `invalid JSON in ${file}: ${error.message}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { config: {}, error: `${file} must contain a JSON object` };
  }
  return { config: parsed, error: null };
}

// Merges `patch` into the stored config. A `null` value removes the key, so the
// next precedence layer (the built-in default) shows through again.
export function writeEngineConfig(file, patch) {
  const { config } = readEngineConfig(file);
  const next = { ...config };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!PERSISTED_KEYS.has(key)) continue;
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  for (const key of Object.keys(next)) {
    if (!PERSISTED_KEYS.has(key)) delete next[key];
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
  return next;
}

// Precedence: environment > config file > built-in default. The environment
// must stay on top: scripts, the acceptance harness and the documented
// `export PI_OFFLINE_TINY_*` workflow all rely on overriding persisted state.
export function resolveEngineSettings({ env = {}, config = {} } = {}) {
  const endpoint = pick(env.PI_OFFLINE_TINY_ENDPOINT, config.endpoint, DEFAULT_SETTINGS.endpoint);
  const model = pick(env.PI_OFFLINE_TINY_MODEL, config.model, DEFAULT_SETTINGS.model);
  const maxAttempts = pickAttempts(env.PI_OFFLINE_TINY_MAX_ATTEMPTS, config.maxAttempts);

  const apiKeyValue = firstNonBlank(env.PI_OFFLINE_TINY_API_KEY, env.OPENROUTER_API_KEY);

  return {
    endpoint: endpoint.value,
    model: model.value,
    maxAttempts: maxAttempts.value,
    apiKey: apiKeyValue,
    sources: {
      endpoint: endpoint.source,
      model: model.source,
      maxAttempts: maxAttempts.source,
      apiKey: apiKeyValue ? "env" : "none"
    }
  };
}

// Same precedence as the settings above. An unrecognised value is skipped
// rather than guessed at, so the next layer decides.
export function resolveEditProvider({ env = {}, config = {} } = {}) {
  return pickChoice(env.PI_OFFLINE_EDIT_PROVIDER, config.editProvider, EDIT_PROVIDERS, DEFAULT_EDIT_PROVIDER);
}

export function resolveScriptEditPolicy({ env = {}, config = {} } = {}) {
  return pickChoice(env.PI_OFFLINE_SCRIPT_EDIT_POLICY, config.scriptEditPolicy, SCRIPT_EDIT_POLICIES, DEFAULT_SCRIPT_EDIT_POLICY);
}

function pickChoice(envValue, configValue, allowed, fallback) {
  const fromEnv = parseChoice(envValue, allowed);
  if (fromEnv !== null) return { value: fromEnv, source: "env" };
  const fromConfig = parseChoice(configValue, allowed);
  if (fromConfig !== null) return { value: fromConfig, source: "config" };
  return { value: fallback, source: "default" };
}

function parseChoice(value, allowed) {
  const cleaned = blankToNull(value);
  if (cleaned === null) return null;
  const lowered = cleaned.toLowerCase();
  return allowed.includes(lowered) ? lowered : null;
}

function pick(envValue, configValue, fallback) {
  const fromEnv = blankToNull(envValue);
  if (fromEnv !== null) return { value: fromEnv, source: "env" };
  const fromConfig = blankToNull(configValue);
  if (fromConfig !== null) return { value: fromConfig, source: "config" };
  return { value: fallback, source: "default" };
}

function pickAttempts(envValue, configValue) {
  const fromEnv = parseAttempts(envValue);
  if (fromEnv !== null) return { value: fromEnv, source: "env" };
  const fromConfig = parseAttempts(configValue);
  if (fromConfig !== null) return { value: fromConfig, source: "config" };
  return { value: DEFAULT_SETTINGS.maxAttempts, source: "default" };
}

function parseAttempts(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(MAX_ATTEMPTS, Math.max(MIN_ATTEMPTS, parsed));
}

function firstNonBlank(...values) {
  for (const value of values) {
    const cleaned = blankToNull(value);
    if (cleaned !== null) return cleaned;
  }
  return null;
}

function blankToNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
