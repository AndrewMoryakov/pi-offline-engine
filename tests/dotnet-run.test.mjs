import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runDotnetCommand } from "../src/dotnet-run.mjs";

async function workspace() {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-dotnet-run-")));
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "App.csproj"), "<Project />", "utf8");
  await fs.writeFile(path.join(cwd, "src", "A.cs"), "class A {}", "utf8");
  return cwd;
}

function recorder(result) {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    return result;
  };
  return { calls, exec };
}

test("a short failed build is shown whole under its exit code and verdict", async () => {
  const cwd = await workspace();
  const stdout = `${cwd}/src/A.cs(1,9): error CS1002: ; expected [${cwd}/src/App.csproj]\nBuild FAILED.`;
  const { calls, exec } = recorder({ code: 1, killed: false, stdout, stderr: "" });
  const outcome = await runDotnetCommand({ cwd, command: "build", project: "src/App.csproj", noRestore: true, exec });
  assert.deepEqual(calls[0].args, ["build", "src/App.csproj", "--no-restore"]);
  assert.equal(calls[0].options.cwd, cwd);
  assert.equal(outcome.compacted, null);
  const lines = outcome.text.split("\n");
  assert.equal(lines[0], "dotnet build src/App.csproj --no-restore: exit code 1");
  assert.equal(lines[1], "Result: Build FAILED, 1 error, 0 warnings");
  assert.ok(outcome.text.includes(stdout), "short output is not cut");
});

test("a long failed run is compacted and its full output kept on disk", async () => {
  const cwd = await workspace();
  const stdout = [
    ...Array.from({ length: 400 }, (_, i) => `  restore and build noise line ${i}`),
    `${cwd}/src/A.cs(1,9): error CS1002: ; expected [${cwd}/src/App.csproj]`,
    "Build FAILED."
  ].join("\n");
  const { exec } = recorder({ code: 1, killed: false, stdout, stderr: "" });
  const outcome = await runDotnetCommand({ cwd, command: "build", exec, toolCallId: "run-1" });
  assert.ok(outcome.compacted);
  assert.match(outcome.text, /^dotnet build: exit code 1$/m);
  assert.match(outcome.text, /^ {2}src\/A\.cs\(1,9\): error CS1002: ; expected$/m);
  assert.ok(outcome.text.length < 1000);
  const kept = await fs.readFile(path.join(cwd, outcome.compacted.artifact), "utf8");
  assert.ok(kept.includes(stdout));
});

test("a killed run says so instead of an exit code", async () => {
  const cwd = await workspace();
  const { exec } = recorder({ code: null, killed: true, stdout: "", stderr: "" });
  const outcome = await runDotnetCommand({ cwd, command: "test", exec, timeoutMs: 60_000 });
  assert.match(outcome.text, /^dotnet test: killed after 60 s$/m);
});

test("test options are passed as separate arguments, never through a shell", async () => {
  const cwd = await workspace();
  const { calls, exec } = recorder({ code: 0, killed: false, stdout: "Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 5 ms - App.Tests.dll (net10.0)", stderr: "" });
  const outcome = await runDotnetCommand({ cwd, command: "test", project: "src", filter: "Name~A & Priority=1; rm -rf /", configuration: "Release", exec });
  assert.deepEqual(calls[0].args, ["test", "src", "--configuration", "Release", "--filter", "Name~A & Priority=1; rm -rf /"]);
  assert.match(outcome.text, /^Result: Tests passed, 0 failed, 3 passed, 0 skipped of 3$/m);
});

test("Microsoft.Testing.Platform mode passes the project with --project", async () => {
  const cwd = await workspace();
  await fs.writeFile(path.join(cwd, "global.json"), JSON.stringify({ test: { runner: "Microsoft.Testing.Platform" } }), "utf8");
  const { calls, exec } = recorder({ code: 0, killed: false, stdout: "", stderr: "" });
  await runDotnetCommand({ cwd, command: "test", project: "src/App.csproj", exec });
  assert.deepEqual(calls[0].args, ["test", "--project", "src/App.csproj"]);
  await runDotnetCommand({ cwd, command: "build", project: "src/App.csproj", exec });
  assert.deepEqual(calls[1].args, ["build", "src/App.csproj"]);
});

test("unsafe or unknown arguments are refused before dotnet runs", async () => {
  const cwd = await workspace();
  const exec = async () => { throw new Error("dotnet must not run"); };
  const refused = [
    [{ command: "publish" }, /unsupported dotnet command/],
    [{ command: "build", project: "../App.csproj" }, /relative path inside the workspace/],
    [{ command: "build", project: "/etc/App.csproj" }, /relative path inside the workspace/],
    [{ command: "build", project: "src/Missing.csproj" }, /does not exist/],
    [{ command: "build", project: "src/A.cs" }, /project or solution file, or a directory/],
    [{ command: "build", filter: "Name~A" }, /dotnet test only/],
    [{ command: "test", filter: "a\nb" }, /one line/],
    [{ command: "build", configuration: "Release --source http://x" }, /plain name/]
  ];
  for (const [options, message] of refused) {
    await assert.rejects(runDotnetCommand({ cwd, exec, ...options }), message, JSON.stringify(options));
  }
});

test("a project that links outside the workspace is refused", async () => {
  const cwd = await workspace();
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-dotnet-outside-")));
  await fs.writeFile(path.join(outside, "Other.csproj"), "<Project />", "utf8");
  await fs.symlink(path.join(outside, "Other.csproj"), path.join(cwd, "Linked.csproj"));
  const exec = async () => { throw new Error("dotnet must not run"); };
  await assert.rejects(runDotnetCommand({ cwd, command: "build", project: "Linked.csproj", exec }), /outside the workspace/);
});
