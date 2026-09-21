import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  DEFAULT_CANDIDATES,
  discoverEndpoints,
  pickChatModel,
  probeEndpoint
} from "../src/endpoint-discovery.mjs";

function catalog(ids) {
  return { ok: true, status: 200, async json() { return { object: "list", data: ids.map((id) => ({ id })) }; } };
}

function fakeFetch(routes) {
  return async (url) => {
    const key = new URL(url).origin;
    const route = routes[key];
    if (!route) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    return route;
  };
}

test("probes llama-server's default port first", () => {
  assert.equal(DEFAULT_CANDIDATES[0].endpoint, "http://127.0.0.1:8080");
  const ports = DEFAULT_CANDIDATES.map((x) => new URL(x.endpoint).port);
  assert.deepEqual(ports, ["8080", "8081", "1234", "11434"]);
});

test("never picks an embedding or reranking model as the implementer", () => {
  assert.equal(pickChatModel(["text-embedding-nomic-embed-text-v1.5"]), null);
  assert.equal(pickChatModel(["bge-reranker-v2-m3", "nomic-embed-text"]), null);
  assert.equal(pickChatModel(["text-embedding-nomic-embed-text-v1.5", "qwen2.5-7b-instruct"]), "qwen2.5-7b-instruct");
});

test("prefers a coder model when several chat models are served", () => {
  assert.equal(pickChatModel(["llama-3.1-8b-instruct", "qwen2.5-coder-3b-instruct"]), "qwen2.5-coder-3b-instruct");
  assert.equal(pickChatModel(["llama-3.1-8b-instruct", "gemma-2-9b"]), "llama-3.1-8b-instruct");
  assert.equal(pickChatModel([]), null);
});

test("configures the first reachable endpoint that serves a chat model", async () => {
  const fetchFn = fakeFetch({
    // LM Studio with only an embedding model downloaded: reachable but unusable.
    "http://127.0.0.1:1234": catalog(["text-embedding-nomic-embed-text-v1.5"]),
    "http://127.0.0.1:11434": catalog(["qwen2.5-coder:3b"])
  });

  const result = await discoverEndpoints({ fetchFn, timeoutMs: 200 });
  assert.equal(result.selected.endpoint, "http://127.0.0.1:11434");
  assert.equal(result.selected.model, "qwen2.5-coder:3b");

  const lmStudio = result.found.find((x) => x.endpoint === "http://127.0.0.1:1234");
  assert.equal(lmStudio.reachable, true);
  assert.equal(lmStudio.model, null);
  assert.match(lmStudio.note, /no chat model/i);
});

test("honours candidate priority when several servers answer", async () => {
  const fetchFn = fakeFetch({
    "http://127.0.0.1:8080": catalog(["C:\\models\\qwen2.5-coder-3b-instruct-q4_k_m.gguf"]),
    "http://127.0.0.1:1234": catalog(["qwen2.5-coder-7b-instruct"])
  });

  const result = await discoverEndpoints({ fetchFn, timeoutMs: 200 });
  assert.equal(result.selected.endpoint, "http://127.0.0.1:8080");
  assert.equal(result.usable.length, 2);
});

test("returns no selection when nothing is listening", async () => {
  const result = await discoverEndpoints({ fetchFn: fakeFetch({}), timeoutMs: 200 });
  assert.equal(result.selected, null);
  assert.equal(result.usable.length, 0);
  assert.ok(result.found.every((x) => x.reachable === false));
});

test("treats a non-JSON or error response as unreachable", async () => {
  const html = { ok: false, status: 404, async json() { throw new SyntaxError("Unexpected token '<'"); } };
  const probe = await probeEndpoint({ endpoint: "http://127.0.0.1:8080", fetchFn: async () => html, timeoutMs: 200 });
  assert.equal(probe.reachable, false);
});

test("a hanging port cannot stall discovery past its timeout", async () => {
  const server = http.createServer(() => { /* never responds */ });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  try {
    const started = Date.now();
    const result = await discoverEndpoints({
      candidates: [{ endpoint, label: "hang" }],
      timeoutMs: 250
    });
    assert.ok(Date.now() - started < 2000, "discovery must honour its timeout");
    assert.equal(result.selected, null);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("discovers a real OpenAI-compatible server over HTTP", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "qwen2.5-coder-3b-instruct" }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  try {
    const result = await discoverEndpoints({ candidates: [{ endpoint, label: "stub" }], timeoutMs: 1000 });
    assert.equal(result.selected.endpoint, endpoint);
    assert.equal(result.selected.model, "qwen2.5-coder-3b-instruct");
    assert.equal(result.selected.label, "stub");
  } finally {
    server.close();
  }
});
