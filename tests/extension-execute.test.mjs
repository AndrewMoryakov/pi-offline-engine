// Behavioral test of the execute tool as registered by extensions/index.ts,
// loaded through Node's type stripping with a fake Pi API and a fake
// TinyCoder endpoint. Covers the orchestration in the extension itself, which
// the pure-module tests cannot reach.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-offline-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_OFFLINE_TINY_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.PI_OFFLINE_TRAINING_CAPTURE;

const { default: offlineEngine } = await import("../extensions/index.ts");

function loadTools() {
  const tools = {};
  offlineEngine({
    registerTool: (tool) => { tools[tool.name] = tool; },
    registerCommand() {},
    on() {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools() {}
  });
  return tools;
}

async function fakeTinyCoder(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const content = replies[Math.min(requests.length, replies.length) - 1];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

async function workspace() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-offline-ws-"));
  await fs.mkdir(path.join(cwd, "src"));
  await fs.writeFile(path.join(cwd, "src", "A.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>\n");
  await fs.writeFile(path.join(cwd, "src", "A.cs"), "class A {}\n");
  return cwd;
}

const spec = {
  version: 1,
  spec_id: "retry-scope",
  operation: "modify_symbol",
  goal: { summary: "Exercise the model-output retry path." },
  target: { file: "src/A.cs", symbol: "A" },
  requirements: ["Change nothing observable."],
  scope: { allowed_files: ["src/A.cs"], allow_new_files: false, allow_dependencies: false, allow_public_api_change: false },
  verification: { build: { project: "src/A.csproj" } }
};

async function execute(endpoint, cwd) {
  process.env.PI_OFFLINE_TINY_ENDPOINT = endpoint;
  process.env.PI_OFFLINE_TINY_MODEL = "fake-tiny";
  const tools = loadTools();
  const ctx = { cwd, hasUI: true, ui: { confirm: async () => true, notify() {} } };
  const result = await tools.execute_delegated_implementation.execute("call-1", { spec }, undefined, () => {}, ctx);
  return JSON.parse(result.content[0].text);
}

test("malformed TinyCoder output is retried with the error in the next repair packet", async () => {
  const tiny = await fakeTinyCoder([
    "no json here",
    JSON.stringify({ status: "insufficient_spec", reason: "needs the class body" })
  ]);
  try {
    const outcome = await execute(tiny.endpoint, await workspace());
    assert.equal(tiny.requests.length, 2);
    assert.equal(outcome.terminal_status ?? outcome.status, "insufficient_spec");

    const second = JSON.parse(tiny.requests[1].messages[1].content);
    assert.equal(second.repair_packet.kind, "model_output_failure");
    assert.match(second.repair_packet.error, /did not return a JSON object/);
  } finally {
    tiny.close();
  }
});

test("malformed output on every attempt escalates instead of throwing", async () => {
  const tiny = await fakeTinyCoder(["no json here"]);
  try {
    const outcome = await execute(tiny.endpoint, await workspace());
    assert.equal(tiny.requests.length, 3);
    assert.equal(outcome.status, "needs_main_model");
    assert.equal(outcome.reason, "tiny_invalid_output");
    assert.equal(outcome.workspace_modified, false);

    const third = JSON.parse(tiny.requests[2].messages[1].content);
    assert.equal(third.repair_packet.prior_repair_packet.kind, "model_output_failure");
  } finally {
    tiny.close();
  }
});
