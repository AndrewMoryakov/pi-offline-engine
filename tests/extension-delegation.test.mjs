// Black-box characterization of the two delegation tools as registered by the
// extension entrypoint. The entrypoint is loaded through Node's type stripping
// with a recording fake Pi API, a fake TinyCoder HTTP endpoint and a fake
// `dotnet` behind pi.exec. Every row of the bounded-execution transition matrix
// (docs/INDEX_REFACTOR_SPEC.md section 8) is driven end to end, and the
// complete tool result, event ledger, training trace, candidate records,
// TinyCoder requests, exec calls, UI calls and final workspace are compared
// with committed goldens in tests/golden/.

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
  fakeDotnet,
  fakeTinyCoder,
  makeWorkspace,
  readEngineArtifacts,
  trxDocument,
  withEnv
} from "./helpers/extension-harness.mjs";

const agentDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-offline-agent-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const name of [
  "PI_OFFLINE_TINY_API_KEY", "OPENROUTER_API_KEY", "PI_OFFLINE_TRAINING_CAPTURE", "PI_OFFLINE_TINY_MAX_ATTEMPTS",
  "PI_OFFLINE_ALLOW_HEADLESS_APPLY", "PI_OFFLINE_TINY_ENDPOINT", "PI_OFFLINE_TINY_MODEL"
]) delete process.env[name];

const { default: offlineEngine } = await import("../extensions/index.ts");

const buildSpec = {
  version: 1,
  spec_id: "characterize-build",
  operation: "modify_symbol",
  goal: { summary: "Return two instead of one." },
  target: { file: "src/A.cs", symbol: "A.Value" },
  requirements: ["Value returns 2."],
  scope: { allowed_files: ["src/A.cs"], allow_new_files: false, allow_dependencies: false, allow_public_api_change: false },
  verification: { build: { project: "src/A.csproj" } }
};

const testSpec = {
  ...buildSpec,
  spec_id: "characterize-tests",
  verification: { build: { project: "src/A.csproj" }, tests: { project: "tests/ATests.csproj" } }
};

const sensitiveSpec = {
  ...buildSpec,
  spec_id: "characterize-sensitive",
  target: { file: "src/secrets.cs", symbol: "S" },
  scope: { ...buildSpec.scope, allowed_files: ["src/secrets.cs"] }
};

const candidate = (expected, content, file = "src/A.cs") => JSON.stringify({
  status: "candidate",
  changes: [{ path: file, operation: "replace_text", expected, content }]
});
const ONE_TO_TWO = candidate("=> 1;", "=> 2;");
const TWO_TO_THREE = candidate("=> 2;", "=> 3;");
const OUT_OF_SCOPE = candidate("=> 1;", "=> 2;", "src/B.cs");
const MISSING_EXPECTED = candidate("=> 42;", "=> 43;");
const INSUFFICIENT = JSON.stringify({ status: "insufficient_spec", reason: "needs the class body" });
const CANNOT = JSON.stringify({ status: "cannot_safely_implement", reason: "public API would change" });
const MALFORMED = "no json here";
const RED_BUILD = { code: 1, stdout: "src/A.cs(1,20): error CS1002: ; expected\nBuild FAILED." };

async function runTool(toolName, {
  replies = [INSUFFICIENT],
  dotnet = {},
  spec = buildSpec,
  context = { snippet: "class A { int Value() => 1; }" },
  env = {},
  factoryEnv = {},
  hasUI = true,
  confirm = true,
  onUpdate,
  setup
} = {}) {
  const tiny = await fakeTinyCoder(replies);
  const cwd = await makeWorkspace();
  if (setup) await setup(cwd);
  try {
    const fake = await withEnv({ PI_OFFLINE_TINY_ENDPOINT: tiny.endpoint, PI_OFFLINE_TINY_MODEL: "fake-tiny", ...factoryEnv }, async () => {
      const created = createFakePi({ exec: fakeDotnet(dotnet) });
      offlineEngine(created.pi);
      return created;
    });
    const recorder = createUiRecorder({ confirm });
    const updates = [];
    const ctx = { cwd, hasUI, ui: recorder.ui };
    let result;
    let error;
    await withEnv({ PI_OFFLINE_TINY_ENDPOINT: tiny.endpoint, PI_OFFLINE_TINY_MODEL: "fake-tiny", ...env }, async () => {
      try {
        result = await fake.tools[toolName].execute(
          "call-1",
          { spec, context },
          undefined,
          onUpdate ?? ((update) => updates.push(update)),
          ctx
        );
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    });
    const artifacts = await readEngineArtifacts(cwd);
    const workspace = {};
    for (const file of spec.scope.allowed_files) {
      try {
        workspace[file] = await fs.readFile(path.join(cwd, file), "utf8");
      } catch (caught) {
        workspace[file] = caught?.code ?? String(caught);
      }
    }
    const normalize = createNormalizer([[cwd, "<WS>"], [agentDir, "<AGENT>"], [tiny.endpoint, "<TINY>"]]);
    const observed = normalize({
      result: result === undefined ? null : {
        ...result,
        content: result.content?.map((part) => {
          try {
            return { ...part, text: JSON.parse(part.text) };
          } catch {
            return part;
          }
        })
      },
      error: error ?? null,
      events: artifacts.events,
      training: artifacts.training,
      candidates: artifacts.candidates,
      tinyRequests: tiny.requests.map((request) => ({
        model: request.model,
        temperature: request.temperature,
        responseFormat: request.response_format?.type,
        user: JSON.parse(request.messages[1].content)
      })),
      exec: fake.execCalls,
      ui: recorder.calls,
      updates,
      workspace
    });
    return { observed, rawResult: result, error, tiny };
  } finally {
    await tiny.close();
  }
}

async function characterize(name, toolName, options) {
  const run = await runTool(toolName, options);
  await expectGolden(`delegation/${name}`, run.observed);
  return run;
}

const execute = (name, options) => characterize(`execute-${name}`, "execute_delegated_implementation", options);
const candidateOnly = (name, options) => characterize(`candidate-${name}`, "delegate_implementation", options);

// --- execute_delegated_implementation: before mutation ---------------------

test("execute: rejected spec throws before any work", async () => {
  const run = await execute("spec-rejected", { spec: { ...buildSpec, operation: "rewrite_everything" } });
  assert.match(run.error, /^ImplementationSpec rejected: /);
  assert.equal(run.tiny.requests.length, 0);
});

test("execute: headless refusal performs no preflight or model call", async () => {
  const run = await execute("headless-refused", { hasUI: false });
  assert.match(run.error, /requires interactive confirmation/);
  assert.equal(run.tiny.requests.length, 0);
  assert.deepEqual(run.observed.exec, []);
});

test("execute: headless override proceeds without confirmation", async () => {
  const run = await execute("headless-allowed", { hasUI: false, env: { PI_OFFLINE_ALLOW_HEADLESS_APPLY: "1" }, replies: [ONE_TO_TWO] });
  assert.equal(run.rawResult.details.success, true);
  assert.deepEqual(run.observed.ui, []);
});

test("execute: user cancellation performs no preflight or model call", async () => {
  const run = await execute("user-cancelled", { confirm: false });
  assert.deepEqual(run.rawResult, { content: [{ type: "text", text: "Delegated implementation cancelled by user." }], details: { cancelled: true } });
  assert.equal(run.tiny.requests.length, 0);
  assert.deepEqual(run.observed.exec, []);
});

test("execute: sensitive-path training skip is recorded even when the run is then refused", async () => {
  await execute("sensitive-headless-refused", { spec: sensitiveSpec, hasUI: false, factoryEnv: { PI_OFFLINE_TRAINING_CAPTURE: "1" } });
});

test("execute: sensitive-path training skip is recorded even when the user cancels", async () => {
  await execute("sensitive-user-cancelled", { spec: sensitiveSpec, confirm: false, factoryEnv: { PI_OFFLINE_TRAINING_CAPTURE: "1" } });
});

test("execute: verification preflight failure is infrastructure at attempt 0", async () => {
  const run = await execute("preflight-failure", {
    spec: testSpec,
    dotnet: { help: { code: 1, stdout: "", stderr: "SDK missing" } },
    factoryEnv: { PI_OFFLINE_TRAINING_CAPTURE: "1" }
  });
  assert.equal(run.tiny.requests.length, 0);
  assert.equal(run.rawResult.details.reason, "verification_infrastructure_failure");
  assert.equal("usage" in run.rawResult, false);
});

test("execute: snapshot failure is a runtime failure before any model call", async () => {
  const run = await execute("snapshot-failure", {
    setup: async (cwd) => {
      await fs.rm(path.join(cwd, "src", "A.cs"));
      await fs.mkdir(path.join(cwd, "src", "A.cs"));
    }
  });
  assert.equal(run.tiny.requests.length, 0);
  assert.equal(run.rawResult.details.reason, "delegated_runtime_failure");
});

test("execute: transport failure is not retried", async () => {
  const run = await execute("transport-failure", {
    replies: [{ status: 500, body: "boom" }],
    factoryEnv: { PI_OFFLINE_TRAINING_CAPTURE: "1" }
  });
  assert.equal(run.tiny.requests.length, 1);
  assert.equal(run.rawResult.details.reason, "tiny_transport_failure");
  assert.equal("usage" in run.rawResult, true);
  assert.equal(run.rawResult.usage, undefined);
});

// --- model-output retry ------------------------------------------------------

test("execute: malformed output is retried, then a valid candidate passes", async () => {
  const run = await execute("malformed-then-pass", { replies: [MALFORMED, ONE_TO_TWO] });
  assert.equal(run.tiny.requests.length, 2);
  assert.equal(run.rawResult.details.success, true);
});

test("execute: malformed output on every attempt escalates", async () => {
  const run = await execute("malformed-exhausted", { replies: [MALFORMED] });
  assert.equal(run.tiny.requests.length, 3);
  assert.equal(run.rawResult.details.reason, "tiny_invalid_output");
});

test("execute: invalid candidate is retried, then a valid candidate passes", async () => {
  const run = await execute("invalid-candidate-then-pass", {
    replies: [OUT_OF_SCOPE, ONE_TO_TWO],
    factoryEnv: { PI_OFFLINE_TRAINING_CAPTURE: "1" }
  });
  assert.equal(run.rawResult.details.success, true);
});

test("execute: invalid candidate on every attempt escalates", async () => {
  const run = await execute("invalid-candidate-exhausted", { replies: [OUT_OF_SCOPE], env: { PI_OFFLINE_TINY_MAX_ATTEMPTS: "2" } });
  assert.equal(run.tiny.requests.length, 2);
  assert.equal(run.rawResult.details.reason, "tiny_invalid_candidate");
});

test("execute: malformed output after red verification keeps the verification RepairPacket", async () => {
  const run = await execute("red-then-malformed-exhausted", {
    replies: [ONE_TO_TWO, MALFORMED],
    dotnet: { build: [RED_BUILD] }
  });
  const third = run.observed.tinyRequests[2].user.repair_packet;
  assert.equal(third.kind, "model_output_failure");
  assert.ok(third.prior_repair_packet.verification, "verification RepairPacket retained");
  assert.equal(third.prior_repair_packet.repair_attempt, 1);
  assert.equal(run.rawResult.details.workspaceModified, true);
});

test("execute: invalid candidate after red verification keeps prior mutations", async () => {
  await execute("red-then-invalid-candidate-exhausted", {
    replies: [ONE_TO_TWO, OUT_OF_SCOPE],
    dotnet: { build: [RED_BUILD] },
    env: { PI_OFFLINE_TINY_MAX_ATTEMPTS: "2" }
  });
});

// --- terminal status ---------------------------------------------------------

test("execute: terminal status before mutation", async () => {
  const run = await execute("terminal-before-mutation", { replies: [INSUFFICIENT], factoryEnv: { PI_OFFLINE_TRAINING_CAPTURE: "1" } });
  assert.equal(run.rawResult.details.escalated, false);
});

test("execute: terminal status after mutation escalates", async () => {
  const run = await execute("terminal-after-mutation", { replies: [ONE_TO_TWO, CANNOT], dotnet: { build: [RED_BUILD] } });
  assert.equal(run.rawResult.details.escalated, true);
});

// --- apply and verification failures -----------------------------------------

test("execute: apply failure with no prior apply reports uncertain workspace", async () => {
  const run = await execute("apply-failure", { replies: [MISSING_EXPECTED], factoryEnv: { PI_OFFLINE_TRAINING_CAPTURE: "1" } });
  assert.equal(run.rawResult.details.reason, "candidate_apply_failure");
  assert.equal(run.rawResult.details.workspaceStateUncertain, true);
});

test("execute: apply failure after a prior apply is not uncertain", async () => {
  const run = await execute("apply-failure-after-apply", { replies: [ONE_TO_TWO, MISSING_EXPECTED], dotnet: { build: [RED_BUILD] } });
  assert.equal(run.rawResult.details.workspaceStateUncertain, false);
});

test("execute: candidate record failure is a runtime failure", async () => {
  const run = await execute("candidate-record-failure", {
    replies: [ONE_TO_TWO],
    setup: async (cwd) => {
      await fs.mkdir(path.join(cwd, ".pi", "offline-engine"), { recursive: true });
      await fs.writeFile(path.join(cwd, ".pi", "offline-engine", "candidates"), "not a directory");
    }
  });
  assert.equal(run.rawResult.details.stage, "candidate_record");
});

test("execute: verification execution failure keeps applied files reported", async () => {
  const run = await execute("verification-throws", { replies: [ONE_TO_TWO], dotnet: { build: ["throw"] } });
  assert.equal(run.rawResult.details.reason, "verification_execution_failure");
});

// --- verification outcomes ---------------------------------------------------

test("execute: verification passes on the first attempt with build and TRX tests", async () => {
  const run = await execute("verification-pass-tests", {
    spec: testSpec,
    replies: [ONE_TO_TWO],
    factoryEnv: { PI_OFFLINE_TRAINING_CAPTURE: "1" }
  });
  assert.equal(run.rawResult.details.taskComplete, false);
});

test("execute: red verification, repair, then pass", async () => {
  const run = await execute("red-repair-pass", {
    spec: testSpec,
    replies: [ONE_TO_TWO, TWO_TO_THREE],
    dotnet: { build: [RED_BUILD, { code: 0 }] }
  });
  assert.equal(run.rawResult.details.success, true);
  assert.equal(run.rawResult.usage.input, 101 + 102);
});

test("execute: passing tests without TRX evidence fail verification", async () => {
  await execute("tests-without-trx", {
    spec: testSpec,
    replies: [ONE_TO_TWO],
    dotnet: { test: [{ code: 0 }] },
    env: { PI_OFFLINE_TINY_MAX_ATTEMPTS: "1" }
  });
});

test("execute: exhausted red verifications return cumulative state", async () => {
  const run = await execute("verification-exhausted", {
    replies: [ONE_TO_TWO, TWO_TO_THREE, candidate("=> 3;", "=> 4;")],
    dotnet: { build: [RED_BUILD] },
    factoryEnv: { PI_OFFLINE_TRAINING_CAPTURE: "1" }
  });
  assert.equal(run.tiny.requests.length, 3);
  assert.equal(JSON.parse(run.rawResult.content[0].text).attempts, 3);
});

// --- edge paths that must survive extraction ---------------------------------

test("execute: onUpdate failure is classified by the stage carried from before the loop", async () => {
  const run = await execute("on-update-throws", {
    onUpdate: () => { throw new Error("presentation failed"); }
  });
  assert.equal(run.rawResult.details.reason, "verification_infrastructure_failure");
  assert.equal(run.tiny.requests.length, 0);
});

test("execute: an unwritable event ledger rejects with the raw filesystem error", async () => {
  const run = await execute("event-ledger-unwritable", {
    setup: async (cwd) => {
      await fs.mkdir(path.join(cwd, ".pi", "offline-engine", "events.jsonl"), { recursive: true });
    }
  });
  assert.ok(run.error, "tool rejects");
  assert.equal(run.rawResult, undefined);
});

// --- delegate_implementation (candidate only) --------------------------------

test("candidate: rejected spec returns a result without work", async () => {
  const run = await candidateOnly("spec-rejected", { spec: { ...buildSpec, scope: { ...buildSpec.scope, allowed_files: [] } } });
  assert.equal(run.tiny.requests.length, 0);
});

test("candidate: valid candidate is persisted but never applied", async () => {
  const run = await candidateOnly("accepted", { replies: [ONE_TO_TWO] });
  assert.equal(run.observed.workspace["src/A.cs"], "class A { int Value() => 1; }\n");
  assert.equal(Object.keys(run.observed.candidates).length, 1);
});

test("candidate: terminal response is returned unchanged and not persisted", async () => {
  const run = await candidateOnly("terminal", { replies: [INSUFFICIENT] });
  assert.deepEqual(run.observed.candidates, {});
});

test("candidate: invalid candidate returns errors, details and usage", async () => {
  await candidateOnly("invalid", { replies: [OUT_OF_SCOPE] });
});

test("candidate: transport failure emits tiny_failed and throws", async () => {
  const run = await candidateOnly("transport-failure", { replies: [{ status: 500, body: "boom" }] });
  assert.match(run.error, /^Tiny implementer failed: tiny endpoint HTTP 500/);
});

test("candidate: malformed output emits tiny_failed and throws", async () => {
  const run = await candidateOnly("malformed", { replies: [MALFORMED] });
  assert.match(run.error, /^Tiny implementer failed: /);
});

test("candidate: candidate record failure surfaces as tiny_failed", async () => {
  await candidateOnly("record-failure", {
    replies: [ONE_TO_TWO],
    setup: async (cwd) => {
      await fs.mkdir(path.join(cwd, ".pi", "offline-engine"), { recursive: true });
      await fs.writeFile(path.join(cwd, ".pi", "offline-engine", "candidates"), "not a directory");
    }
  });
});

test("candidate: snapshot failure propagates raw", async () => {
  const run = await candidateOnly("snapshot-failure", {
    setup: async (cwd) => {
      await fs.rm(path.join(cwd, "src", "A.cs"));
      await fs.mkdir(path.join(cwd, "src", "A.cs"));
    }
  });
  assert.match(run.error, /allowed path is not a regular file/);
});

test("TRX fixture helper produces a positive executed count", () => {
  assert.match(trxDocument(), /executed="1"/);
});
