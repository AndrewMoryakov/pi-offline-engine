const DEFAULT_TIMEOUT_MS = 120_000;

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
  signal?.addEventListener("abort", abort, { once: true });

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
  const response = await fetch(new URL("/v1/chat/completions", ensureTrailingSlash(endpoint)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify(body)
  });
  return { ok: response.ok, status: response.status, raw: await response.text() };
}

function looksLikeStructuredOutputUnsupported(raw) {
  return /json_schema|response_format|structured|grammar|unsupported|unknown/i.test(String(raw));
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
