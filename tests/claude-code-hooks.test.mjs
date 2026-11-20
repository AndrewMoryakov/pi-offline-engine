import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeExec } from "../src/node-exec.mjs";

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "claude-code", "hooks");

function runHook(file, payload, env = {}) {
  const result = spawnSync(process.execPath, [path.join(HOOKS, file)], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function bashPayload(cwd, command, stdout) {
  return {
    hook_event_name: "PostToolUse",
    cwd,
    tool_name: "Bash",
    tool_use_id: "toolu_test_1",
    tool_input: { command },
    tool_response: { stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false }
  };
}

const bigBuildLog = [
  ...Array.from({ length: 400 }, (_, i) => `  Restored project ${i} and did unrelated verbose work`),
  "src/A.cs(12,5): error CS0103: The name 'x' does not exist in the current context",
  "Build FAILED."
].join("\n");

test("large direct dotnet build output is replaced in tool_response shape", () => {
  const cwd = tempDir("pi-offline-hook-");
  const result = runHook("compact-dotnet-output.mjs", bashPayload(cwd, "dotnet build src/A.csproj", bigBuildLog));
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  const updated = output.hookSpecificOutput.updatedToolOutput;
  assert.equal(typeof updated, "object");
  assert.equal(updated.interrupted, false);
  assert.equal(updated.isImage, false);
  assert.equal(updated.stderr, "");
  assert.match(updated.stdout, /compacted dotnet tool output/);
  assert.match(updated.stdout, /error CS0103/);
  assert.ok(updated.stdout.length < bigBuildLog.length / 4);

  const stateDir = path.join(cwd, ".pi", "offline-engine");
  assert.equal(fs.readFileSync(path.join(stateDir, ".gitignore"), "utf8"), "*\n");
  assert.match(fs.readFileSync(path.join(stateDir, "tool-results", "toolu_test_1.log"), "utf8"), /Restored project 399/);
});

test("PowerShell results are compacted by the same rules", () => {
  const cwd = tempDir("pi-offline-hook-");
  const payload = { ...bashPayload(cwd, "dotnet test tests/T.csproj 2>&1", bigBuildLog), tool_name: "PowerShell" };
  const result = runHook("compact-dotnet-output.mjs", payload);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.updatedToolOutput.stdout, /compacted dotnet tool output/);
});

test("small, composite, non-dotnet or disabled results are left alone", () => {
  const cwd = tempDir("pi-offline-hook-");
  const cases = [
    [bashPayload(cwd, "dotnet build", "Build succeeded."), {}],
    [bashPayload(cwd, "dotnet build | tee log.txt", bigBuildLog), {}],
    [bashPayload(cwd, "cat build.log", bigBuildLog), {}],
    [bashPayload(cwd, "dotnet build", bigBuildLog), { PI_OFFLINE_COMPACT_TOOL_RESULTS: "0" }],
    [{ ...bashPayload(cwd, "dotnet build", bigBuildLog), tool_name: "Read" }, {}]
  ];
  for (const [payload, env] of cases) {
    const result = runHook("compact-dotnet-output.mjs", payload, env);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "", payload.tool_input.command);
  }
  assert.equal(fs.existsSync(path.join(cwd, ".pi")), false);
});

test("hooks exit 0 silently on malformed input", () => {
  for (const file of ["compact-dotnet-output.mjs", "repo-capsule.mjs"]) {
    const result = runHook(file, "{not json");
    assert.equal(result.status, 0, file);
    assert.equal(result.stdout, "", file);
  }
});

test("session start adds the repository snapshot inside a git work tree", () => {
  const cwd = tempDir("pi-offline-capsule-");
  const git = (...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "-b", "trunk");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(cwd, "App.csproj"), "<Project />\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  const result = runHook("repo-capsule.mjs", { hook_event_name: "SessionStart", cwd });
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, /Branch: trunk/);
  assert.match(output.hookSpecificOutput.additionalContext, /App\.csproj/);

  assert.equal(runHook("repo-capsule.mjs", { cwd }, { PI_OFFLINE_REPO_CAPSULE: "0" }).stdout, "");
});

test("session start prints nothing outside a git work tree", () => {
  const result = runHook("repo-capsule.mjs", { cwd: tempDir("pi-offline-nogit-") }, { GIT_CEILING_DIRECTORIES: os.tmpdir() });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("nodeExec matches the pi.exec result contract", async () => {
  const ok = await nodeExec(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"]);
  assert.deepEqual(ok, { stdout: "out", stderr: "err", code: 3, killed: false });

  const slow = await nodeExec(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { timeout: 200 });
  assert.equal(slow.killed, true);

  const missing = await nodeExec("definitely-not-a-command-pi-offline", []);
  assert.equal(missing.code, 1);
  assert.equal(missing.killed, false);
});

test("a persisted large result is compacted from the full file and loses its persisted keys", () => {
  const cwd = tempDir("pi-offline-hook-");
  const persisted = path.join(cwd, "persisted-output.txt");
  const fullLog = bigBuildLog + "\nsrc/B.cs(3,1): error CS1513: } expected\n";
  fs.writeFileSync(persisted, fullLog);
  // Claude Code cuts stdout and keeps the full text in the persisted file.
  const payload = bashPayload(cwd, "dotnet build -v d", fullLog.slice(0, 2000));
  payload.tool_response.persistedOutputPath = persisted;
  payload.tool_response.persistedOutputSize = fullLog.length;

  const updated = JSON.parse(runHook("compact-dotnet-output.mjs", payload).stdout).hookSpecificOutput.updatedToolOutput;
  assert.equal("persistedOutputPath" in updated, false);
  assert.equal("persistedOutputSize" in updated, false);
  assert.match(updated.stdout, /error CS1513/);
  assert.equal(updated.interrupted, false);
});

// --- 2026-11-20: the hooks write the events offline_stats counts ----------

function readEvents(cwd) {
  const file = path.join(cwd, ".pi", "offline-engine", "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function gitRepo(prefix) {
  const dir = tempDir(prefix);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "App.csproj"), "<Project />\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@l", "commit", "-qm", "init");
  return dir;
}

test("compaction hook records tool_result_compacted for offline_stats", () => {
  const cwd = tempDir("pi-hook-events-");
  const result = runHook("compact-dotnet-output.mjs", bashPayload(cwd, "dotnet build", bigBuildLog));
  assert.equal(result.status, 0);
  const shown = JSON.parse(result.stdout).hookSpecificOutput.updatedToolOutput.stdout;
  const events = readEvents(cwd).filter((event) => event.type === "tool_result_compacted");
  assert.equal(events.length, 1);
  assert.equal(events[0].originalChars, bigBuildLog.length);
  assert.equal(events[0].compactedChars, shown.length);
  assert.equal(events[0].toolCallId, "toolu_test_1");
  assert.match(events[0].artifact, /^\.pi\/offline-engine\/tool-results\//);
});

test("snapshot hook counts the snapshot only where the engine's state directory exists", () => {
  const repo = gitRepo("pi-hook-capsule-");
  const payload = { hook_event_name: "SessionStart", source: "startup", cwd: repo };

  const first = runHook("repo-capsule.mjs", payload);
  assert.equal(first.status, 0);
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /repository snapshot/);
  assert.equal(fs.existsSync(path.join(repo, ".pi")), false, "a session start must not create .pi/");

  fs.mkdirSync(path.join(repo, ".pi", "offline-engine"), { recursive: true });
  const second = runHook("repo-capsule.mjs", payload);
  assert.equal(second.status, 0);
  const events = readEvents(repo).filter((event) => event.type === "repo_capsule_injected");
  assert.equal(events.length, 1);
  assert.equal(events[0].projectFiles, 1);
  assert.equal(typeof events[0].fingerprint, "string");
});
