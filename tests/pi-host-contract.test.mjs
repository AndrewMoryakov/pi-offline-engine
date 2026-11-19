// Exercise Pi's real loadout and nested-call boundary without an LLM request.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

test("Pi keeps delegated execution model-facing but rejects nested invocation", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-offline-host-"));
  const agentDir = path.join(cwd, "agent");
  const savedEnv = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE_TINY_ENDPOINT = "http://127.0.0.1:9";
  process.env.PI_OFFLINE_REPO_CAPSULE = "0";
  let session;
  t.after(async () => {
    session?.dispose();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await fs.rm(cwd, { recursive: true, force: true });
  });

  let nested;
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../extensions/index.ts", import.meta.url))],
    extensionFactories: [(pi) => {
      pi.registerTool({
        name: "probe_nested_execution",
        label: "Probe nested execution",
        description: "Test the host's nested-call boundary.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
          nested = await ctx.executeTool("execute_delegated_implementation", {});
          return { content: [{ type: "text", text: "probe complete" }], details: {} };
        }
      });
    }]
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({
    cwd, agentDir, resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.inMemory(cwd)
  }));

  assert.ok(session.getActiveToolNames().includes("execute_delegated_implementation"));
  assert.ok(session.getActiveToolNames().includes("delegate_implementation"));
  assert.ok(session.getCallableToolNames().includes("delegate_implementation"), "candidate-only delegation remains composable");
  assert.equal(session.agent.state.tools.find((tool) => tool.name === "execute_delegated_implementation").executionMode, "sequential");

  const probe = session.agent.state.tools.find((tool) => tool.name === "probe_nested_execution");
  assert.ok(probe, "the real session must register the probe");
  session.agent.state.messages.push({ role: "assistant", content: [
    { type: "toolCall", id: "probe", name: "probe_nested_execution", arguments: {} }
  ] });
  await probe.execute("probe", {}, undefined, undefined);
  assert.equal(nested.isError, true);
  assert.match(nested.result.content[0].text, /not found|not callable|not available/i);
  assert.ok(!session.getCallableToolNames().includes("execute_delegated_implementation"));
});
