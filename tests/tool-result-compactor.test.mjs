import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compactToolResult,
  extractTextContent,
  isDotnetBuildOrTest,
  summarizeDotnetOutput
} from "../src/tool-result-compactor.mjs";

test("recognizes only direct dotnet build and test shell commands", () => {
  assert.equal(isDotnetBuildOrTest("dotnet build src/App.csproj --no-restore"), true);
  assert.equal(isDotnetBuildOrTest("dotnet test App.Tests.csproj"), true);
  assert.equal(isDotnetBuildOrTest("cd src && dotnet test App.Tests.csproj"), false);
  assert.equal(isDotnetBuildOrTest("echo dotnet build"), false);
  assert.equal(isDotnetBuildOrTest("rm -rf / ; dotnet build"), false);
  assert.equal(isDotnetBuildOrTest("dotnet test && git status"), false);
  assert.equal(isDotnetBuildOrTest("dotnet build | tee build.log"), false);
  assert.equal(isDotnetBuildOrTest("dotnet test $(echo App.Tests.csproj)"), false);
});

test("extracts text blocks only", () => {
  assert.equal(extractTextContent([
    { type: "text", text: "a" },
    { type: "image", data: "x" },
    { type: "text", text: "b" }
  ]), "a\nb");
});

test("summarizer keeps compiler errors and artifact reference", () => {
  const text = [
    "Build started",
    "src/A.cs(10,4): error CS1002: ; expected",
    "noise",
    "Build FAILED."
  ].join("\n");
  const summary = summarizeDotnetOutput(text, {
    command: "dotnet build src/App.csproj",
    artifact: ".pi/offline-engine/tool-results/x.log"
  });
  assert.match(summary, /CS1002/);
  assert.match(summary, /Build FAILED/);
  assert.match(summary, /Full artifact:/);
});

test("compacts only large dotnet shell output and writes full artifact", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-compact-"));
  const large = [
    ...Array.from({ length: 500 }, (_, i) => `noise line ${i}`),
    "src/A.cs(10,4): error CS1002: ; expected",
    "Build FAILED."
  ].join("\n");

  const result = await compactToolResult({
    cwd,
    toolName: "bash",
    toolCallId: "call/123",
    input: { command: "dotnet build src/App.csproj" },
    content: [{ type: "text", text: large }],
    minChars: 100
  });

  assert.ok(result);
  assert.match(result.content[0].text, /CS1002/);
  const artifact = path.join(cwd, result.artifact);
  assert.match(await fs.readFile(artifact, "utf8"), /noise line 499/);
});

test("does not compact unrelated shell commands or small dotnet output", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-compact-"));
  assert.equal(await compactToolResult({
    cwd,
    toolName: "bash",
    toolCallId: "1",
    input: { command: "git status" },
    content: [{ type: "text", text: "x".repeat(1000) }],
    minChars: 10
  }), null);

  assert.equal(await compactToolResult({
    cwd,
    toolName: "bash",
    toolCallId: "2",
    input: { command: "dotnet test" },
    content: [{ type: "text", text: "Passed" }],
    minChars: 100
  }), null);
});
