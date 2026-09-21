import { resolveEndpointUrl } from "./endpoint-url.mjs";\n\nconst DEFAULT_TIMEOUT_MS = 120_000;

const CANDIDATE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: ["candidate", "insufficient_spec", "cannot_safely_implement"]
    },
    reason: { type: "string" },
    changes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "operation", "content"],
        properties: {
          path: { type: "string", minLength: 1 },
          operation: { type: "string", enum: ["replace_text", "create_file"] },
          expected: { type: "string" },
          content: { type: "string" }
        }
      }
    }
  }
};

export async function callTinyImplementer({ endpoint, model, spec, context = {}, repairPacket = null, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!endpoint) throw new Error("tiny endpoint is required");
  if (!model) throw new Error("tiny model is required");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("tiny implementer timeout")), timeoutMs);
  const abort = () => controller.abort(signal?.reason ?? new Error("aborted"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  const startedAt = Date.now();
  try {
    const base = {
      model,
      temperature: 0,
      messages: buildMessages(spec, context, repairPacket)
    };

    let response = await postCompletion(endpoint, {
      ...base,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "bounded_implementation_candidate",
          strict: true,
          schema: CANDIDATE_JSON_SCHEMA
        }
      }
    }, controller.signal);

    let structuredOutputMode = "json_schema";

    // Keep compatibility with OpenAI-compatible local servers that implement
    // json_object but not the newer json_schema response format.
    if ((response.status === 400 || response.status === 422) && looksLikeStructuredOutputUnsupported(response.raw)) {
      response = await postCompletion(endpoint, {
        ...base,
        response_format: { type: "json_object" }
      }, controller.signal);
      structuredOutputMode = "json_object_fallback";
    }

    if (!response.ok) {
      throw new Error(`tiny endpoint HTTP ${response.status}: ${response.raw.slice(0, 500)}`);
    }

    const envelope = JSON.parse(response.raw);
    const text = envelope?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("tiny endpoint returned no assistant content");

    return {
      candidate: parseJsonObject(text),
      usage: normalizeUsage(envelope.usage),
      latencyMs: Date.now() - startedAt,
      structuredOutputMode
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function buildMessages(spec, context, repairPacket) {
  return [
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
  ];
}

async function postCompletion(endpoint, body, signal) {
  const response = await fetch(resolveEndpointUrl(endpoint, "v1/chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify(body)
  });
  return { ok: response.ok, status: response.status, raw: await response.text() };
}

export function looksLikeStructuredOutputUnsupported(raw) {
  const text = String(raw);
  const feature = /\b(?:json_schema|response_format)\b/i;
  const unsupported = /\b(?:unsupported|not supported|unrecognized|unknown (?:field|parameter)|invalid (?:field|parameter|type))\b/i;
  return feature.test(text) && unsupported.test(text);
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
  const promptTokens = finiteOrNull(usage.prompt_tokens ?? usage.input_tokens);
  const cacheReadTokens = finiteOrNull(
    usage.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.cached_tokens
  ) ?? 0;
  const outputTokens = finiteOrNull(usage.completion_tokens ?? usage.output_tokens);
  const inputTokens = promptTokens === null ? null : Math.max(0, promptTokens - cacheReadTokens);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    totalTokens: finiteOrNull(usage.total_tokens)
  };
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
\n