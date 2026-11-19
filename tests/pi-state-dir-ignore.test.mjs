// In a repository that does not list `.pi/offline-engine/` in its own
// .gitignore, whatever the Pi extension writes there must stay invisible to
// Git: `git status` must not show it and `git add .` must not stage it. The
// MCP server and the Claude Code hook already guarantee this (mcp-server and
// claude-code-hooks tests); these tests drive the same guarantee through the
// Pi entrypoint, one test per kind of state the Pi path writes. Git is real
// (`git init` in a temp directory); the Pi API, TinyCoder and dotnet are the
// fakes from the extension harness.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createFakePi,
  createUiRecorder,
  fakeDotnet,
  fakeTinyCoder,
  makeWorkspace,
  withEnv
} from "./helpers/extension-harness.mjs";

const agentDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-offline-agent-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const name of [
  "PI_OFFLINE_TINY_API_KEY", "OPENROUTER_API_KEY", "PI_OFFLINE_TRAINING_CAPTURE", "PI_OFFLINE_TINY_MAX_ATTEMPTS",
  "PI_OFFLINE_ALLOW_HEADLESS_APPLY", "PI_OFFLINE_COMPACT_TOOL_RESULTS", "PI_OFFLINE_TINY_ENDPOINT", "PI_OFFLINE_TINY_MODEL"
]) delete process.env[name];

const { default: offlineEngine } = await import("../extensions/index.ts");

// A user-level excludes file (core.excludesFile) that happens to ignore `.pi/`
// would hide the defect; an empty one makes the repository stand alone.
const emptyExcludes = path.join(agentDir, "empty-excludes");
await fs.writeFile(emptyExcludes, "");
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", `core.excludesFile=${emptyExcludes}`, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function repository(files) {
  const cwd = await makeWorkspace(files);
  git(cwd, "init", "-q");
  return cwd;
}

// What `git status` says about the engine's directory, one line per file.
const stateStatus = (cwd) => git(cwd, "status", "--porcelain", "--untracked-files=all", "--", ".pi");

// The probe `/offline-doctor` uses (src/offline-doctor.mjs).
function doctorProbeSaysIgnored(cwd) {
  try {
    git(cwd, "check-ignore", "-q", "--no-index", ".pi/offline-engine/probe");
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

const stateDirOf = (cwd) => path.join(cwd, ".pi", "offline-engine");

async function assertStateIsInvisible(cwd, expectedEntries) {
  const present = (await fs.readdir(stateDirOf(cwd))).filter((name) => name !== ".gitignore").sort();
  assert.deepEqual(present, [...expectedEntries].sort(), "the scenario must actually write state, or the test proves nothing");
  assert.equal(stateStatus(cwd), "", "git must not see anything under .pi");
  assert.equal(await fs.readFile(path.join(stateDirOf(cwd), ".gitignore"), "utf8"), "*\n");
  assert.equal(doctorProbeSaysIgnored(cwd), true);
}

async function loadExtension({ exec, env = {}, tinyEndpoint = "http://127.0.0.1:9" } = {}) {
  return withEnv({ PI_OFFLINE_TINY_ENDPOINT: tinyEndpoint, PI_OFFLINE_TINY_MODEL: "fake-tiny", ...env }, async () => {
    const fake = createFakePi({ exec });
    offlineEngine(fake.pi);
    return fake;
  });
}

const noisyBuild = Array.from({ length: 400 }, (_, i) => `  line ${i} of verbose dotnet output padding padding`).join("\n") +
  "\nsrc/A.cs(1,1): error CS0001: broken\nBuild FAILED.";

async function compactOneToolResult(cwd) {
  const fake = await loadExtension();
  const handler = fake.handlers.find((entry) => entry.event === "tool_result").handler;
  const compacted = await handler(
    { toolName: "bash", toolCallId: "tc-1", input: { command: "dotnet build src/A.csproj" }, content: [{ type: "text", text: noisyBuild }] },
    { cwd }
  );
  assert.ok(compacted, "the large dotnet output must be compacted so the full log is written");
}

const buildSpec = {
  version: 1,
  spec_id: "state-dir-ignore",
  operation: "modify_symbol",
  goal: { summary: "Return two instead of one." },
  target: { file: "src/A.cs", symbol: "A.Value" },
  requirements: ["Value returns 2."],
  scope: { allowed_files: ["src/A.cs"], allow_new_files: false, allow_dependencies: false, allow_public_api_change: false },
  verification: { build: { project: "src/A.csproj" }, tests: { project: "tests/ATests.csproj" } }
};
const ONE_TO_TWO = JSON.stringify({
  status: "candidate",
  changes: [{ path: "src/A.cs", operation: "replace_text", expected: "=> 1;", content: "=> 2;" }]
});

async function runTool(cwd, toolName, { env = {}, exec } = {}) {
  const tiny = await fakeTinyCoder([ONE_TO_TWO]);
  try {
    const fake = await loadExtension({ exec, env, tinyEndpoint: tiny.endpoint });
    const { ui } = createUiRecorder({ confirm: true });
    return await withEnv({ PI_OFFLINE_TINY_ENDPOINT: tiny.endpoint, PI_OFFLINE_TINY_MODEL: "fake-tiny", ...env }, () =>
      fake.tools[toolName].execute("call-1", { spec: buildSpec, context: { snippet: "class A { int Value() => 1; }" } }, undefined, () => {}, { cwd, hasUI: true, ui })
    );
  } finally {
    await tiny.close();
  }
}

test("compacting a tool result leaves a clean git status in a repository that does not ignore .pi", async () => {
  const cwd = await repository({});
  assert.equal(git(cwd, "status", "--porcelain"), "");
  await compactOneToolResult(cwd);
  assert.equal(git(cwd, "status", "--porcelain", "--untracked-files=all"), "");
  await assertStateIsInvisible(cwd, ["events.jsonl", "tool-results"]);
});

test("delegate_implementation (candidate only) leaves nothing visible to git", async () => {
  const cwd = await repository();
  const result = await runTool(cwd, "delegate_implementation");
  assert.equal(result.details.accepted, true);
  await assertStateIsInvisible(cwd, ["candidates", "events.jsonl"]);
});

test("execute_delegated_implementation with tests and training capture leaves nothing visible to git", async () => {
  const cwd = await repository();
  const result = await runTool(cwd, "execute_delegated_implementation", {
    env: { PI_OFFLINE_TRAINING_CAPTURE: "1" },
    exec: fakeDotnet()
  });
  assert.equal(result.details.success, true);
  await assertStateIsInvisible(cwd, ["artifacts", "candidates", "events.jsonl", "test-results", "training"]);
});

test("state left by an earlier version without a .gitignore is hidden by the next write", async () => {
  const cwd = await repository({});
  await fs.mkdir(stateDirOf(cwd), { recursive: true });
  await fs.writeFile(path.join(stateDirOf(cwd), "events.jsonl"), `${JSON.stringify({ type: "old" })}\n`);
  assert.match(stateStatus(cwd), /\.pi\/offline-engine\/events\.jsonl/, "precondition: the old state is visible to git");

  await compactOneToolResult(cwd);

  await assertStateIsInvisible(cwd, ["events.jsonl", "tool-results"]);
});

test("/offline-training export writes its dataset into a hidden directory", async () => {
  const cwd = await repository({});
  await fs.mkdir(path.join(stateDirOf(cwd), "training"), { recursive: true });
  await fs.writeFile(path.join(stateDirOf(cwd), "training", "raw.jsonl"), "");

  const fake = await loadExtension();
  const { ui } = createUiRecorder();
  await fake.commands["offline-training"].handler("export", { cwd, hasUI: true, ui });

  await assertStateIsInvisible(cwd, ["training"]);
  assert.ok((await fs.readdir(path.join(stateDirOf(cwd), "training", "export"))).length > 0);
});

test("a user's own .gitignore inside the state directory is left alone", async () => {
  const cwd = await repository({});
  await fs.mkdir(stateDirOf(cwd), { recursive: true });
  await fs.writeFile(path.join(stateDirOf(cwd), ".gitignore"), "*.log\n");

  await compactOneToolResult(cwd);

  assert.equal(await fs.readFile(path.join(stateDirOf(cwd), ".gitignore"), "utf8"), "*.log\n");
});
