import { resolveEndpointUrl } from "./endpoint-url.mjs";

// Loopback only: auto-configuration must never pick a destination that sends
// source code off this machine. Hosted routers are configured explicitly.
export const DEFAULT_CANDIDATES = Object.freeze([
  { endpoint: "http://127.0.0.1:8080", label: "llama-server (llama.cpp / ik_llama.cpp default port)" },
  { endpoint: "http://127.0.0.1:8081", label: "llama-server (alternate port)" },
  { endpoint: "http://127.0.0.1:1234", label: "LM Studio" },
  { endpoint: "http://127.0.0.1:11434", label: "Ollama" }
]);

const DEFAULT_TIMEOUT_MS = 1500;
const NON_CHAT_MODEL = /embed|rerank/i;

export function pickChatModel(ids) {
  const chat = (ids ?? []).filter((id) => typeof id === "string" && id && !NON_CHAT_MODEL.test(id));
  if (chat.length === 0) return null;
  return chat.find((id) => /coder/i.test(id)) ?? chat[0];
}

export async function probeEndpoint({ endpoint, label = "", fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(resolveEndpointUrl(endpoint, "v1/models"), { signal: controller.signal });
    if (!response?.ok) return unreachable(endpoint, label, `HTTP ${response?.status ?? "error"}`);
    const json = await response.json();
    const models = Array.isArray(json?.data)
      ? json.data.map((x) => String(x?.id ?? x?.model ?? "")).filter(Boolean)
      : [];
    const model = pickChatModel(models);
    return {
      endpoint,
      label,
      reachable: true,
      models,
      model,
      note: model ? null : "reachable, but no chat model is loaded"
    };
  } catch (error) {
    return unreachable(endpoint, label, error?.name === "AbortError" ? "timed out" : "not listening");
  } finally {
    clearTimeout(timeout);
  }
}

// Probes every candidate in parallel so refused ports cost nothing and a
// filtered port costs at most one timeout, never the sum of them.
export async function discoverEndpoints({
  candidates = DEFAULT_CANDIDATES,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const found = await Promise.all(
    candidates.map((candidate) => probeEndpoint({ ...candidate, fetchFn, timeoutMs }))
  );
  const usable = found.filter((x) => x.reachable && x.model);
  return { found, usable, selected: usable[0] ?? null };
}

function unreachable(endpoint, label, note) {
  return { endpoint, label, reachable: false, models: [], model: null, note };
}
