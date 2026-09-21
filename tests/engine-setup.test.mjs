import test from "node:test";
import assert from "node:assert/strict";
import {
  autoConfigureIfNeeded,
  configureFromSetupArgs,
  formatEngineStatus,
  parseSetupArgs
} from "../src/engine-setup.mjs";
import { resolveEngineSettings } from "../src/engine-config.mjs";

const llamaServer = {
  endpoint: "http://127.0.0.1:8080",
  label: "llama-server",
  reachable: true,
  models: ["qwen2.5-coder-3b-instruct"],
  model: "qwen2.5-coder-3b-instruct",
  note: null
};

function recorder() {
  const saved = [];
  return { saved, save: (patch) => { saved.push(patch); } };
}

test("does not touch an endpoint the user configured through env", async () => {
  const settings = resolveEngineSettings({ env: { PI_OFFLINE_TINY_ENDPOINT: "http://10.0.0.2:9000" }, config: {} });
  const { saved, save } = recorder();
  let probed = false;
  const result = await autoConfigureIfNeeded({
    settings,
    discover: async () => { probed = true; return { found: [], usable: [], selected: null }; },
    save
  });
  assert.equal(result.action, "skipped");
  assert.equal(probed, false, "an explicit configuration must not trigger network probes");
  assert.equal(saved.length, 0);
});

test("does not touch an endpoint persisted by an earlier setup", async () => {
  const settings = resolveEngineSettings({ env: {}, config: { endpoint: "http://127.0.0.1:1234" } });
  const { saved, save } = recorder();
  const result = await autoConfigureIfNeeded({
    settings,
    discover: async () => ({ found: [llamaServer], usable: [llamaServer], selected: llamaServer }),
    save
  });
  assert.equal(result.action, "skipped");
  assert.equal(saved.length, 0);
});

test("persists the discovered server on first run", async () => {
  const settings = resolveEngineSettings({ env: {}, config: {} });
  const { saved, save } = recorder();
  const result = await autoConfigureIfNeeded({
    settings,
    discover: async () => ({ found: [llamaServer], usable: [llamaServer], selected: llamaServer }),
    save,
    now: () => "2026-09-21T00:00:00.000Z"
  });

  assert.equal(result.action, "configured");
  assert.deepEqual(saved, [{
    endpoint: "http://127.0.0.1:8080",
    model: "qwen2.5-coder-3b-instruct",
    backend: "llama-server",
    configuredBy: "auto-discovery",
    configuredAt: "2026-09-21T00:00:00.000Z"
  }]);
  assert.match(result.message, /qwen2\.5-coder-3b-instruct @ http:\/\/127\.0\.0\.1:8080/);
  assert.match(result.message, /\/offline-doctor/);
});

test("explains what to start when no server is found, and saves nothing", async () => {
  const settings = resolveEngineSettings({ env: {}, config: {} });
  const { saved, save } = recorder();
  const result = await autoConfigureIfNeeded({
    settings,
    discover: async () => ({
      found: [{ endpoint: "http://127.0.0.1:8080", reachable: false, model: null }],
      usable: [],
      selected: null
    }),
    save
  });
  assert.equal(result.action, "not-found");
  assert.equal(saved.length, 0);
  assert.match(result.message, /llama-server/);
  assert.match(result.message, /\/offline-setup/);
});

test("says so when a server answers but only serves embedding models", async () => {
  const settings = resolveEngineSettings({ env: {}, config: {} });
  const lmStudio = {
    endpoint: "http://127.0.0.1:1234",
    label: "LM Studio",
    reachable: true,
    models: ["text-embedding-nomic-embed-text-v1.5"],
    model: null,
    note: "reachable, but no chat model is loaded"
  };
  const result = await autoConfigureIfNeeded({
    settings,
    discover: async () => ({ found: [lmStudio], usable: [], selected: null }),
    save: () => { throw new Error("must not save"); }
  });
  assert.equal(result.action, "not-found");
  assert.match(result.message, /LM Studio/);
  assert.match(result.message, /no chat model/);
});

test("a failing discovery is reported, not thrown into session startup", async () => {
  const settings = resolveEngineSettings({ env: {}, config: {} });
  const result = await autoConfigureIfNeeded({
    settings,
    discover: async () => { throw new Error("boom"); },
    save: () => {}
  });
  assert.equal(result.action, "error");
  assert.match(result.message, /boom/);
});

test("parses /offline-setup arguments", () => {
  assert.deepEqual(parseSetupArgs(""), { mode: "auto" });
  assert.deepEqual(parseSetupArgs("   "), { mode: "auto" });
  assert.deepEqual(parseSetupArgs("reset"), { mode: "reset" });
  assert.deepEqual(parseSetupArgs("http://127.0.0.1:9000"), { mode: "manual", endpoint: "http://127.0.0.1:9000", model: null });
  assert.deepEqual(parseSetupArgs("127.0.0.1:9000 my-model"), { mode: "manual", endpoint: "http://127.0.0.1:9000", model: "my-model" });
  assert.equal(parseSetupArgs("not a url at all ::").mode, "invalid");
});

test("manual setup verifies the endpoint before saving it", async () => {
  const { saved, save } = recorder();
  const down = await configureFromSetupArgs({
    request: { mode: "manual", endpoint: "http://127.0.0.1:9000", model: null },
    probe: async () => ({ endpoint: "http://127.0.0.1:9000", reachable: false, models: [], model: null, note: "not listening" }),
    save
  });
  assert.equal(down.ok, false);
  assert.match(down.message, /not listening/);
  assert.equal(saved.length, 0);

  const up = await configureFromSetupArgs({
    request: { mode: "manual", endpoint: "http://127.0.0.1:9000", model: "explicit-model" },
    probe: async () => ({ endpoint: "http://127.0.0.1:9000", reachable: true, models: ["other"], model: "other", note: null }),
    save,
    now: () => "t"
  });
  assert.equal(up.ok, true);
  assert.deepEqual(saved[0], {
    endpoint: "http://127.0.0.1:9000",
    model: "explicit-model",
    backend: "manual",
    configuredBy: "offline-setup",
    configuredAt: "t"
  });
});

test("status shows where each effective value came from", () => {
  const settings = resolveEngineSettings({
    env: { PI_OFFLINE_TINY_MODEL: "env-model" },
    config: { endpoint: "http://127.0.0.1:8080" }
  });
  const text = formatEngineStatus({ settings, configFile: "C:/cfg/config.json", configError: null });
  assert.match(text, /env-model @ http:\/\/127\.0\.0\.1:8080/);
  assert.match(text, /endpoint: config file/);
  assert.match(text, /model: environment/);
  assert.match(text, /C:\/cfg\/config\.json/);
});

test("status reports settings the engine applies to bundled companions", () => {
  // The engine writes PI_KNOWLEDGE_SEARCH_PROFILE into the environment of
  // another package; that must be visible, not silent.
  const settings = resolveEngineSettings({ env: {}, config: {} });
  const applied = formatEngineStatus({
    settings,
    configFile: "c.json",
    configError: null,
    companionEnv: [{ name: "PI_KNOWLEDGE_SEARCH_PROFILE", value: "low_token", source: "default" }]
  });
  assert.match(applied, /PI_KNOWLEDGE_SEARCH_PROFILE=low_token \(built-in default\)/);

  const chosen = formatEngineStatus({
    settings,
    configFile: "c.json",
    configError: null,
    companionEnv: [{ name: "PI_KNOWLEDGE_SEARCH_PROFILE", value: "precision", source: "env" }]
  });
  assert.match(chosen, /PI_KNOWLEDGE_SEARCH_PROFILE=precision \(environment\)/);

  assert.doesNotMatch(formatEngineStatus({ settings, configFile: "c.json", configError: null }), /Companion setting/);
});

test("status surfaces a broken config file", () => {
  const settings = resolveEngineSettings({ env: {}, config: {} });
  const text = formatEngineStatus({ settings, configFile: "x.json", configError: "invalid JSON in x.json" });
  assert.match(text, /invalid JSON in x\.json/);
});
