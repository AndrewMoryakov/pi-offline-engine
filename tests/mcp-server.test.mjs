import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEngineTools, resolveWorkspace } from "../mcp/server.mjs";
import { DELEGATION_PARAMETERS_JSON_SCHEMA } from "../mcp/delegation-json-schema.mjs";
import { DelegationParametersSchema } from "../extensions/delegation-schema.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP parameter schema matches the Pi TypeBox schema", () => {
  assert.deepEqual(DELEGATION_PARAMETERS_JSON_SCHEMA, JSON.parse(JSON.stringify(DelegationParametersSchema)));
});

async function tempDir(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

test("workspace comes from PI_OFFLINE_WORKSPACE, then CLAUDE_PROJECT_DIR, then MCP roots", async () => {
  const a = await tempDir("pi-ws-a-");
  const b = await tempDir("pi-ws-b-");
  const c = await tempDir("pi-ws-c-");
  const serverRoot = await tempDir("pi-server-");
  const roots = async () => [pathToFileURL(c).href];

  assert.equal(await resolveWorkspace({ env: { PI_OFFLINE_WORKSPACE: a, CLAUDE_PROJECT_DIR: b }, listRoots: roots, serverRoot }), a);
  assert.equal(await resolveWorkspace({ env: { CLAUDE_PROJECT_DIR: b }, listRoots: roots, serverRoot }), b);
  assert.equal(await resolveWorkspace({ env: {}, listRoots: roots, serverRoot }), c);
  await assert.rejects(() => resolveWorkspace({ env: {}, listRoots: async () => null, serverRoot }), /No workspace/);
});

test("the engine's own install directory is refused unless set explicitly", async () => {
  const serverRoot = await tempDir("pi-server-");
  const inside = path.join(serverRoot, "sub");
  await fs.mkdir(inside);
  await assert.rejects(() => resolveWorkspace({ env: { CLAUDE_PROJECT_DIR: inside }, serverRoot }), /install directory/);
  assert.equal(await resolveWorkspace({ env: { PI_OFFLINE_WORKSPACE: inside }, serverRoot }), inside);
});

async function fakeTiny(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

async function workspaceWithClass() {
  const cwd = await tempDir("pi-mcp-ws-");
  await fs.mkdir(path.join(cwd, "src"));
  await fs.writeFile(path.join(cwd, "src", "A.csproj"), "<Project />\n");
  await fs.writeFile(path.join(cwd, "src", "A.cs"), "class A { int X() => 1; }\n");
  return cwd;
}

const spec = {
  version: 1,
  spec_id: "mcp-001",
  operation: "modify_symbol",
  goal: { summary: "Return 2." },
  target: { file: "src/A.cs", symbol: "A.X" },
  requirements: ["X returns 2"],
  scope: { allowed_files: ["src/A.cs"], allow_new_files: false, allow_dependencies: false, allow_public_api_change: false },
  verification: { build: { project: "src/A.csproj" } }
};
const candidate = { status: "candidate", changes: [{ path: "src/A.cs", operation: "replace_text", expected: "=> 1", content: "=> 2" }] };

function executeTool(env) {
  const builds = [];
  const exec = async (command, args) => {
    builds.push([command, ...args].join(" "));
    return { code: 0, killed: false, stdout: "Build succeeded.", stderr: "" };
  };
  const tools = createEngineTools({ env, exec });
  return { tool: tools.find((t) => t.name === "execute_delegated_implementation"), builds };
}

function ctx(confirmAnswer) {
  const progress = [];
  return {
    progress,
    value: { signal: undefined, confirm: async () => confirmAnswer, progress: (m) => progress.push(m), listRoots: async () => null }
  };
}

test("execute refuses without elicitation unless headless apply is allowed", async () => {
  const tiny = await fakeTiny(candidate);
  const cwd = await workspaceWithClass();
  const env = { PI_OFFLINE_WORKSPACE: cwd, PI_OFFLINE_TINY_ENDPOINT: tiny.endpoint, PI_OFFLINE_TINY_MODEL: "tiny", PI_CODING_AGENT_DIR: await tempDir("pi-agent-") };
  try {
    const { tool } = executeTool(env);
    await assert.rejects(() => tool.call({ spec }, ctx(null).value), /cannot show \(no MCP elicitation\)/);
    assert.equal(tiny.requests.length, 0);
    assert.equal(await fs.readFile(path.join(cwd, "src", "A.cs"), "utf8"), "class A { int X() => 1; }\n");

    // With the switch set the server does not ask, even a client that
    // advertises elicitation and would decline (claude -p does).
    const headless = executeTool({ ...env, PI_OFFLINE_ALLOW_HEADLESS_APPLY: "1" });
    const result = await headless.tool.call({ spec }, ctx(false).value);
    assert.match(result.content[0].text, /"status": "verification_passed"/);
  } finally {
    tiny.close();
  }
});

test("execute applies and verifies after an accepted elicitation, and stops on decline", async () => {
  const tiny = await fakeTiny(candidate);
  const cwd = await workspaceWithClass();
  const env = { PI_OFFLINE_WORKSPACE: cwd, PI_OFFLINE_TINY_ENDPOINT: tiny.endpoint, PI_OFFLINE_TINY_MODEL: "tiny", PI_CODING_AGENT_DIR: await tempDir("pi-agent-") };
  try {
    const declined = executeTool(env);
    const cancelled = await declined.tool.call({ spec }, ctx(false).value);
    assert.match(cancelled.content[0].text, /cancelled by user/);
    assert.equal(tiny.requests.length, 0);

    const { tool, builds } = executeTool(env);
    const c = ctx(true);
    const result = await tool.call({ spec }, c.value);
    const outcome = JSON.parse(result.content[0].text);
    assert.equal(outcome.status, "verification_passed");
    assert.deepEqual(outcome.changedFiles, ["src/A.cs"]);
    assert.equal(result.content.at(-1).text, `Workspace: ${cwd}`);
    assert.equal(await fs.readFile(path.join(cwd, "src", "A.cs"), "utf8"), "class A { int X() => 2; }\n");
    assert.ok(builds.some((line) => line.startsWith("dotnet build") && line.includes("--no-restore")));
    assert.deepEqual(c.progress, ["Implementer attempt 1/3"]);
    assert.equal(await fs.readFile(path.join(cwd, ".pi", "offline-engine", ".gitignore"), "utf8"), "*\n");
  } finally {
    tiny.close();
  }
});

test("the server speaks MCP over stdio", async () => {
  const cwd = await tempDir("pi-mcp-stdio-");
  const child = spawn(process.execPath, [path.join(repoRoot, "mcp", "server.mjs")], {
    env: { ...process.env, PI_OFFLINE_WORKSPACE: cwd, PI_CODING_AGENT_DIR: await tempDir("pi-agent-") },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const waitFor = async (id) => {
    for (let i = 0; i < 200; i += 1) {
      const found = lines.find((m) => m.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no response ${id}`);
  };
  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    const init = await waitFor(1);
    assert.equal(init.result.serverInfo.name, "pi-offline-engine");
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    const listed = await waitFor(2);
    assert.deepEqual(listed.result.tools.map((t) => t.name), [
      "delegate_implementation", "execute_delegated_implementation", "offline_doctor", "offline_status", "offline_stats"
    ]);
    send({ id: 3, method: "tools/call", params: { name: "offline_status", arguments: {} } });
    assert.match((await waitFor(3)).result.content[0].text, /Apply approval: asked through elicitation; refused without it/);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.on("exit", resolve));
  }
});
