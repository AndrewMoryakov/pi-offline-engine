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
