#!/usr/bin/env node
import http from "node:http";
import assert from "node:assert/strict";
import { once } from "node:events";
import { callTinyImplementer } from "../src/tiny-client.mjs";
import { validateCandidate, validateImplementationSpec } from "../src/implementation-spec.mjs";

const spec = {
  version: 1,
  spec_id: "transport-smoke-001",
  operation: "modify_symbol",
  goal: { summary: "Change the bounded return value." },
  target: { file: "src/A.cs", symbol: "A.Run" },
  requirements: ["Replace return 1 with return 2."],
  scope: {
    allowed_files: ["src/A.cs"],
    allow_new_files: false,
    allow_dependencies: false,
    allow_public_api_change: false
  },
  verification: {
    build: { project: "src/App.csproj" }
  }
};

assert.equal(validateImplementationSpec(spec).ok, true);

let observedBody = null;
const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.statusCode = 404;
    res.end();
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  observedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));

  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          status: "candidate",
          changes: [{
            path: "src/A.cs",
            operation: "replace_text",
            expected: "return 1;",
            content: "return 2;"
          }]
        })
      }
    }],
    usage: {
      prompt_tokens: 321,
      completion_tokens: 41,
      total_tokens: 362
    }
  }));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}`;
  const result = await callTinyImplementer({
    endpoint,
    model: "smoke-tiny",
    spec,
    context: {
      relevant_source: "class A { int Run() { return 1; } }"
    },
    timeoutMs: 5000
  });

  const checked = validateCandidate(result.candidate, spec);
  assert.equal(checked.ok, true);
  assert.equal(result.usage.inputTokens, 321);
  assert.equal(result.usage.outputTokens, 41);
  assert.equal(observedBody.model, "smoke-tiny");
  assert.equal(observedBody.temperature, 0);
  assert.equal(observedBody.response_format.type, "json_object");
  assert.match(observedBody.messages[1].content, /transport-smoke-001/);

  process.stdout.write("TINY TRANSPORT SMOKE: PASS\n");
} finally {
  server.close();
  await once(server, "close");
}
