import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callTinyImplementer, TinyModelOutputError } from "../src/tiny-client.mjs";
import { resolveEngineSettings } from "../src/engine-config.mjs";
import { runOfflineDoctor, describeImplementer, describeImplementerLocality } from "../src/offline-doctor.mjs";
import { autoConfigureIfNeeded, formatEngineStatus } from "../src/engine-setup.mjs";

// A stand-in for the Claude Code CLI. It records what it was given and answers
// in the shapes the real `claude -p --output-format json` produced when probed
// on 2026-11-19 (Claude Code 2.1.328): a success envelope with
// structured_output, an is_error envelope with exit 1 for an unknown model,
// and nothing at all when killed.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
    args: process.argv.slice(2), input, cwd: process.cwd(),
    pluginDirs: process.env.CLAUDE_CODE_PLUGIN_DIRS ?? null
  }));
  const mode = process.env.FAKE_MODE;
  if (mode === "sleep") { setTimeout(() => {}, 60000); return; }
  if (mode === "garbage") { process.stdout.write("not json at all"); return; }
  if (mode === "api_error") {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_type: "invalid_request_error",
      result: "There's an issue with the selected model (claude-nope). It may not exist or you may not have access to it." }));
    process.exitCode = 1;
    return;
  }
  if (mode === "text_only") {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "I would rather explain than edit." }));
    return;
  }
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, num_turns: 2,
    result: "{}",
    structured_output: { status: "candidate", reason: null, changes: [
      { path: "src/A.cs", operation: "replace_text", expected: ">= 100m", content: "> 100m" }
    ] },
    usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 2138, output_tokens: 414 }
  }));
});
`;

const posixOnly = { skip: process.platform === "win32" ? "the fake CLI is a POSIX shebang script" : false };

function fakeCli() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 });
  const record = path.join(dir, "record.json");
  return { dir, bin, record, read: () => JSON.parse(fs.readFileSync(record, "utf8")) };
}

const spec = {
  version: 1,
  spec_id: "claude-code-provider",
  operation: "modify_symbol",
  goal: { summary: "Discount only above 100." },
  target: { file: "src/A.cs", symbol: "A.Apply" },
  requirements: ["Discount only when total > 100."],
  scope: { allowed_files: ["src/A.cs"], allow_new_files: false, allow_dependencies: false, allow_public_api_change: false },
  verification: { build: { project: "src/A.csproj" } }
};

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("claude-code provider runs the CLI once, cleanly, and returns the structured candidate", posixOnly, async () => {
  const cli = fakeCli();
  const result = await withEnv({ FAKE_MODE: "ok", FAKE_RECORD: cli.record, CLAUDE_CODE_PLUGIN_DIRS: "/parent/mods" }, () =>
    callTinyImplementer({
      provider: "claude-code", claudeBin: cli.bin, endpoint: "http://never-used.invalid", model: "claude-haiku-5-5",
      spec, context: {}, currentFiles: { "src/A.cs": { exists: true, content: "x >= 100m" } }, timeoutMs: 20_000
    }));

  assert.deepEqual(result.candidate, {
    status: "candidate",
    changes: [{ path: "src/A.cs", operation: "replace_text", expected: ">= 100m", content: "> 100m" }]
  });
  assert.equal(result.structuredOutputMode, "claude_code_json_schema");
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 414, cacheReadTokens: 100, cacheWriteTokens: 2138, totalTokens: 2654 });

  const seen = cli.read();
  const flag = (name) => seen.args[seen.args.indexOf(name) + 1];
  assert.equal(seen.args[0], "-p");
  assert.equal(flag("--model"), "claude-haiku-5-5");
  assert.equal(flag("--tools"), "");
  assert.equal(flag("--setting-sources"), "");
  assert.ok(seen.args.includes("--strict-mcp-config"));
  assert.ok(seen.args.includes("--no-session-persistence"));
  assert.equal(flag("--output-format"), "json");
  assert.match(flag("--system-prompt"), /bounded implementation backend/);
  assert.equal(JSON.parse(flag("--json-schema")).required.join(","), "status,reason,changes");
  // The prompt travels on stdin, not on the command line.
  const message = JSON.parse(seen.input);
  assert.equal(message.implementation_spec.spec_id, "claude-code-provider");
  assert.equal(message.current_files["src/A.cs"].content, "x >= 100m");
  assert.ok(!seen.args.some((arg) => arg.includes("x >= 100m")));
  // Parent plugins stay out, and the run happens in a throwaway directory.
  assert.equal(seen.pluginDirs, null);
  assert.notEqual(path.resolve(seen.cwd), path.resolve(process.cwd()));
  assert.equal(fs.existsSync(seen.cwd), false);
});

test("claude-code provider turns an is_error envelope into a transport error", posixOnly, async () => {
  const cli = fakeCli();
  await withEnv({ FAKE_MODE: "api_error", FAKE_RECORD: cli.record }, async () => {
    const error = await callTinyImplementer({ provider: "claude-code", claudeBin: cli.bin, model: "claude-nope", spec, timeoutMs: 20_000 })
      .then(() => null, (e) => e);
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof TinyModelOutputError), "a CLI failure is not the model's output");
    assert.match(error.message, /^claude CLI exit 1 invalid_request_error: There's an issue with the selected model/);
  });
});

test("claude-code provider treats unparseable CLI output as a transport error", posixOnly, async () => {
  const cli = fakeCli();
  await withEnv({ FAKE_MODE: "garbage", FAKE_RECORD: cli.record }, async () => {
    const error = await callTinyImplementer({ provider: "claude-code", claudeBin: cli.bin, model: "m", spec, timeoutMs: 20_000 }).then(() => null, (e) => e);
    assert.ok(error instanceof Error && !(error instanceof TinyModelOutputError));
    assert.match(error.message, /^claude CLI exit 0: not json at all/);
  });
});

test("claude-code provider reports a reply without a JSON candidate as model output", posixOnly, async () => {
  const cli = fakeCli();
  await withEnv({ FAKE_MODE: "text_only", FAKE_RECORD: cli.record }, async () => {
    await assert.rejects(
      callTinyImplementer({ provider: "claude-code", claudeBin: cli.bin, model: "m", spec, timeoutMs: 20_000 }),
      (error) => error instanceof TinyModelOutputError
    );
  });
});

test("claude-code provider stops a CLI that does not answer in time", posixOnly, async () => {
  const cli = fakeCli();
  await withEnv({ FAKE_MODE: "sleep", FAKE_RECORD: cli.record }, async () => {
    await assert.rejects(
      callTinyImplementer({ provider: "claude-code", claudeBin: cli.bin, model: "m", spec, timeoutMs: 400 }),
      /tiny implementer timeout: claude CLI did not finish/
    );
  });
});

test("claude-code provider says when the CLI cannot be started", async () => {
  await assert.rejects(
    callTinyImplementer({ provider: "claude-code", claudeBin: path.join(os.tmpdir(), "no-such-claude-binary"), model: "m", spec, timeoutMs: 5_000 }),
    /^Error: claude CLI could not start/
  );
});

test("settings: claude-code provider defaults the model to Haiku and keeps explicit choices", () => {
  const fromEnv = resolveEngineSettings({ env: { PI_OFFLINE_TINY_PROVIDER: "claude-code" } });
  assert.equal(fromEnv.provider, "claude-code");
  assert.equal(fromEnv.model, "claude-haiku-5-5");
  assert.equal(fromEnv.sources.provider, "env");
  assert.equal(fromEnv.claudeBin, "claude");

  const fromConfig = resolveEngineSettings({ env: { PI_OFFLINE_CLAUDE_BIN: "/opt/claude" }, config: { provider: "claude-code", model: "claude-sonnet-5-5" } });
  assert.equal(fromConfig.provider, "claude-code");
  assert.equal(fromConfig.model, "claude-sonnet-5-5");
  assert.equal(fromConfig.claudeBin, "/opt/claude");

  const unknown = resolveEngineSettings({ env: { PI_OFFLINE_TINY_PROVIDER: "something-else" } });
  assert.equal(unknown.provider, "openai-compatible");
  assert.equal(unknown.model, "qwen2.5-coder-3b-instruct");
});

test("doctor checks the Claude CLI and says the source goes to Anthropic", async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "/usr/local/bin/claude") return { code: 0, killed: false, stdout: "2.1.328 (Claude Code)\n", stderr: "" };
    if (command === "dotnet") return { code: 0, killed: false, stdout: "ok", stderr: "" };
    throw new Error("missing");
  };
  const fetchFn = async () => { throw new Error("no HTTP request is expected for the claude-code provider"); };
  const report = await runOfflineDoctor({
    cwd: "/tmp", provider: "claude-code", claudeBin: "/usr/local/bin/claude", endpoint: "http://127.0.0.1:8080", model: "claude-haiku-5-5",
    tools: [{ name: "execute_delegated_implementation", sourceInfo: { source: "extension" } }], exec, fetchFn
  });
  const implementer = report.checks.find((check) => check.id === "tiny_endpoint");
  const locality = report.checks.find((check) => check.id === "endpoint_locality");
  assert.equal(implementer.ok, true);
  assert.equal(implementer.message, "claude CLI 2.1.328 (Claude Code); model claude-haiku-5-5 is checked on the first call");
  assert.equal(locality.status, "warn");
  assert.match(locality.message, /go to Anthropic/);
  assert.ok(calls.includes("/usr/local/bin/claude --version"));

  const missing = await runOfflineDoctor({
    cwd: "/tmp", provider: "claude-code", claudeBin: "claude", model: "claude-haiku-5-5", tools: [],
    exec: async () => ({ code: 127, killed: false, stdout: "", stderr: "claude: not found" }), fetchFn
  });
  assert.equal(missing.checks.find((check) => check.id === "tiny_endpoint").status, "error");
  assert.equal(missing.ready, false);
});

test("claude-code provider needs no server discovery and shows up in status", async () => {
  const settings = resolveEngineSettings({ env: { PI_OFFLINE_TINY_PROVIDER: "claude-code" } });
  let discovered = false;
  const outcome = await autoConfigureIfNeeded({ settings, discover: async () => { discovered = true; return { selected: null, found: [] }; }, save: () => {} });
  assert.equal(outcome.action, "skipped");
  assert.equal(discovered, false);

  const status = formatEngineStatus({ settings, configFile: "/x/config.json", configError: null });
  assert.match(status, /^Tiny implementer: claude-haiku-5-5 via Claude Code \(claude -p\)$/m);
  assert.match(status, /^ {2}provider: claude-code \(environment\)$/m);
  assert.equal(describeImplementer(settings), "claude-haiku-5-5 via Claude Code (claude -p)");
  assert.match(describeImplementerLocality(settings), /Anthropic/);

  const http = resolveEngineSettings({ env: {} });
  assert.equal(describeImplementer(http), "qwen2.5-coder-3b-instruct @ http://127.0.0.1:8080");
  assert.doesNotMatch(formatEngineStatus({ settings: http, configFile: "/x", configError: null }), /provider/);
});
