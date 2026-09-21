import { DEFAULT_CANDIDATES } from "./endpoint-discovery.mjs";

const SOURCE_LABELS = {
  env: "environment",
  config: "config file",
  default: "built-in default",
  none: "not set"
};

const CANDIDATE_PORTS = DEFAULT_CANDIDATES.map((x) => new URL(x.endpoint).port).join(", ");

// First-run configuration. Runs only while the endpoint is still the built-in
// default: anything the user set (env or an earlier setup) is left alone and
// costs no network probe.
export async function autoConfigureIfNeeded({ settings, discover, save, now = () => new Date().toISOString() }) {
  if (settings.sources.endpoint !== "default") {
    return { action: "skipped", message: null };
  }

  let discovery;
  try {
    discovery = await discover();
  } catch (error) {
    return {
      action: "error",
      message: `pi-offline-engine: automatic setup failed (${error instanceof Error ? error.message : String(error)}). Run /offline-setup to retry.`
    };
  }

  const selected = discovery.selected;
  if (!selected) {
    return { action: "not-found", message: describeDiscoveryFailure(discovery) };
  }

  save(recordFor(selected, { backend: selected.label || "auto", configuredBy: "auto-discovery", now }));
  return {
    action: "configured",
    selected,
    message:
      `pi-offline-engine: TinyCoder configured automatically — ${selected.model} @ ${selected.endpoint}` +
      `${selected.label ? ` (${selected.label})` : ""}. Run /offline-doctor to confirm readiness.`
  };
}

export function describeDiscoveryFailure(discovery) {
  const partial = discovery.found.filter((x) => x.reachable);
  const detail = partial.length > 0
    ? ` Found ${partial.map((x) => `${x.label || x.endpoint} (${x.note})`).join("; ")}.`
    : "";
  return (
    `pi-offline-engine: no local OpenAI-compatible server with a chat model on 127.0.0.1 ports ${CANDIDATE_PORTS}.${detail} ` +
    "Start llama-server (or LM Studio / Ollama with a coder model loaded), then run /offline-setup."
  );
}

export function parseSetupArgs(raw) {
  const parts = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { mode: "auto" };
  if (parts.length === 1 && parts[0].toLowerCase() === "reset") return { mode: "reset" };

  const endpoint = normalizeEndpoint(parts[0]);
  if (!endpoint || parts.length > 2) {
    return { mode: "invalid", message: "Usage: /offline-setup [reset | <endpoint-url> [model]]" };
  }
  return { mode: "manual", endpoint, model: parts[1] ?? null };
}

// Manual setup: the endpoint must answer before it is persisted, so a typo is
// reported now instead of surfacing mid-delegation.
export async function configureFromSetupArgs({ request, probe, save, now = () => new Date().toISOString() }) {
  const result = await probe({ endpoint: request.endpoint, label: "manual" });
  if (!result.reachable) {
    return { ok: false, message: `${request.endpoint} did not answer v1/models (${result.note}). Nothing was saved.` };
  }

  const model = request.model ?? result.model;
  if (!model) {
    return {
      ok: false,
      message: `${request.endpoint} is reachable but lists no chat model; pass one explicitly: /offline-setup ${request.endpoint} <model>`
    };
  }

  save(recordFor({ ...result, model }, { backend: "manual", configuredBy: "offline-setup", now }));
  return { ok: true, message: `Saved TinyCoder ${model} @ ${request.endpoint}.` };
}

export function recordFor(selected, { backend, configuredBy, now }) {
  return {
    endpoint: selected.endpoint,
    model: selected.model,
    backend,
    configuredBy,
    configuredAt: now()
  };
}

export function formatEngineStatus({ settings, configFile, configError, companionEnv = [] }) {
  const lines = [
    `Tiny implementer: ${settings.model} @ ${settings.endpoint}`,
    `  endpoint: ${SOURCE_LABELS[settings.sources.endpoint]}`,
    `  model: ${SOURCE_LABELS[settings.sources.model]}`,
    `  attempts: ${settings.maxAttempts} (${SOURCE_LABELS[settings.sources.maxAttempts]})`,
    `Config file: ${configFile}`
  ];
  if (configError) lines.push(`Config file problem: ${configError}`);
  // The engine sets a few defaults for the bundled companion extensions.
  // Report them: a silent write into another package's environment is the
  // kind of thing that gets rediscovered later as a bug.
  for (const entry of companionEnv) {
    lines.push(`Companion setting: ${entry.name}=${entry.value} (${SOURCE_LABELS[entry.source] ?? entry.source})`);
  }
  return lines.join("\n");
}

function normalizeEndpoint(value) {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return withScheme.replace(/\/+$/, "");
  } catch {
    return null;
  }
}
