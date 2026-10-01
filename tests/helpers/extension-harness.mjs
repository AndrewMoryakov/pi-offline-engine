// Shared harness for black-box tests of the Pi extension entrypoint: a
// recording fake ExtensionAPI, a fake OpenAI-compatible TinyCoder endpoint, a
// fake `dotnet` behind pi.exec, disposable workspaces, deterministic
// normalization and golden-file comparison.
//
// Goldens live in tests/golden/. They are compared by default and are only
// rewritten when PI_OFFLINE_UPDATE_GOLDEN=1 is set explicitly.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const UNDEFINED = "__undefined__";
const GOLDEN_DIR = new URL("../golden/", import.meta.url);

export function createFakePi({ exec, allTools = [], activeTools = [] } = {}) {
  const trace = [];
  const tools = {};
  const commands = {};
  const handlers = [];
  const execCalls = [];
  const activeWrites = [];
  let active = [...activeTools];
  const pi = {
    registerTool(tool) {
      trace.push(`tool:${tool.name}`);
      tools[tool.name] = tool;
    },
    registerCommand(name, definition) {
      trace.push(`command:${name}`);
      commands[name] = definition;
    },
    on(event, handler) {
      trace.push(`on:${event}`);
      handlers.push({ event, handler });
    },
    async exec(command, args, options) {
      execCalls.push({ command, args: [...args], options: { ...options, signal: options?.signal ? "<signal>" : options?.signal } });
      if (!exec) return { code: 0, stdout: "", stderr: "" };
      return exec(command, args, options);
    },
    getAllTools: () => allTools,
    getActiveTools: () => [...active],
    setActiveTools(names) {
      activeWrites.push([...names]);
      active = [...names];
    }
  };
  return { pi, trace, tools, commands, handlers, execCalls, activeWrites };
}

export function createUiRecorder({ confirm = true, select = null } = {}) {
  const calls = [];
  const ui = {
    async confirm(title, body) {
      calls.push({ kind: "confirm", title, body });
      return typeof confirm === "function" ? confirm(title, body) : confirm;
    },
    notify(message, level) {
      calls.push({ kind: "notify", message, level });
    },
    async select(title, options) {
      calls.push({ kind: "select", title, options });
      return typeof select === "function" ? select(title, options) : select;
    }
  };
  return { ui, calls };
}

// Each reply is either a string (assistant content), `{ content, usage }`, or
// `{ status, body }` for an HTTP failure. Past the end, the last reply repeats.
export async function fakeTinyCoder(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const index = Math.min(requests.length, replies.length) - 1;
      const reply = replies[index];
      if (reply && typeof reply === "object" && "status" in reply) {
        res.statusCode = reply.status;
        res.end(reply.body ?? "");
        return;
      }
      const content = typeof reply === "string" ? reply : reply.content;
      const usage = typeof reply === "object" && reply.usage
        ? reply.usage
        : { prompt_tokens: 100 + requests.length, completion_tokens: 10 + requests.length, total_tokens: 110 + 2 * requests.length };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export function trxDocument({ total = 1, executed = 1, tests = [["ATests", "Works", "Passed"]] } = {}) {
  const results = tests.map(([, name, outcome], index) =>
    `<UnitTestResult testId="t${index}" testName="${name}" outcome="${outcome}" />`).join("");
  const definitions = tests.map(([className, name], index) =>
    `<UnitTest id="t${index}" name="${name}"><TestMethod className="${className}" name="${name}" /></UnitTest>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?><TestRun><ResultSummary outcome="Completed"><Counters total="${total}" executed="${executed}" passed="${executed}" failed="0" /></ResultSummary><Results>${results}</Results><TestDefinitions>${definitions}</TestDefinitions></TestRun>`;
}

// Fake `dotnet` for pi.exec. `build` and `test` are per-call scripts (the last
// entry repeats). A build/test step is `{ code, stdout, stderr }`, `"throw"`,
// and a test step may carry `trx` (document text) to write where the logger
// or --report-trx-filename points.
export function fakeDotnet({ help = { code: 0, stdout: "Usage: dotnet test [options]\n  --logger", stderr: "" }, build = [{ code: 0 }], test = [{ code: 0, trx: trxDocument() }] } = {}) {
  let builds = 0;
  let tests = 0;
  return async (command, args) => {
    assert.equal(command, "dotnet");
    if (args[0] === "test" && args[1] === "--help") {
      if (help === "throw") throw new Error("fake dotnet --help crashed");
      return { stdout: "", stderr: "", ...help };
    }
    if (args[0] === "build") {
      const step = build[Math.min(builds, build.length - 1)];
      builds += 1;
      if (step === "throw") throw new Error("fake dotnet build crashed");
      return { stdout: "", stderr: "", ...step };
    }
    if (args[0] === "test") {
      const step = test[Math.min(tests, test.length - 1)];
      tests += 1;
      if (step === "throw") throw new Error("fake dotnet test crashed");
      const directory = args[args.indexOf("--results-directory") + 1];
      let fileName = null;
      const logger = args[args.indexOf("--logger") + 1];
      if (args.includes("--logger") && logger.startsWith("trx;LogFileName=")) fileName = logger.slice("trx;LogFileName=".length);
      if (args.includes("--report-trx-filename")) fileName = args[args.indexOf("--report-trx-filename") + 1];
      if (step.trx && directory && fileName) {
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, fileName), step.trx, "utf8");
      }
      const { trx, ...result } = step;
      return { stdout: "", stderr: "", ...result };
    }
    throw new Error(`unexpected dotnet invocation: ${args.join(" ")}`);
  };
}

export async function makeWorkspace(files = {
  "src/A.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>\n",
  "src/A.cs": "class A { int Value() => 1; }\n",
  "tests/ATests.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>\n"
}) {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-offline-ws-")));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(cwd, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
  return cwd;
}

export async function readJsonLines(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return null;
    throw error;
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export async function readEngineArtifacts(cwd) {
  const engineDir = path.join(cwd, ".pi", "offline-engine");
  const candidates = {};
  const candidateDir = path.join(engineDir, "candidates");
  if (fsSync.existsSync(candidateDir) && fsSync.statSync(candidateDir).isDirectory()) {
    for (const name of (await fs.readdir(candidateDir)).sort()) {
      candidates[name] = JSON.parse(await fs.readFile(path.join(candidateDir, name), "utf8"));
    }
  }
  return {
    events: await readJsonLines(path.join(engineDir, "events.jsonl")),
    training: await readJsonLines(path.join(engineDir, "training", "raw.jsonl")),
    candidates
  };
}

const TIMESTAMP_KEYS = new Set(["ts", "savedAt", "captured_at"]);
const ELAPSED_KEYS = new Set(["latencyMs", "latency_ms"]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Deep-walks parsed data: replaces workspace/agent roots in strings (in both
// separator styles, case-insensitively for Windows drive letters), and masks
// timestamps, elapsed milliseconds and random run ids. A key whose value is
// `undefined` is kept as a sentinel so key presence stays observable.
export function createNormalizer(roots) {
  const patterns = [];
  for (const [root, label] of roots) {
    const forms = new Set([root, root.replaceAll("\\", "/"), root.replaceAll("/", "\\")]);
    for (const form of forms) patterns.push([new RegExp(escapeRegExp(form), "gi"), label]);
  }
  const normalizeString = (value) => {
    let next = value;
    for (const [pattern, label] of patterns) next = next.replace(pattern, label);
    // Remaining separators inside a normalized root path are platform noise.
    return next.replace(/<(WS|AGENT)>([^\s"',;)]*)/g, (_match, label, rest) => `<${label}>${rest.replaceAll("\\", "/")}`);
  };
  const walk = (value, key) => {
    if (value === undefined) return UNDEFINED;
    if (TIMESTAMP_KEYS.has(key) && typeof value === "string") return "<TS>";
    if (ELAPSED_KEYS.has(key) && typeof value === "number") return "<MS>";
    if (key === "run_id" && typeof value === "string") return value.replace(/-[0-9a-f]{16}$/, "-<RUN>");
    if (typeof value === "string") return normalizeString(value);
    if (Array.isArray(value)) return value.map((item) => walk(item, null));
    if (value && typeof value === "object") {
      const out = {};
      for (const [childKey, child] of Object.entries(value)) out[childKey] = walk(child, childKey);
      return out;
    }
    return value;
  };
  return (value) => walk(value, null);
}

export async function expectGolden(name, value) {
  const file = new URL(`${name}.json`, GOLDEN_DIR);
  const actual = JSON.parse(JSON.stringify(value));
  if (process.env.PI_OFFLINE_UPDATE_GOLDEN === "1") {
    await fs.mkdir(new URL(".", file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(actual, null, 2) + "\n", "utf8");
    return;
  }
  let expected;
  try {
    expected = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") assert.fail(`missing golden ${name}.json (run with PI_OFFLINE_UPDATE_GOLDEN=1 once, then review it)`);
    throw error;
  }
  assert.deepStrictEqual(actual, expected, `golden mismatch: ${name}`);
}

// Replaces environment variables for the duration of `fn`, restoring the
// previous values (including absence) afterwards.
export async function withEnv(vars, fn) {
  const previous = {};
  for (const [name, value] of Object.entries(vars)) {
    previous[name] = Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
