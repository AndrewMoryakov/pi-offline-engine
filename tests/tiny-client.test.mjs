import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  callTinyImplementer,
  looksLikeStructuredOutputUnsupported,
  TinyModelOutputError
} from "../src/tiny-client.mjs";

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
