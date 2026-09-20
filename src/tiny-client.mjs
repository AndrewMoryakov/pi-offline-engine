const DEFAULT_TIMEOUT_MS = 120_000;

export async function callTinyImplementer({ endpoint, model, spec, context = {}, repairPacket = null, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!endpoint) throw new Error("tiny endpoint is required");
  if (!model) throw new Error("tiny model is required");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("tiny implementer timeout")), timeoutMs);
  const abort = () => controller.abort(signal?.reason ?? new Error("aborted"));
  signal?.addEventListener("abort", abort, { once: true });

  const startedAt = Date.now();
  try {
    const response = await fetch(new URL("/v1/chat/completions", ensureTrailingSlash(endpoint)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You are a bounded implementation backend.",
              "Do not redesign the task, expand scope, or invent requirements.",
              "Return JSON only.",
              "Allowed statuses: candidate, insufficient_spec, cannot_safely_implement.",
              "Allowed change operations in v1:",
              "- replace_text: {path, operation:'replace_text', expected, content}; expected must be exact existing text and occur once.",
              "- create_file: {path, operation:'create_file', content}; only when the spec explicitly allows new files.",
              "For candidate, return {status:'candidate', changes:[...]}.",
              "If the specification or supplied context is insufficient, return insufficient_spec instead of guessing.",
              "Never name a path outside scope.allowed_files."
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({ implementation_spec: spec, context, repair_packet: repairPacket })
          }
        ]
      })
    });

    const raw = await response.text();
    if (!response.ok) throw new Error(`tiny endpoint HTTP ${response.status}: ${raw.slice(0, 500)}`);
    const envelope = JSON.parse(raw);
    const text = envelope?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("tiny endpoint returned no assistant content");

    return {
      candidate: parseJsonObject(text),
      usage: normalizeUsage(envelope.usage),
      latencyMs: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function parseJsonObject(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("tiny model did not return a JSON object");
  return JSON.parse(trimmed.slice(first, last + 1));
}

function normalizeUsage(usage = {}) {
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    totalTokens: usage.total_tokens ?? null
  };
}

function ensureTrailingSlash(endpoint) {
  return endpoint.endsWith("/") ? endpoint : endpoint + "/";
}
