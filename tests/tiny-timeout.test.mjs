import test from "node:test";
import assert from "node:assert/strict";
import { runDelegatedExecution } from "../src/delegation-execution-workflow.mjs";
import { runCandidateDelegation } from "../src/delegation-candidate-workflow.mjs";
import { fakeDotnet, makeWorkspace } from "./helpers/extension-harness.mjs";

const spec = {
  version: 1,
  spec_id: "timeout",
  operation: "modify_symbol",
  goal: { summary: "Return two." },
  target: { file: "src/A.cs", symbol: "A.Value" },
  requirements: ["Value returns 2."],
  scope: { allowed_files: ["src/A.cs"], allow_new_files: false, allow_dependencies: false, allow_public_api_change: false },
  verification: { build: { project: "src/A.csproj" } }
};

test("the configured request timeout reaches every TinyCoder call", async () => {
  const cwd = await makeWorkspace();
  const requests = [];
  const callTiny = async (request) => {
    requests.push(request);
    return { candidate: { status: "insufficient_spec", reason: "test" }, usage: {}, latencyMs: 1 };
  };
  const common = { spec, context: {}, cwd, signal: undefined, endpoint: "http://tiny", model: "tiny", callTiny, appendEvent: async () => {} };

  await runCandidateDelegation({ ...common, tinyTimeoutMs: 240_000 });
  await runDelegatedExecution({
    ...common, maxAttempts: 1, trainingRunId: null, exec: fakeDotnet(), withMutationQueues: async (_p, fn) => fn(), tinyTimeoutMs: 240_000
  });
  await runCandidateDelegation(common);

  assert.deepEqual(requests.map((r) => r.timeoutMs), [240_000, 240_000, undefined]);
});
