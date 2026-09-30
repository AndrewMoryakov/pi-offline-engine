// Behavioral contract of the extension entrypoint. These replace the former
// source-text (regex) assertions over extensions/index.ts: each guarantee is
// now exercised through the registered tools and commands with a fake Pi API,
// a fake TinyCoder endpoint and a fake dotnet. Registration surface details
// live in extension-registration; full transition goldens in
// extension-delegation.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createFakePi,
  createUiRecorder,
  fakeDotnet,
  fakeTinyCoder,
  makeWorkspace,
  readEngineArtifacts,
  withEnv
} from "./helpers/extension-harness.mjs";

const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-offline-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const name of [
  "PI_OFFLINE_TINY_API_KEY", "OPENROUTER_API_KEY", "PI_OFFLINE_TRAINING_CAPTURE", "PI_OFFLINE_TINY_MAX_ATTEMPTS",
  "PI_OFFLINE_ALLOW_HEADLESS_APPLY"
]) delete process.env[name];

const { default: offlineEngine } = await import("../extensions/index.ts");

const spec = {
  version: 1,
  spec_id: "contract",
  operation: "modify_symbol",
  goal: { summary: "Return two." },
  target: { file: "src/A.cs", symbol: "A.Value" },
  requirements: ["Value returns 2."],
  scope: { allowed_files: ["src/A.cs"], allow_new_files: false, allow_dependencies: false, allow_public_api_change: false },
  verification: { build: { project: "src/A.csproj" }, tests: { project: "tests/ATests.csproj" } }
};
const GOOD = JSON.stringify({ status: "candidate", changes: [{ path: "src/A.cs", operation: "replace_text", expected: "=> 1;", content: "=> 2;" }] });

async function run({ replies = [GOOD], dotnet = {}, factoryEnv = {}, setup, beforeExecute } = {}) {
  const tiny = await fakeTinyCoder(replies);
  const cwd = await makeWorkspace();
  if (setup) await setup(cwd);
  try {
    return await withEnv({ PI_OFFLINE_TINY_ENDPOINT: tiny.endpoint, PI_OFFLINE_TINY_MODEL: "fake-tiny", ...factoryEnv }, async () => {
      const fake = createFakePi({ exec: fakeDotnet(dotnet) });
      offlineEngine(fake.pi);
      const recorder = createUiRecorder();
      const ctx = { cwd, hasUI: true, ui: recorder.ui };
      if (beforeExecute) await beforeExecute(fake, ctx);
      const result = await fake.tools.execute_delegated_implementation.execute("c", { spec, context: {} }, undefined, () => {}, ctx);
      return { result, fake, tiny, cwd, artifacts: await readEngineArtifacts(cwd) };
    });
  } finally {
    await tiny.close();
  }
}

test("mechanical verification is not presented as semantic task completion", async () => {
  const { result } = await run();
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, "verification_passed");
  assert.equal(body.task_complete, false);
  assert.equal(result.details.taskComplete, false);
  assert.notEqual(body.status, "verified");
});

test("TinyCoder nested usage is returned to Pi session accounting", async () => {
  const { result } = await run({
    replies: [GOOD, JSON.stringify({ status: "candidate", changes: [{ path: "src/A.cs", operation: "replace_text", expected: "=> 2;", content: "=> 3;" }] })],
    dotnet: { build: [{ code: 1, stdout: "error CS1002" }, { code: 0 }] }
  });
  assert.deepEqual(result.usage, {
    input: 101 + 102,
    output: 11 + 12,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 112 + 114,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  });
});

test("delegated execution preflights verification before TinyCoder", async () => {
  const { result, tiny, fake } = await run({ dotnet: { help: { code: 1 } } });
  assert.equal(result.details.reason, "verification_infrastructure_failure");
  assert.equal(tiny.requests.length, 0);
  assert.deepEqual(fake.execCalls.map((call) => call.args.slice(0, 2)), [["test", "--help"]]);
});

test("verification keeps --no-restore and build failure prevents the test step", async () => {
  const { fake } = await run({ dotnet: { build: [{ code: 1, stdout: "error CS1002" }] }, factoryEnv: { PI_OFFLINE_TINY_MAX_ATTEMPTS: "1" } });
  const steps = fake.execCalls.map((call) => call.args[0] + (call.args[1] === "--help" ? " --help" : ""));
  assert.deepEqual(steps, ["test --help", "build"]);
  assert.ok(fake.execCalls[1].args.includes("--no-restore"));
});

test("training capture is opt-in and exposes explicit controls", async () => {
  const off = await run();
  assert.equal(off.artifacts.training, null, "no capture by default");

  const on = await run({ factoryEnv: { PI_OFFLINE_TRAINING_CAPTURE: "1" } });
  assert.equal(on.artifacts.training.length, 1);

  const byCommand = await run({
    beforeExecute: (fake, ctx) => fake.commands["offline-training"].handler("on", ctx)
  });
  assert.equal(byCommand.artifacts.training.length, 1);

  const disabled = await run({
    factoryEnv: { PI_OFFLINE_TRAINING_CAPTURE: "1" },
    beforeExecute: (fake, ctx) => fake.commands["offline-training"].handler("off", ctx)
  });
  assert.equal(disabled.artifacts.training, null);
});

test("training recording is best-effort and not a coding-state authority", async () => {
  const { result, artifacts } = await run({
    factoryEnv: { PI_OFFLINE_TRAINING_CAPTURE: "1" },
    setup: async (cwd) => {
      // A directory where the raw trace should be makes every append fail.
      await fs.mkdir(path.join(cwd, ".pi", "offline-engine", "training", "raw.jsonl"), { recursive: true });
    }
  });
  assert.equal(result.details.success, true);
  assert.ok(artifacts.events.some((event) => event.type === "training_capture_failed"));
});
