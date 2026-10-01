// Minimal dependency-free MCP server over stdio (newline-delimited JSON-RPC
// 2.0). It implements what the engine needs and nothing more: initialize,
// ping, tools/list, tools/call, request cancellation, and server-initiated
// elicitation for the one scope confirmation a delegated write requires.
// Keeping it dependency-free lets the Claude Code plugin and `npx` from git
// run without an install step, like the rest of src/.

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export function createMcpServer({ name, version, instructions = undefined, tools, write, log = () => {} }) {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const inflight = new Map();
  const pendingClientRequests = new Map();
  const running = new Set();
  let clientCapabilities = {};
  let nextServerRequestId = 1;

  function send(message) {
    write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  function reply(id, result) {
    send({ id, result });
  }

  function fail(id, code, message) {
    send({ id, error: { code, message } });
  }

  function requestClient(method, params, signal) {
    const id = `s${nextServerRequestId++}`;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        pendingClientRequests.delete(id);
        reject(signal.reason ?? new Error("aborted"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      pendingClientRequests.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", onAbort); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); }
      });
      send({ id, method, params });
    });
  }

  // Resolves to true/false when the client can ask its user, or null when it
  // cannot (no elicitation capability): the caller then relies on the
  // client's own tool-permission prompt.
  async function confirm(message, signal) {
    if (!clientCapabilities?.elicitation) return null;
    const result = await requestClient("elicitation/create", {
      message,
      requestedSchema: { type: "object", properties: {}, required: [] }
    }, signal);
    return result?.action === "accept";
  }

  // The client's workspace roots as file:// URIs, or null when it does not
  // offer them.
  async function listRoots(signal) {
    if (!clientCapabilities?.roots) return null;
    const result = await requestClient("roots/list", {}, signal);
    return Array.isArray(result?.roots) ? result.roots.map((root) => root?.uri).filter((uri) => typeof uri === "string") : [];
  }

  async function callTool(id, params) {
    const tool = toolsByName.get(params?.name);
    if (!tool) return fail(id, -32602, `Unknown tool: ${String(params?.name)}`);
    const controller = new AbortController();
    inflight.set(id, controller);
    // Progress keeps long delegated runs visible, and some clients extend
    // their tool timeout while progress arrives. Sent only when asked for.
    const progressToken = params?._meta?.progressToken;
    let progressCount = 0;
    const progress = (message) => {
      if (progressToken === undefined || controller.signal.aborted) return;
      progressCount += 1;
      send({ method: "notifications/progress", params: { progressToken, progress: progressCount, message } });
    };
    try {
      const result = await tool.call(params.arguments ?? {}, {
        signal: controller.signal,
        confirm: (message) => confirm(message, controller.signal),
        progress,
        listRoots: () => listRoots(controller.signal),
        clientCapabilities
      });
      if (!controller.signal.aborted) reply(id, result);
    } catch (error) {
      if (controller.signal.aborted) return;
      reply(id, {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true
      });
    } finally {
      inflight.delete(id);
    }
  }

  async function handle(message) {
    if (message.method === undefined) {
      const pending = pendingClientRequests.get(message.id);
      if (!pending) return;
      pendingClientRequests.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "client error"));
      else pending.resolve(message.result);
      return;
    }

    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case "initialize": {
        clientCapabilities = params?.capabilities ?? {};
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
        return reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {})
        });
      }
      case "notifications/initialized":
        return;
      case "notifications/cancelled":
        inflight.get(params?.requestId)?.abort(new Error(params?.reason ?? "cancelled by client"));
        return;
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, {
          tools: tools.map(({ name: toolName, title, description, inputSchema, annotations }) => ({
            name: toolName,
            ...(title ? { title } : {}),
            description,
            inputSchema,
            ...(annotations ? { annotations } : {})
          }))
        });
      case "tools/call": {
        const call = callTool(id, params);
        running.add(call);
        call.finally(() => running.delete(call));
        return call;
      }
      default:
        if (!isNotification) fail(id, -32601, `Method not found: ${method}`);
    }
  }

  function receive(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return fail(null, -32700, "Parse error");
    }
    handle(message).catch((error) => log(`handler error: ${error?.stack ?? error}`));
  }

  // Resolves once every tools/call in progress has settled, so closing stdin
  // never cuts a delegated run off between apply and verification.
  async function drain() {
    while (running.size > 0) await Promise.allSettled([...running]);
  }

  return { receive, drain };
}

export function serveStdio(options) {
  const server = createMcpServer({
    ...options,
    write: (chunk) => process.stdout.write(chunk),
    log: (text) => process.stderr.write(`${text}\n`)
  });
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      server.receive(line);
    }
  });
  process.stdin.on("end", () => {
    server.drain().finally(() => process.exit(0));
  });
  return server;
}
