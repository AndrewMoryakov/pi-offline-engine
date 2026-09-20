import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { callTinyImplementer } from "../src/tiny-client.mjs";

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
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
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
