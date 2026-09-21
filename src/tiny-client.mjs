import { resolveEndpointUrl } from "./endpoint-url.mjs";
import { redactString } from "./training-exporter.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;

export class TinyModelOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = "TinyModelOutputError";
    this.code = "tiny_model_output_invalid";
  }
}

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

export async function callTinyImplementer({ endpoint, model, spec, context = {}, repairPacket = null, apiKey = null, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
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
    }, controller.signal, apiKey);

    let structuredOutputMode = "json_schema";

    // Keep compatibility with OpenAI-compatible local servers that implement
    // json_object but not the newer json_schema response format. The status is
    // not part of the signal: llama.cpp reports this rejection as HTTP 500, so
    // gating on 400/422 made the fallback unreachable for it. Any failed
    // response whose body names the feature and a rejection reason is retried
    // once -- the request already failed, so a second attempt costs nothing.
    if (!response.ok && looksLikeStructuredOutputUnsupported(response.raw)) {
      response = await postCompletion(endpoint, {
        ...base,
        response_format: { type: "json_object" }
      }, controller.signal, apiKey);
      structuredOutputMode = "json_object_fallback";
    }

    if (!response.ok) {
      // The body reaches events.jsonl. A remote router answering 401/403 may
      // echo the credential it rejected, so redact before it is persisted.
      throw new Error(`tiny endpoint HTTP ${response.status}: ${redactString(response.raw).slice(0, 500)}`);
    }

    let envelope;
    try {
      envelope = JSON.parse(response.raw);
    } catch {
      throw new TinyModelOutputError("tiny endpoint returned invalid JSON envelope");
    }
    const text = envelope?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new TinyModelOutputError("tiny endpoint returned no assistant content");

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

async function postCompletion(endpoint, body, signal, apiKey) {
  const response = await fetch(resolveEndpointUrl(endpoint, "v1/chat/completions"), {
    method: "POST",
    headers: buildAuthHeaders(apiKey, { "content-type": "application/json" }),
    signal,
    body: JSON.stringify(body)
  });
  return { ok: response.ok, status: response.status, raw: await response.text() };
}

// Hosted OpenAI-compatible routers (OpenRouter and friends) need a bearer
// token; a local llama.cpp needs none. This is the only transport difference,
// so there is no provider switch anywhere -- an absent key simply means the
// header is not sent.
export function buildAuthHeaders(apiKey, headers = {}) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return { ...headers };
  return { ...headers, authorization: `Bearer ${key}` };
}

export function looksLikeStructuredOutputUnsupported(raw) {
  const text = String(raw);
  const feature = String.raw`(?:json_schema|response_format)`;
  // `must be one of` covers llama.cpp, which rejects json_schema with
  // `response_format type must be one of "text" or "json_object"`. Keep it out
  // of `feature`: the allowed-value list names json_object, and matching on
  // that would fire the fallback in the wrong direction.
  // `conversion failed` covers llama-server's wrapper around every
  // json_schema_to_grammar error (`"json_schema": JSON schema conversion
  // failed:\n...`, HTTP 500); most inner reasons carry no keyword above.
  // "Cannot use both json_schema and grammar" is deliberately absent: a
  // json_object retry keeps the same grammar conflict and cannot succeed.
  const reason = String.raw`(?:unsupported|not supported|unrecognized|unknown (?:field|parameter)|invalid (?:field|parameter|type)|must be one of|only supports?|conversion failed)`;
  return new RegExp(feature + String.raw`[\s\S]{0,96}` + reason, "i").test(text) ||
    new RegExp(reason + String.raw`[\s\S]{0,96}` + feature, "i").test(text);
}

function parseJsonObject(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first < 0 || last <= first) throw new TinyModelOutputError("tiny model did not return a JSON object");
  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch {
    throw new TinyModelOutputError("tiny model returned malformed JSON candidate");
  }
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
