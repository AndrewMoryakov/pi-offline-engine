// Black-box characterization of the configuration-bound commands
// (/offline-status, /offline-setup, /offline-doctor) through the real
// entrypoint. The whole file uses ONE extension instance on purpose: the
// engine config is read when the entrypoint module is evaluated, and a
// config written by one instance must not be asserted through another.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createFakePi, createNormalizer, createUiRecorder, expectGolden, makeWorkspace, withEnv } from "./helpers/extension-harness.mjs";

const agentDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-offline-agent-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const name of [
  "PI_OFFLINE_TINY_ENDPOINT", "PI_OFFLINE_TINY_MODEL", "PI_OFFLINE_TINY_MAX_ATTEMPTS", "PI_OFFLINE_TINY_API_KEY",
  "OPENROUTER_API_KEY", "PI_OFFLINE_EDIT_PROVIDER", "PI_OFFLINE_SCRIPT_EDIT_POLICY", "PI_KNOWLEDGE_SEARCH_PROFILE"
]) delete process.env[name];

const configFile = path.join(agentDir, "pi-offline-engine", "config.json");
const { default: offlineEngine } = await import("../extensions/index.ts");

// Written after module evaluation but before the factory runs: the entrypoint
// keeps the snapshot it read at import time until its own next save/reload.
await fs.mkdir(path.dirname(configFile), { recursive: true });
await fs.writeFile(configFile, JSON.stringify({ model: "written-after-import", editProvider: "hybrid", scriptEditPolicy: "never" }));

const models = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") return res.end("{}");
  if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "fake-coder-1.5b" }] }));
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((resolve) => models.listen(0, "127.0.0.1", resolve));
const modelsEndpoint = `http://127.0.0.1:${models.address().port}`;
test.after(() => new Promise((resolve) => models.close(resolve)));

const cwd = await makeWorkspace();
const tools = ["read", "edit", "write", "bash", "execute_delegated_implementation", "delegate_implementation"].map((name) => ({ name }));
const fake = createFakePi({ allTools: tools, activeTools: tools.map((tool) => tool.name), exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
offlineEngine(fake.pi);
const recorder = createUiRecorder({ select: null });
const ctx = { cwd, hasUI: true, ui: recorder.ui, model: undefined };
const normalize = createNormalizer([[cwd, "<WS>"], [agentDir, "<AGENT>"], [modelsEndpoint, "<MODELS>"]]);

async function command(name, args) {
  const start = recorder.calls.length;
  await fake.commands[name].handler(args, ctx);
  return normalize(recorder.calls.slice(start));
}

test("/offline-status reports the import-time config snapshot and the companion default", async () => {
  const calls = await command("offline-status", "");
  await expectGolden("commands/status-import-snapshot", calls);
  assert.doesNotMatch(calls[0].message, /written-after-import/);
});

test("/offline-setup rejects malformed arguments", async () => {
  await expectGolden("commands/setup-invalid", await command("offline-setup", "a b c"));
});

test("/offline-setup manual endpoint probes, saves and runs the doctor", async () => {
  const calls = await command("offline-setup", modelsEndpoint);
  await expectGolden("commands/setup-manual", calls);
  const saved = JSON.parse(await fs.readFile(configFile, "utf8"));
  assert.equal(saved.endpoint, modelsEndpoint);
  assert.equal(saved.model, "fake-coder-1.5b");
  assert.equal(saved.editProvider, "hybrid", "unrelated persisted keys survive");
});

test("/offline-doctor keeps reporting the edit policy read at load after a config write", async () => {
  const calls = await command("offline-doctor", "");
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].message, /hybrid/i);
  await expectGolden("commands/doctor-after-write", calls);
});

test("/offline-status after a save reports the saved config", async () => {
  const calls = await command("offline-status", "");
  assert.match(calls[0].message, /fake-coder-1\.5b/);
  await expectGolden("commands/status-after-save", calls);
});

test("/offline-setup warns when the environment still overrides the saved config", async () => {
  await withEnv({ PI_OFFLINE_TINY_MODEL: "env-model" }, async () => {
    await expectGolden("commands/setup-env-override", await command("offline-setup", `${modelsEndpoint} chosen-model`));
  });
});

test("/offline-setup to an unreachable endpoint saves nothing", async () => {
  const before = await fs.readFile(configFile, "utf8");
  await expectGolden("commands/setup-unreachable", await command("offline-setup", "http://127.0.0.1:9"));
  assert.equal(await fs.readFile(configFile, "utf8"), before);
});

test("/offline-setup reset clears endpoint and model", async () => {
  await expectGolden("commands/setup-reset", await command("offline-setup", "reset"));
  const saved = JSON.parse(await fs.readFile(configFile, "utf8"));
  assert.equal(saved.endpoint, undefined);
  assert.equal(saved.model, undefined);
  assert.equal(saved.editProvider, "hybrid");
  await expectGolden("commands/status-after-reset", await command("offline-status", ""));
});
