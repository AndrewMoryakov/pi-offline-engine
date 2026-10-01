import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  CANDIDATE_JSON_SCHEMA,
  callTinyImplementer,
  looksLikeStructuredOutputUnsupported,
  normalizeCandidate,
  TinyModelOutputError
} from "../src/tiny-client.mjs";
import { validateCandidate } from "../src/implementation-spec.mjs";

// The rules OpenAI Structured Outputs applies to `strict: true` schemas that
// this schema could break: every object closes additionalProperties and lists
// every property as required, and no length/count keywords are used.
function strictSchemaViolations(schema, at = "$") {
  const violations = [];
  for (const keyword of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (keyword in schema) violations.push(`${at}: unsupported ${keyword}`);
  }
  const types = [].concat(schema.type ?? []);
  if (types.includes("object")) {
    if (schema.additionalProperties !== false) violations.push(`${at}: additionalProperties must be false`);
    const keys = Object.keys(schema.properties ?? {}).sort();
    const required = [...(schema.required ?? [])].sort();
    if (JSON.stringify(keys) !== JSON.stringify(required)) violations.push(`${at}: required must list ${keys.join(",")}`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      violations.push(...strictSchemaViolations(child, `${at}.${key}`));
    }
  }
  if (schema.items) violations.push(...strictSchemaViolations(schema.items, `${at}[]`));
  return violations;
}

test("candidate schema satisfies strict structured-output rules", () => {
  assert.deepEqual(strictSchemaViolations(CANDIDATE_JSON_SCHEMA), []);
});

test("the strictness check itself rejects the pre-strict schema shape", () => {
  const loose = {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: { status: { type: "string" }, reason: { type: "string", minLength: 1 } }
  };
  assert.equal(strictSchemaViolations(loose).length, 2);
});

test("nulls required by the strict schema are dropped before validation", () => {
  const spec = { scope: { allowed_files: ["src/New.cs"], allow_new_files: true } };
  const candidate = normalizeCandidate({
    status: "candidate",
    reason: null,
    changes: [{ path: "src/New.cs", operation: "create_file", expected: null, content: "class New {}" }]
  });
  assert.deepEqual(candidate, {
    status: "candidate",
    changes: [{ path: "src/New.cs", operation: "create_file", content: "class New {}" }]
  });
  assert.deepEqual(validateCandidate(candidate, spec), { ok: true, errors: [] });

  assert.deepEqual(
    normalizeCandidate({ status: "insufficient_spec", reason: "need the class body", changes: null }),
    { status: "insufficient_spec", reason: "need the class body" }
  );
});

test("falls back when an OpenAI-style strict validator rejects the schema", () => {
  const raw = JSON.stringify({
    error: {
      message: "Invalid schema for response_format 'bounded_implementation_candidate': In context=(), 'required' is required to be supplied and to be an array including every key in properties. Missing 'reason'.",
      type: "invalid_request_error",
      param: "response_format"
    }
  });
  assert.equal(looksLikeStructuredOutputUnsupported(raw), true);
});

test("detects structured-output rejection across backend phrasings", () => {
  const rejections = [
    JSON.stringify({ error: { message: 'response_format type must be one of "text" or "json_object"' } }),
    JSON.stringify({ error: "unsupported response_format json_schema" }),
    JSON.stringify({ error: { message: "unrecognized field response_format" } }),
    JSON.stringify({ error: { message: "json_schema is not supported by this model" } })
  ];

  for (const raw of rejections) {
    assert.equal(looksLikeStructuredOutputUnsupported(raw), true, raw);
  }

  const unrelated = [
    JSON.stringify({ error: { message: "model not found" } }),
    JSON.stringify({ error: { message: "temperature must be one of the supported values" } })
  ];

  for (const raw of unrelated) {
    assert.equal(looksLikeStructuredOutputUnsupported(raw), false, raw);
  }
});

test("detects llama.cpp-family schema-to-grammar conversion failures", () => {
  // llama-server wraps every json_schema_to_grammar error as
  // `"json_schema": JSON schema conversion failed:\n<reason>` and answers 500.
  // The inner reasons (verbatim from common/json-schema-to-grammar.cpp) mostly
  // carry no generic rejection keyword, so the wrapper itself is the signal.
  const reasons = [
    "Unbalanced parentheses",
    "Pattern must start with '^' and end with '$'",
    "Rule foo not known",
    "At least one of min_value or max_value must be set",
    "Error resolving ref #/$defs/a: a not in {}"
  ];

  for (const reason of reasons) {
    const raw = JSON.stringify({
      error: { code: 500, message: `"json_schema": JSON schema conversion failed:\n${reason}` }
    });
    assert.equal(looksLikeStructuredOutputUnsupported(raw), true, reason);
  }
});

const spec = {
  version: 1,
  spec_id: "tiny-client-test",
  operation: "modify_symbol",
  goal: { summary: "Change bounded code." },
  target: { file: "src/A.cs", symbol: "A.Run" },
  requirements: ["Change return value."],
  scope: {
    allowed_files: ["src/A.cs"],
    allow_new_files: false,
    allow_dependencies: false,
    allow_public_api_change: false
  },
  verification: { build: { project: "src/App.csproj" } }
};

test("uses json_schema structured output when supported", async () => {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        status: "candidate",
        changes: [{ path: "src/A.cs", operation: "replace_text", expected: "1", content: "2" }]
      }) } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 3 }
      }
    }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const result = await callTinyImplementer({
      endpoint: `http://127.0.0.1:${port}`,
      model: "tiny",
      spec,
      timeoutMs: 5000
    });
    assert.equal(result.structuredOutputMode, "json_schema");
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].response_format.type, "json_schema");
    assert.equal(bodies[0].response_format.json_schema.strict, true);
    assert.equal(result.usage.inputTokens, 7);
    assert.equal(result.usage.cacheReadTokens, 3);
    assert.equal(result.usage.outputTokens, 4);
    assert.equal(result.usage.totalTokens, 14);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("falls back to json_object when llama.cpp rejects json_schema with HTTP 500", async () => {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));

    res.setHeader("content-type", "application/json");
    if (bodies.length === 1) {
      res.statusCode = 500;
      res.end(JSON.stringify({
        error: { message: 'response_format type must be one of "text" or "json_object"' }
      }));
      return;
    }

    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        status: "candidate",
        changes: [{ path: "src/A.cs", operation: "replace_text", expected: "1", content: "2" }]
      }) } }]
    }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const result = await callTinyImplementer({
      endpoint: `http://127.0.0.1:${port}`,
      model: "tiny",
      spec,
      timeoutMs: 5000
    });
    assert.equal(result.structuredOutputMode, "json_object_fallback");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].response_format.type, "json_object");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("falls back once to json_object when backend rejects json_schema", async () => {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    bodies.push(body);

    res.setHeader("content-type", "application/json");
    if (bodies.length === 1) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "unsupported response_format json_schema" }));
      return;
    }

    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        status: "candidate",
        changes: [{ path: "src/A.cs", operation: "replace_text", expected: "1", content: "2" }]
      }) } }]
    }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const result = await callTinyImplementer({
      endpoint: `http://127.0.0.1:${port}`,
      model: "tiny",
      spec,
      timeoutMs: 5000
    });
    assert.equal(result.structuredOutputMode, "json_object_fallback");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].response_format.type, "json_schema");
    assert.equal(bodies[1].response_format.type, "json_object");
  } finally {
    server.close();
    await once(server, "close");
  }
});


test("does not downgrade on an unrelated unknown-model error", async () => {
  let requests = 0;
  const server = http.createServer(async (_req, res) => {
    requests += 1;
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "unknown model tiny-missing" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    await assert.rejects(
      () => callTinyImplementer({
        endpoint: `http://127.0.0.1:${port}`,
        model: "tiny-missing",
        spec,
        timeoutMs: 5000
      }),
      /HTTP 400/
    );
    assert.equal(requests, 1);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("preserves endpoint path prefixes for completion requests", async () => {
  let seenPath = null;
  const server = http.createServer(async (req, res) => {
    seenPath = req.url;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        status: "candidate",
        changes: [{ path: "src/A.cs", operation: "replace_text", expected: "1", content: "2" }]
      }) } }]
    }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    await callTinyImplementer({
      endpoint: `http://127.0.0.1:${port}/proxy`,
      model: "tiny",
      spec,
      timeoutMs: 5000
    });
    assert.equal(seenPath, "/proxy/v1/chat/completions");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("honors a caller signal that is already aborted", async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const controller = new AbortController();
    controller.abort(new Error("cancelled before call"));
    await assert.rejects(
      () => callTinyImplementer({
        endpoint: `http://127.0.0.1:${port}`,
        model: "tiny",
        spec,
        signal: controller.signal,
        timeoutMs: 5000
      })
    );
    assert.equal(requests, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});


test("classifies malformed assistant JSON as a model-output error", async () => {
  const server = http.createServer(async (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { content: "not json at all" } }]
    }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    await assert.rejects(
      () => callTinyImplementer({
        endpoint: `http://127.0.0.1:${port}`,
        model: "tiny",
        spec,
        timeoutMs: 5000
      }),
      (error) => error instanceof TinyModelOutputError
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("sends a bearer header only when an api key is configured", async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    seen.push(req.headers.authorization ?? null);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        status: "candidate",
        changes: [{ path: "src/A.cs", operation: "replace_text", expected: "return 1;", content: "return 2;" }]
      }) } }]
    }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    await callTinyImplementer({ endpoint, model: "m", spec, timeoutMs: 5000 });
    await callTinyImplementer({ endpoint, model: "m", spec, apiKey: "sk-or-v1-testkey", timeoutMs: 5000 });
    await callTinyImplementer({ endpoint, model: "m", spec, apiKey: "   ", timeoutMs: 5000 });

    assert.deepEqual(seen, [undefined ?? null, "Bearer sk-or-v1-testkey", null]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("redacts credentials echoed by a rejecting router", async () => {
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "bad key: Bearer sk-or-v1-0123456789abcdef0123456789abcdef" } }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(
      () => callTinyImplementer({ endpoint, model: "m", spec, apiKey: "sk-or-v1-0123456789abcdef0123456789abcdef", timeoutMs: 5000 }),
      (error) => {
        assert.match(error.message, /tiny endpoint HTTP 401/);
        assert.doesNotMatch(error.message, /sk-or-v1-0123/);
        return true;
      }
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("never surfaces the api key when a router rejects and echoes the credential", async () => {
  const key = "sk-or-v1-leakcanary0123456789abcdef0123456789abcdef";
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    // A hosted router commonly quotes back the credential it refused.
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: `No auth credentials found for ${key}`, code: 401 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  try {
    let thrown = null;
    await assert.rejects(
      callTinyImplementer({
        endpoint,
        model: "m",
        spec: { version: 1, spec_id: "s", operation: "modify_symbol" },
        apiKey: key,
        timeoutMs: 5000
      }),
      (error) => { thrown = error; return true; }
    );

    // The body reaches events.jsonl verbatim, so the raw key must not be in it.
    const serialized = `${thrown.message}\n${thrown.stack}\n${JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))}`;
    assert.equal(serialized.includes(key), false, "raw api key leaked into the error");
    assert.equal(serialized.includes("leakcanary"), false);
    assert.match(thrown.message, /REDACTED/);
    assert.match(thrown.message, /HTTP 401/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("current files reach the model only when the engine attaches them", async () => {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: "insufficient_spec", reason: "x" }) } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const currentFiles = { "src/A.cs": { exists: true, content: "class A {}\n" } };
    await callTinyImplementer({ endpoint, model: "tiny", spec, currentFiles, timeoutMs: 5000 });
    await callTinyImplementer({ endpoint, model: "tiny", spec, timeoutMs: 5000 });

    const [withFiles, without] = bodies;
    assert.deepEqual(JSON.parse(withFiles.messages[1].content).current_files, currentFiles);
    assert.match(withFiles.messages[0].content, /current_files holds the exact current text/);
    assert.equal("current_files" in JSON.parse(without.messages[1].content), false);
    assert.doesNotMatch(without.messages[0].content, /current_files/);
  } finally {
    server.close();
    await once(server, "close");
  }
});
