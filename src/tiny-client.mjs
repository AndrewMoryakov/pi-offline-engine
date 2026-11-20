import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

// Strict structured-output validators (OpenAI, and routers that forward to
// it) reject a strict schema unless every property is listed in `required`
// and they support only a subset of keywords. Optional fields are therefore
// required-but-nullable here, and length/count limits are left to
// validateCandidate. normalizeCandidate drops the nulls again, so the rest
// of the engine sees the same shapes as before.
export const CANDIDATE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reason", "changes"],
  properties: {
    status: {
      type: "string",
      enum: ["candidate", "insufficient_spec", "cannot_safely_implement"]
    },
    reason: { type: ["string", "null"] },
    changes: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "operation", "expected", "content"],
        properties: {
          path: { type: "string" },
          operation: { type: "string", enum: ["replace_text", "create_file"] },
          expected: { type: ["string", "null"] },
          content: { type: "string" }
        }
      }
    }
  }
};

export async function callTinyImplementer({ provider = "openai-compatible", claudeBin = "claude", endpoint, model, spec, context = {}, repairPacket = null, currentFiles = null, apiKey = null, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (provider === "claude-code") {
    return callClaudeCodeImplementer({ claudeBin, model, spec, context, repairPacket, currentFiles, signal, timeoutMs });
  }
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
      messages: buildMessages(spec, context, repairPacket, currentFiles)
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
      throw new Error(`tiny endpoint HTTP ${response.status}: ${redactBody(response.raw, apiKey).slice(0, 500)}`);
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
      candidate: normalizeCandidate(parseJsonObject(text)),
      usage: normalizeUsage(envelope.usage),
      latencyMs: Date.now() - startedAt,
      structuredOutputMode
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function buildMessages(spec, context, repairPacket, currentFiles = null) {
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
        "Never name a path outside scope.allowed_files.",
        ...(currentFiles ? [
          "current_files holds the exact current text of each allowed file, read just before this request; copy replace_text expected from it rather than from context."
        ] : [])
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        implementation_spec: spec,
        context,
        repair_packet: repairPacket,
        ...(currentFiles ? { current_files: currentFiles } : {})
      })
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
// The body reaches events.jsonl, and a router that rejects a credential often
// quotes it back. Pattern redaction only knows well-known key shapes, so remove
// the configured key by value first: a gateway token of any shape is still ours.
export function redactBody(raw, apiKey) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  const text = key.length >= 8 ? String(raw).replaceAll(key, "[REDACTED_API_KEY]") : String(raw);
  return redactString(text);
}

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
  // `invalid schema` covers OpenAI-style strict validators (`Invalid schema
  // for response_format '...': ...`); json_object has no schema to reject.
  const reason = String.raw`(?:invalid schema|unsupported|not supported|unrecognized|unknown (?:field|parameter)|invalid (?:field|parameter|type)|must be one of|only supports?|conversion failed)`;
  return new RegExp(feature + String.raw`[\s\S]{0,96}` + reason, "i").test(text) ||
    new RegExp(reason + String.raw`[\s\S]{0,96}` + feature, "i").test(text);
}

// Null stands for "absent" in the strict schema; remove it so validation,
// candidate records and training data keep their pre-strict shapes.
export function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
  const out = dropNulls(candidate, ["reason", "changes"]);
  if (Array.isArray(out.changes)) {
    out.changes = out.changes.map((change) =>
      change && typeof change === "object" && !Array.isArray(change) ? dropNulls(change, ["expected"]) : change
    );
  }
  return out;
}

function dropNulls(object, keys) {
  const out = { ...object };
  for (const key of keys) if (out[key] === null) delete out[key];
  return out;
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

// --- provider "claude-code" ------------------------------------------------
//
// One Claude Code CLI run per request: `claude -p` with the same system prompt
// and user message as the HTTP transport, the candidate schema passed as
// --json-schema, and everything else switched off. --tools "" leaves the model
// no tools, --strict-mcp-config with no --mcp-config starts no MCP servers,
// --setting-sources "" loads no user, project or local settings (and so none of
// the plugins they enable), and --no-session-persistence writes no session to
// disk. The run happens in an empty temporary directory, so no CLAUDE.md or
// project memory is found, and without CLAUDE_CODE_PLUGIN_DIRS, so plugins the
// parent session loads from that variable are not loaded either. --bare would
// be stricter but reads only ANTHROPIC_API_KEY, not a Claude subscription.
// Plugins synced to the account itself are still loaded by the CLI.
//
// The prompt goes on stdin: two 16 KB files do not fit a Windows command line.
// The process is spawned without a shell. temperature cannot be set here.
export const CLAUDE_CODE_STRUCTURED_OUTPUT_MODE = "claude_code_json_schema";
const CLAUDE_KILL_GRACE_MS = 5_000;

export function buildClaudeCodeArgs(model, systemPrompt) {
  return [
    "-p",
    "--model", model,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
    "--output-format", "json",
    "--system-prompt", systemPrompt,
    "--json-schema", JSON.stringify(CANDIDATE_JSON_SCHEMA)
  ];
}

export function claudeCodeChildEnv(env = process.env) {
  const out = { ...env };
  delete out.CLAUDE_CODE_PLUGIN_DIRS;
  return out;
}

async function callClaudeCodeImplementer({ claudeBin, model, spec, context, repairPacket, currentFiles, signal, timeoutMs, spawnFn = spawn, env = process.env, tmpRoot = os.tmpdir() }) {
  if (!model) throw new Error("tiny model is required");
  const [system, user] = buildMessages(spec, context ?? {}, repairPacket, currentFiles);
  const cwd = await fs.mkdtemp(path.join(tmpRoot, "pi-offline-claude-"));
  const startedAt = Date.now();
  try {
    const run = await runWithStdin(claudeBin, buildClaudeCodeArgs(model, system.content), {
      cwd, env: claudeCodeChildEnv(env), input: user.content, timeoutMs, signal, spawnFn
    });
    if (run.spawnError) throw new Error(`claude CLI could not start (${claudeBin}): ${run.spawnError}`);
    if (run.timedOut) throw new Error(`tiny implementer timeout: claude CLI did not finish in ${Math.round(timeoutMs / 1000)} s`);
    if (run.aborted) throw new Error("tiny implementer aborted");

    let envelope;
    try {
      envelope = JSON.parse(run.stdout);
    } catch {
      throw new Error(`claude CLI exit ${String(run.code)}: ${redactString((run.stderr || run.stdout).trim()).slice(0, 300)}`);
    }
    if (envelope?.is_error === true || run.code !== 0) {
      const kind = envelope?.api_error_type ? ` ${envelope.api_error_type}` : "";
      const detail = String(envelope?.result ?? run.stderr ?? "").trim();
      throw new Error(`claude CLI exit ${String(run.code)}${kind}: ${redactString(detail).slice(0, 300)}`);
    }

    const structured = envelope.structured_output;
    const candidate = structured && typeof structured === "object" && !Array.isArray(structured)
      ? structured
      : parseJsonObject(String(envelope.result ?? ""));
    return {
      candidate: normalizeCandidate(candidate),
      usage: claudeCodeUsage(envelope.usage),
      latencyMs: Date.now() - startedAt,
      structuredOutputMode: CLAUDE_CODE_STRUCTURED_OUTPUT_MODE
    };
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

export { callClaudeCodeImplementer as _callClaudeCodeImplementerForTests };

function runWithStdin(command, args, { cwd, env, input, timeoutMs, signal, spawnFn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, CLAUDE_KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => { aborted = true; stop(); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => finish({ spawnError: error?.message ?? String(error) }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut, aborted }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// Anthropic usage: input_tokens excludes cache reads and cache writes.
function claudeCodeUsage(usage = {}) {
  const input = finiteOrNull(usage?.input_tokens) ?? 0;
  const cacheRead = finiteOrNull(usage?.cache_read_input_tokens) ?? 0;
  const cacheWrite = finiteOrNull(usage?.cache_creation_input_tokens) ?? 0;
  const output = finiteOrNull(usage?.output_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: input + cacheRead + cacheWrite + (output ?? 0)
  };
}

// For /offline-doctor: is the CLI there, and which version.
export async function checkClaudeCli({ claudeBin = "claude", exec, cwd, timeoutMs }) {
  try {
    const result = await exec(claudeBin, ["--version"], { cwd, timeout: timeoutMs });
    const line = String(result.stdout ?? "").trim().split("\n")[0];
    if (result.code === 0 && result.killed !== true && line) return { ok: true, version: line };
    if (result.killed === true) return { ok: false, error: `timed out after ${formatTimeLimit(timeoutMs)}` };
    return { ok: false, error: `exit ${String(result.code)}${result.stderr ? `: ${String(result.stderr).trim().slice(0, 200)}` : ""}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// "20 s" for the usual limits, "250 ms" below a second rather than "0 s".
export function formatTimeLimit(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${Math.max(0, Math.round(ms))} ms`;
}
