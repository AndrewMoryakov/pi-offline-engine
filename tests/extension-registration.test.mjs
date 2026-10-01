// Black-box characterization of the extension's registration surface and of
// its lifecycle hooks and session-scoped commands, driven through the real
// entrypoint with a recording fake Pi API. Configuration-writing commands live
// in extension-commands.test.mjs so that no test here depends on a config file
// written by another extension instance.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createFakePi,
  createNormalizer,
  createUiRecorder,
  expectGolden,
  makeWorkspace,
  readJsonLines,
  withEnv
} from "./helpers/extension-harness.mjs";

const agentDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-offline-agent-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const name of [
  "PI_OFFLINE_COMPACT_TOOL_RESULTS", "PI_OFFLINE_REPO_CAPSULE", "PI_OFFLINE_TRAINING_CAPTURE",
  "PI_OFFLINE_TINY_ENDPOINT", "PI_OFFLINE_TINY_MODEL", "PI_OFFLINE_TINY_API_KEY", "OPENROUTER_API_KEY"
]) delete process.env[name];
// A configured endpoint makes first-run discovery skip without probing ports.
process.env.PI_OFFLINE_TINY_ENDPOINT = "http://127.0.0.1:9";

const { default: offlineEngine } = await import("../extensions/index.ts");

function load(options = {}, env = {}) {
  return withEnv({ PI_KNOWLEDGE_SEARCH_PROFILE: undefined, ...env }, async () => {
    const fake = createFakePi(options);
    offlineEngine(fake.pi);
    return fake;
  });
}

function handlersFor(fake, event) {
  return fake.handlers.filter((entry) => entry.event === event).map((entry) => entry.handler);
}

async function emit(fake, event, payload, ctx) {
  const results = [];
  for (const handler of handlersFor(fake, event)) results.push(await handler(payload, ctx));
  return results;
}

test("registration order: tools, then lifecycle hooks, then commands", async () => {
  const fake = await load();
  assert.deepEqual(fake.trace, [
    "tool:delegate_implementation",
    "tool:execute_delegated_implementation",
    "on:session_start",
    "on:session_start",
    "on:session_compact",
    "on:session_tree",
    "on:before_agent_start",
    "on:before_agent_start",
    "on:context",
    "on:tool_result",
    "command:offline-context",
    "command:offline-compact",
    "command:offline-doctor",
    "command:offline-setup",
    "command:offline-tools",
    "command:offline-training",
    "command:offline-stats",
    "command:offline-status"
  ]);
});

test("tool metadata and parameter schemas are unchanged", async () => {
  const fake = await load();
  const tools = Object.values(fake.tools).map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    parameters: JSON.parse(JSON.stringify(tool.parameters)),
    otherKeys: Object.keys(tool).sort()
  }));
  await expectGolden("registration/tools", tools);
  assert.equal(fake.tools.delegate_implementation.parameters, fake.tools.execute_delegated_implementation.parameters);
});

test("strict ImplementationSpec schema: modify_symbol, at most two files, no open spec object", async () => {
  const fake = await load();
  const params = JSON.parse(JSON.stringify(fake.tools.execute_delegated_implementation.parameters));
  assert.equal(params.additionalProperties, false);
  assert.deepEqual(params.required, ["spec"]);
  const spec = params.properties.spec;
  assert.equal(spec.additionalProperties, false);
  assert.equal(spec.properties.operation.const, "modify_symbol");
  assert.equal(spec.properties.scope.properties.allowed_files.minItems, 1);
  assert.equal(spec.properties.scope.properties.allowed_files.maxItems, 2);
  for (const flag of ["allow_new_files", "allow_dependencies", "allow_public_api_change"]) {
    assert.equal(spec.properties.scope.properties[flag].type, "boolean");
    assert.ok(spec.properties.scope.required.includes(flag));
  }
});

test("execute guidelines keep the semantic-completion and sibling-mutation guards", async () => {
  const fake = await load();
  const guidelines = fake.tools.execute_delegated_implementation.promptGuidelines;
  assert.ok(guidelines.some((line) => /verification_passed as compiler\/test evidence only/.test(line)));
  assert.ok(guidelines.some((line) => /only mutating tool in its assistant turn/.test(line)));
  assert.ok(guidelines.every((line) => !line.includes("\n") && !line.includes("\\n")));
});

test("command descriptions and argument completions are unchanged", async () => {
  const fake = await load();
  const prefixes = ["", " ", "s", "st", "o", "on", "of", "r", "re", "RE", "m", "e", "x"];
  const commands = {};
  for (const [name, definition] of Object.entries(fake.commands)) {
    commands[name] = {
      description: definition.description,
      keys: Object.keys(definition).sort(),
      completions: definition.getArgumentCompletions
        ? Object.fromEntries(prefixes.map((prefix) => [JSON.stringify(prefix), definition.getArgumentCompletions(prefix)]))
        : null
    };
  }
  await expectGolden("registration/commands", commands);
  assert.equal(fake.commands["offline-setup"].getArgumentCompletions(""), null);
});

test("companion environment default is applied and reported by source", async () => {
  await withEnv({ PI_KNOWLEDGE_SEARCH_PROFILE: undefined }, async () => {
    const fake = createFakePi();
    offlineEngine(fake.pi);
    assert.equal(process.env.PI_KNOWLEDGE_SEARCH_PROFILE, "low_token");
  });
  await withEnv({ PI_KNOWLEDGE_SEARCH_PROFILE: "balanced" }, async () => {
    const fake = createFakePi();
    offlineEngine(fake.pi);
    assert.equal(process.env.PI_KNOWLEDGE_SEARCH_PROFILE, "balanced");
  });
});

// --- lifecycle hooks ---------------------------------------------------------

function gitExec(state) {
  return async (command, args) => {
    assert.equal(command, "git");
    const joined = args.join(" ");
    if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: `${state.root}\n`, stderr: "" };
    if (joined === "branch --show-current") return { code: 0, stdout: "main\n", stderr: "" };
    if (joined === "rev-parse --short=12 HEAD") return { code: 0, stdout: "abcdef123456\n", stderr: "" };
    if (joined.startsWith("status")) return { code: 0, stdout: state.dirty.join("\n"), stderr: "" };
    if (joined.startsWith("ls-files")) return { code: 0, stdout: "src/A.csproj\n", stderr: "" };
    throw new Error(`unexpected git ${joined}`);
  };
}

test("repository capsule: injected once per fingerprint and invalidated by session events and refresh", async () => {
  const cwd = await makeWorkspace();
  const state = { root: "/fake/repo", dirty: [" M src/A.cs"] };
  const fake = await load({ exec: gitExec(state) });
  const recorder = createUiRecorder();
  const ctx = { cwd, hasUI: true, ui: recorder.ui };
  const prompt = async () => (await emit(fake, "before_agent_start", { systemPromptOptions: {} }, ctx))[1];

  const first = await prompt();
  assert.equal(first.message.customType, "pi-offline-repo-capsule");
  assert.equal(first.message.display, false);
  assert.match(first.message.content, /^\[pi-offline-engine repository snapshot\]/);
  assert.equal(await prompt(), undefined, "same fingerprint is not re-injected");

  for (const event of ["session_compact", "session_tree"]) {
    await emit(fake, event, {}, ctx);
    assert.ok(await prompt(), `${event} invalidates the fingerprint`);
    assert.equal(await prompt(), undefined);
  }

  await handlersFor(fake, "session_start")[0]({}, ctx);
  assert.ok(await prompt(), "session_start invalidates the fingerprint");

  state.dirty = [" M src/A.cs", " M src/B.cs"];
  assert.ok(await prompt(), "changed facts re-inject");

  await fake.commands["offline-context"].handler("off", ctx);
  state.dirty = [];
  assert.equal(await prompt(), undefined, "off suppresses the capsule");
  await fake.commands["offline-context"].handler("refresh", ctx);
  assert.ok(await prompt(), "refresh turns it on and resends");
  await fake.commands["offline-context"].handler("refresh", ctx);
  assert.ok(await prompt(), "refresh resends an unchanged capsule");

  const normalize = createNormalizer([[cwd, "<WS>"]]);
  await expectGolden("registration/capsule", normalize({
    firstMessage: first,
    events: await readJsonLines(path.join(cwd, ".pi", "offline-engine", "events.jsonl")),
    ui: recorder.calls
  }));
});

test("repository capsule can be disabled from the environment at load", async () => {
  const cwd = await makeWorkspace();
  const fake = await load({ exec: gitExec({ root: cwd, dirty: [] }) }, { PI_OFFLINE_REPO_CAPSULE: "0" });
  const results = await emit(fake, "before_agent_start", { systemPromptOptions: {} }, { cwd });
  assert.equal(results[1], undefined);
  assert.deepEqual(fake.execCalls, []);
});

test("before_agent_start applies the code-tool policy only when code is selected", async () => {
  const fake = await load({}, { PI_OFFLINE_REPO_CAPSULE: "0" });
  const withCode = { systemPromptOptions: { selectedTools: ["code"], promptGuidelines: ["existing"] } };
  await emit(fake, "before_agent_start", withCode, { cwd: os.tmpdir() });
  assert.equal(withCode.systemPromptOptions.promptGuidelines[0], "existing");
  assert.equal(withCode.systemPromptOptions.promptGuidelines.length, 4);
  const withoutCode = { systemPromptOptions: { selectedTools: ["read"] } };
  await emit(fake, "before_agent_start", withoutCode, { cwd: os.tmpdir() });
  assert.equal(withoutCode.systemPromptOptions.promptGuidelines, undefined);
});

test("context hook keeps only the latest repository capsule", async () => {
  const fake = await load();
  const [handler] = handlersFor(fake, "context");
  assert.equal(await handler({ messages: [{ role: "user" }] }, {}), undefined);
  const messages = [
    { customType: "pi-offline-repo-capsule", id: 1 },
    { role: "user", id: 2 },
    { customType: "pi-offline-repo-capsule", id: 3 },
    { role: "assistant", id: 4 }
  ];
  assert.deepEqual((await handler({ messages }, {})).messages.map((x) => x.id), [2, 3, 4]);
});

test("tool_result compaction follows /offline-compact and records an event", async () => {
  const cwd = await makeWorkspace();
  const fake = await load();
  const recorder = createUiRecorder();
  const ctx = { cwd, hasUI: true, ui: recorder.ui };
  const [handler] = handlersFor(fake, "tool_result");
  const noisy = Array.from({ length: 400 }, (_, i) => `  line ${i} of verbose dotnet output padding padding`).join("\n") +
    "\nsrc/A.cs(1,1): error CS0001: broken\nBuild FAILED.";
  const event = { toolName: "bash", toolCallId: "tc-1", input: { command: "dotnet build src/A.csproj" }, content: [{ type: "text", text: noisy }] };

  const compacted = await handler(event, ctx);
  assert.ok(compacted.content[0].text.length < noisy.length);
  assert.equal(await handler({ ...event, input: { command: "ls" } }, ctx), undefined);

  await fake.commands["offline-compact"].handler("off", ctx);
  assert.equal(await handler(event, ctx), undefined);
  await fake.commands["offline-compact"].handler("status", ctx);
  await fake.commands["offline-compact"].handler("on", ctx);
  await fake.commands["offline-compact"].handler("bogus", ctx);

  const normalize = createNormalizer([[cwd, "<WS>"]]);
  await expectGolden("registration/compaction", normalize({
    compacted,
    events: await readJsonLines(path.join(cwd, ".pi", "offline-engine", "events.jsonl")),
    ui: recorder.calls
  }));
});

test("tool_result compaction can be disabled from the environment at load", async () => {
  const fake = await load({}, { PI_OFFLINE_COMPACT_TOOL_RESULTS: "0" });
  const [handler] = handlersFor(fake, "tool_result");
  const text = "x".repeat(20000);
  assert.equal(await handler({ toolName: "bash", toolCallId: "t", input: { command: "dotnet test" }, content: [{ type: "text", text }] }, { cwd: os.tmpdir() }), undefined);
});

test("session_start auto-setup is skipped for a configured endpoint and never notifies", async () => {
  const fake = await load();
  const recorder = createUiRecorder();
  await emit(fake, "session_start", {}, { cwd: os.tmpdir(), hasUI: true, ui: recorder.ui });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(recorder.calls, []);
});

// --- session-scoped commands -------------------------------------------------

test("/offline-context modes and messages", async () => {
  const fake = await load({}, { PI_OFFLINE_REPO_CAPSULE: "0" });
  const recorder = createUiRecorder();
  const ctx = { cwd: os.tmpdir(), hasUI: true, ui: recorder.ui };
  for (const args of [undefined, "", "  STATUS ", "on", "off", "refresh", "nope"]) {
    await fake.commands["offline-context"].handler(args, ctx);
  }
  await expectGolden("registration/offline-context", recorder.calls);
});

test("/offline-tools minimal and restore keep an edit hidden by the edit adapter hidden", async () => {
  const allTools = ["read", "edit", "line_edit", "write", "bash", "grep", "find", "ls", "custom", "execute_delegated_implementation", "delegate_implementation"]
    .map((name) => ({ name }));
  const initialActive = ["read", "line_edit", "write", "bash", "custom", "execute_delegated_implementation", "delegate_implementation"];
  const fake = await load({ allTools, activeTools: initialActive });
  const recorder = createUiRecorder();
  const ctx = { cwd: os.tmpdir(), hasUI: true, ui: recorder.ui };
  const run = (args) => fake.commands["offline-tools"].handler(args, ctx);

  await run("restore");
  await run("");
  await run("minimal");
  assert.equal(fake.pi.getActiveTools().includes("edit"), false);
  await run("minimal");
  await run("restore");
  assert.deepEqual(fake.pi.getActiveTools(), initialActive);
  await run("restore");
  await expectGolden("registration/offline-tools", { ui: recorder.calls, activeWrites: fake.activeWrites });
});

test("/offline-training modes, status and export", async () => {
  const cwd = await makeWorkspace();
  const fake = await load();
  const recorder = createUiRecorder();
  const ctx = { cwd, hasUI: true, ui: recorder.ui };
  for (const args of ["", "on", "status", "off", "status", "bogus", "export"]) {
    await fake.commands["offline-training"].handler(args, ctx);
  }
  const normalize = createNormalizer([[cwd, "<WS>"]]);
  await expectGolden("registration/offline-training", normalize(recorder.calls));
});

test("/offline-training on enables capture for the next delegated execution only in that instance", async () => {
  const cwd = await makeWorkspace();
  const first = await load();
  const second = await load();
  const recorder = createUiRecorder();
  await first.commands["offline-training"].handler("on", { cwd, hasUI: true, ui: recorder.ui });
  await second.commands["offline-training"].handler("status", { cwd, hasUI: true, ui: recorder.ui });
  await first.commands["offline-training"].handler("status", { cwd, hasUI: true, ui: recorder.ui });
  assert.match(recorder.calls[1].message, /^Training capture: off/);
  assert.match(recorder.calls[2].message, /^Training capture: on/);
});

test("/offline-stats summarizes the event ledger", async () => {
  const cwd = await makeWorkspace();
  await fs.mkdir(path.join(cwd, ".pi", "offline-engine"), { recursive: true });
  const rows = [
    { ts: "2026-01-01T00:00:00.000Z", type: "tiny_started", specId: "s", mode: "execute", attempt: 1 },
    { ts: "2026-01-01T00:00:01.000Z", type: "tiny_finished", specId: "s", mode: "execute", attempt: 1, latencyMs: 1000, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, candidateValid: true },
    { ts: "2026-01-01T00:00:02.000Z", type: "tool_result_compacted", originalChars: 9000, compactedChars: 900 }
  ];
  await fs.writeFile(path.join(cwd, ".pi", "offline-engine", "events.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const fake = await load();
  const recorder = createUiRecorder();
  await fake.commands["offline-stats"].handler("", { cwd, hasUI: true, ui: recorder.ui });
  await expectGolden("registration/offline-stats", recorder.calls);
});

test("multiple extension instances do not share session toggles", async () => {
  const cwd = await makeWorkspace();
  const first = await load();
  const second = await load();
  const recorder = createUiRecorder();
  const ctx = { cwd, hasUI: true, ui: recorder.ui };
  await first.commands["offline-compact"].handler("off", ctx);
  await second.commands["offline-compact"].handler("status", ctx);
  await first.commands["offline-context"].handler("off", ctx);
  await second.commands["offline-context"].handler("status", ctx);
  assert.deepEqual(recorder.calls.map((call) => call.message), [
    "Dotnet tool-result compaction: off",
    "Dotnet tool-result compaction: on",
    "Repository context capsule: off",
    "Repository context capsule: on"
  ]);
});
