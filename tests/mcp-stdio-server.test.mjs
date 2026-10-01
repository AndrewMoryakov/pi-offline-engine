import test from "node:test";
import assert from "node:assert/strict";
import { createMcpServer } from "../mcp/stdio-server.mjs";

function harness(tools) {
  const out = [];
  let wake = () => {};
  const server = createMcpServer({
    name: "t", version: "1", tools,
    write: (chunk) => { out.push(JSON.parse(chunk)); wake(); }
  });
  const send = (message) => server.receive(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const next = async (predicate) => {
    for (;;) {
      const index = out.findIndex(predicate);
      if (index >= 0) return out.splice(index, 1)[0];
      await new Promise((resolve) => { wake = resolve; });
    }
  };
  return { send, next, out };
}

const echo = {
  name: "echo",
  description: "echo",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  call: async ({ text }) => ({ content: [{ type: "text", text }] })
};

test("initialize negotiates a supported protocol version", async () => {
  const h = harness([echo]);
  h.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  const known = await h.next((m) => m.id === 1);
  assert.equal(known.result.protocolVersion, "2025-06-18");
  assert.deepEqual(known.result.serverInfo, { name: "t", version: "1" });

  h.send({ id: 2, method: "initialize", params: { protocolVersion: "1999-01-01", capabilities: {} } });
  assert.equal((await h.next((m) => m.id === 2)).result.protocolVersion, "2025-11-25");
});

test("lists and calls tools; tool errors become isError results", async () => {
  const boom = { ...echo, name: "boom", call: async () => { throw new Error("nope"); } };
  const h = harness([echo, boom]);
  h.send({ id: 1, method: "tools/list" });
  assert.deepEqual((await h.next((m) => m.id === 1)).result.tools.map((t) => t.name), ["echo", "boom"]);

  h.send({ id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } });
  assert.deepEqual((await h.next((m) => m.id === 2)).result, { content: [{ type: "text", text: "hi" }] });

  h.send({ id: 3, method: "tools/call", params: { name: "boom", arguments: {} } });
  assert.deepEqual((await h.next((m) => m.id === 3)).result, { content: [{ type: "text", text: "nope" }], isError: true });

  h.send({ id: 4, method: "tools/call", params: { name: "missing" } });
  assert.equal((await h.next((m) => m.id === 4)).error.code, -32602);

  h.send({ id: 5, method: "resources/list" });
  assert.equal((await h.next((m) => m.id === 5)).error.code, -32601);

  h.send({ method: "notifications/initialized" });
  h.send({ id: 6, method: "ping" });
  assert.deepEqual((await h.next((m) => m.id === 6)).result, {});
});

test("confirm uses elicitation when the client supports it", async () => {
  const answers = [];
  const asker = { ...echo, name: "ask", call: async (_args, { confirm }) => {
    answers.push(await confirm("Write src/A.cs?"));
    return { content: [{ type: "text", text: String(answers.at(-1)) }] };
  } };

  const h = harness([asker]);
  h.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} } } });
  await h.next((m) => m.id === 1);

  h.send({ id: 2, method: "tools/call", params: { name: "ask", arguments: {} } });
  const request = await h.next((m) => m.method === "elicitation/create");
  assert.equal(request.params.message, "Write src/A.cs?");
  h.send({ id: request.id, result: { action: "accept", content: {} } });
  assert.equal((await h.next((m) => m.id === 2)).result.content[0].text, "true");

  h.send({ id: 3, method: "tools/call", params: { name: "ask", arguments: {} } });
  const second = await h.next((m) => m.method === "elicitation/create");
  h.send({ id: second.id, result: { action: "decline" } });
  assert.equal((await h.next((m) => m.id === 3)).result.content[0].text, "false");
});

test("confirm returns null without an elicitation capability", async () => {
  let seen;
  const asker = { ...echo, name: "ask", call: async (_args, { confirm }) => {
    seen = await confirm("Write?");
    return { content: [] };
  } };
  const h = harness([asker]);
  h.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  await h.next((m) => m.id === 1);
  h.send({ id: 2, method: "tools/call", params: { name: "ask", arguments: {} } });
  await h.next((m) => m.id === 2);
  assert.equal(seen, null);
  assert.equal(h.out.some((m) => m.method === "elicitation/create"), false);
});

test("a cancelled call aborts its signal and sends no result", async () => {
  let aborted;
  const slow = { ...echo, name: "slow", call: (_args, { signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => { aborted = true; resolve({ content: [] }); });
  }) };
  const h = harness([slow]);
  h.send({ id: 7, method: "tools/call", params: { name: "slow", arguments: {} } });
  h.send({ method: "notifications/cancelled", params: { requestId: 7, reason: "user" } });
  h.send({ id: 8, method: "ping" });
  await h.next((m) => m.id === 8);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.equal(h.out.some((m) => m.id === 7), false);
});

test("progress notifications are sent only when the call carries a progress token", async () => {
  const worker = { ...echo, name: "work", call: async (_args, { progress }) => {
    progress("attempt 1/3");
    progress("attempt 2/3");
    return { content: [] };
  } };
  const h = harness([worker]);
  h.send({ id: 1, method: "tools/call", params: { name: "work", arguments: {}, _meta: { progressToken: "p1" } } });
  await h.next((m) => m.id === 1);
  const notes = h.out.filter((m) => m.method === "notifications/progress");
  assert.deepEqual(notes.map((m) => m.params), [
    { progressToken: "p1", progress: 1, message: "attempt 1/3" },
    { progressToken: "p1", progress: 2, message: "attempt 2/3" }
  ]);

  h.out.length = 0;
  h.send({ id: 2, method: "tools/call", params: { name: "work", arguments: {} } });
  await h.next((m) => m.id === 2);
  assert.equal(h.out.some((m) => m.method === "notifications/progress"), false);
});

test("drain waits for in-flight tool calls", async () => {
  let release;
  const slow = { ...echo, name: "slow", call: () => new Promise((resolve) => { release = () => resolve({ content: [] }); }) };
  const out = [];
  const server = createMcpServer({ name: "t", version: "1", tools: [slow], write: (c) => out.push(JSON.parse(c)) });
  server.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow", arguments: {} } }));
  let drained = false;
  const draining = server.drain().then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  await draining;
  assert.equal(drained, true);
  assert.equal(out.at(-1).id, 1);
});

test("listRoots asks the client only when it offers roots", async () => {
  const seen = [];
  const rooted = { ...echo, name: "where", call: async (_args, { listRoots }) => {
    seen.push(await listRoots());
    return { content: [] };
  } };
  const h = harness([rooted]);
  h.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { roots: {} } } });
  await h.next((m) => m.id === 1);
  h.send({ id: 2, method: "tools/call", params: { name: "where", arguments: {} } });
  const request = await h.next((m) => m.method === "roots/list");
  h.send({ id: request.id, result: { roots: [{ uri: "file:///C:/work/app", name: "app" }] } });
  await h.next((m) => m.id === 2);

  h.send({ id: 3, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  await h.next((m) => m.id === 3);
  h.send({ id: 4, method: "tools/call", params: { name: "where", arguments: {} } });
  await h.next((m) => m.id === 4);

  assert.deepEqual(seen, [["file:///C:/work/app"], null]);
});
