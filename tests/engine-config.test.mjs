import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SETTINGS,
  engineConfigPath,
  readEngineConfig,
  resolveEngineSettings,
  writeEngineConfig
} from "../src/engine-config.mjs";

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-offline-config-"));
}

test("falls back to built-in defaults when nothing is configured", () => {
  const settings = resolveEngineSettings({ env: {}, config: {} });
  assert.equal(settings.endpoint, DEFAULT_SETTINGS.endpoint);
  assert.equal(settings.model, DEFAULT_SETTINGS.model);
  assert.equal(settings.maxAttempts, 3);
  assert.equal(settings.apiKey, null);
  assert.deepEqual(settings.sources, {
    endpoint: "default",
    model: "default",
    maxAttempts: "default",
    apiKey: "none"
  });
});

test("config file values override defaults", () => {
  const settings = resolveEngineSettings({
    env: {},
    config: { endpoint: "http://127.0.0.1:1234", model: "qwen-coder", maxAttempts: 2 }
  });
  assert.equal(settings.endpoint, "http://127.0.0.1:1234");
  assert.equal(settings.model, "qwen-coder");
  assert.equal(settings.maxAttempts, 2);
  assert.equal(settings.sources.endpoint, "config");
  assert.equal(settings.sources.model, "config");
});

test("environment always wins over the config file", () => {
  // Scripts, the acceptance harness and documented `export PI_OFFLINE_TINY_*`
  // workflows depend on env taking precedence over anything persisted.
  const settings = resolveEngineSettings({
    env: {
      PI_OFFLINE_TINY_ENDPOINT: "http://10.0.0.5:9000",
      PI_OFFLINE_TINY_MODEL: "env-model",
      PI_OFFLINE_TINY_MAX_ATTEMPTS: "1"
    },
    config: { endpoint: "http://127.0.0.1:1234", model: "config-model", maxAttempts: 3 }
  });
  assert.equal(settings.endpoint, "http://10.0.0.5:9000");
  assert.equal(settings.model, "env-model");
  assert.equal(settings.maxAttempts, 1);
  assert.equal(settings.sources.endpoint, "env");
  assert.equal(settings.sources.model, "env");
  assert.equal(settings.sources.maxAttempts, "env");
});

test("blank env and config values are treated as unset", () => {
  const settings = resolveEngineSettings({
    env: { PI_OFFLINE_TINY_ENDPOINT: "  ", PI_OFFLINE_TINY_MODEL: "" },
    config: { endpoint: "", model: "config-model" }
  });
  assert.equal(settings.sources.endpoint, "default");
  assert.equal(settings.model, "config-model");
});

test("clamps attempts to the supported 1..3 range and ignores garbage", () => {
  assert.equal(resolveEngineSettings({ env: { PI_OFFLINE_TINY_MAX_ATTEMPTS: "9" }, config: {} }).maxAttempts, 3);
  assert.equal(resolveEngineSettings({ env: { PI_OFFLINE_TINY_MAX_ATTEMPTS: "0" }, config: {} }).maxAttempts, 1);
  const garbage = resolveEngineSettings({ env: { PI_OFFLINE_TINY_MAX_ATTEMPTS: "lots" }, config: {} });
  assert.equal(garbage.maxAttempts, 3);
  assert.equal(garbage.sources.maxAttempts, "default");
});

test("api keys come only from the environment, never from the config file", () => {
  const fromConfig = resolveEngineSettings({ env: {}, config: { apiKey: "sk-or-v1-should-not-load" } });
  assert.equal(fromConfig.apiKey, null);

  const fromEnv = resolveEngineSettings({ env: { OPENROUTER_API_KEY: " sk-or-v1-abc " }, config: {} });
  assert.equal(fromEnv.apiKey, "sk-or-v1-abc");
  assert.equal(fromEnv.sources.apiKey, "env");

  const preferred = resolveEngineSettings({
    env: { PI_OFFLINE_TINY_API_KEY: "sk-primary", OPENROUTER_API_KEY: "sk-secondary" },
    config: {}
  });
  assert.equal(preferred.apiKey, "sk-primary");
});

test("stores the config under the pi agent directory", () => {
  assert.equal(
    engineConfigPath("/home/u/.pi/agent"),
    path.join("/home/u/.pi/agent", "pi-offline-engine", "config.json")
  );
});

test("reads a missing config file as empty rather than failing", () => {
  const file = path.join(scratchDir(), "absent", "config.json");
  assert.deepEqual(readEngineConfig(file), { config: {}, error: null });
});

test("reports a malformed config file without throwing", () => {
  const dir = scratchDir();
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, "{ not json", "utf8");
  const result = readEngineConfig(file);
  assert.deepEqual(result.config, {});
  assert.match(result.error, /config\.json/);
});

test("rejects a config file whose top level is not an object", () => {
  const dir = scratchDir();
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, "[1,2]", "utf8");
  const result = readEngineConfig(file);
  assert.deepEqual(result.config, {});
  assert.match(result.error, /object/);
});

test("writes a merged config and never persists an api key", () => {
  const file = path.join(scratchDir(), "nested", "config.json");
  writeEngineConfig(file, { endpoint: "http://127.0.0.1:8080", model: "a" });
  writeEngineConfig(file, { model: "b", apiKey: "sk-or-v1-leak" });

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.endpoint, "http://127.0.0.1:8080");
  assert.equal(saved.model, "b");
  assert.equal("apiKey" in saved, false);
  assert.equal(fs.readFileSync(file, "utf8").includes("sk-or-v1-leak"), false);
});

test("writing null removes a key so the next layer shows through", () => {
  const file = path.join(scratchDir(), "config.json");
  writeEngineConfig(file, { endpoint: "http://127.0.0.1:8080", model: "a" });
  writeEngineConfig(file, { endpoint: null, model: null });
  assert.deepEqual(readEngineConfig(file).config, {});
});
