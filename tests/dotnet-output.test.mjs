import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDiagnosticLine, parseDotnetOutput, formatDotnetReport, failureFromTrx } from "../src/dotnet-output.mjs";
import { summarizeDotnetOutput } from "../src/tool-result-compactor.mjs";
import { extractDiagnostics, readTrxFailures, runVerification } from "../src/verification.mjs";
import { fileURLToPath } from "node:url";

const FIXTURES = new URL("./fixtures/dotnet-output/", import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIXTURES), "utf8");

test("canonical MSBuild diagnostics are recognised in their usual shapes", () => {
  const cases = [
    ["/work/app/src/A.cs(12,5): error CS0103: The name 'x' does not exist [/work/app/src/App.csproj]", "src/A.cs(12,5): error CS0103: The name 'x' does not exist"],
    ["C:\\work\\app\\src\\A.cs(3,1,3,9): warning CS8618: Non-nullable property [C:\\work\\app\\src\\App.csproj::TargetFramework=net10.0]", "src\\A.cs(3,1,3,9): warning CS8618: Non-nullable property"],
    ["/work/app/src/App.csproj : error NU1101: Unable to find package Foo.", "src/App.csproj: error NU1101: Unable to find package Foo."],
    ["MSBUILD : error MSB1009: Project file does not exist.", "MSBUILD: error MSB1009: Project file does not exist."],
    ["CSC : error CS2001: Source file 'x.cs' could not be found.", "CSC: error CS2001: Source file 'x.cs' could not be found."],
    ["/work/app/build/Custom.targets(5,5): error : The command \"make\" exited with code 2.", "build/Custom.targets(5,5): error: The command \"make\" exited with code 2."]
  ];
  for (const [line, display] of cases) {
    const relative = (value) => value.replace(/^\/work\/app\//, "").replace(/^C:\\work\\app\\/, "");
    assert.equal(parseDiagnosticLine(line, relative)?.display, display, line);
  }
});

test("lines that only look like diagnostics are not counted", () => {
  for (const line of [
    "       Errors: MSB4276: The default SDK resolver failed to resolve SDK \"Microsoft.NET.SDK.WorkloadAutoImportPropsLocator\" because directory \"/usr/lib/dotnet/sdk/10.0.404/Sdks/Microsoft.NET.SDK.WorkloadAutoImportPropsLocator/Sdk\" did not exist.",
    "    0 Error(s)",
    "  Expected: 7",
    "Build FAILED."
  ]) {
    assert.equal(parseDiagnosticLine(line), null, line);
  }
});

test("a build error printed twice by MSBuild is reported once", () => {
  const line = "/w/src/A.cs(1,20): error CS1002: ; expected [/w/src/App.csproj]";
  const parsed = parseDotnetOutput([line, "Build FAILED.", "", line, "    0 Warning(s)", "    1 Error(s)"].join("\n"), { cwd: "/w" });
  assert.equal(parsed.errors.length, 1);
  assert.deepEqual(formatDotnetReport(parsed), [
    "Result: Build FAILED, 1 error, 0 warnings",
    "Errors (1 unique):",
    "  src/A.cs(1,20): error CS1002: ; expected"
  ]);
});

test("output in an unknown shape keeps the keyword summary used before", () => {
  const text = ["Restoring...", "Die Erstellung ist fehlgeschlagen.", "something failed in a tool", "tail line"].join("\n");
  const summary = summarizeDotnetOutput(text, { command: "dotnet build" });
  assert.match(summary, /^Selected diagnostics:$/m);
  assert.match(summary, /^something failed in a tool$/m);
  assert.doesNotMatch(summary, /^Result:/m);
});

test("a failure the reader cannot explain also shows the keyword lines", () => {
  const text = ["  App -> /w/bin/App.dll", "  Unhandled tool exception in step Foo", "Build FAILED.", "    0 Warning(s)", "    0 Error(s)"].join("\n");
  const summary = summarizeDotnetOutput(text, { command: "dotnet build", cwd: "/w" });
  assert.match(summary.split("\n")[1], /^Result: Build FAILED, 0 errors, 0 warnings$/);
  assert.match(summary, /^Lines that mention a failure \(shape not recognised\):$/m);
  assert.match(summary, /Unhandled tool exception in step Foo/);
});

test("a long list of failures stays within budget and keeps the verdict and first failure", () => {
  const blocks = Array.from({ length: 300 }, (_, i) => [
    `  Failed Suite.Case${i} [1 ms]`,
    "  Error Message:",
    `   Assert.Equal() Failure: Values differ ${"x".repeat(200)}`,
    `Expected: ${i}`,
    `Actual:   ${i + 1}`,
    "  Stack Trace:",
    `     at Suite.Case${i}() in /w/tests/Suite.cs:line ${i + 10}`
  ].join("\n"));
  const text = [...blocks, "", "Failed!  - Failed:   300, Passed:     0, Skipped:     0, Total:   300, Duration: 1 s - Suite.dll (net10.0)"].join("\n");
  const lines = formatDotnetReport(parseDotnetOutput(text, { cwd: "/w" }), { budget: 1500 });
  const body = lines.join("\n");
  assert.equal(lines[0], "Result: Tests FAILED, 300 failed, 0 passed, 0 skipped of 300");
  assert.match(body, /^ {4}Expected: 0$/m);
  assert.match(body, /at Suite\.Case0\(\) in tests\/Suite\.cs:line 10/);
  assert.match(lines.at(-1), /did not fit; they are in the full output\)$/);
  assert.ok(body.length <= 1500 + 600, `${body.length}`);
});

test("TRX failures keep the message and the first frame in the project", () => {
  const failure = failureFromTrx({
    name: "MTests.ManyTests.Case7",
    message: "Assert.AreEqual failed. Expected:<7>. Actual:<8>.",
    stackTrace: [
      "   at Microsoft.VisualStudio.TestTools.UnitTesting.Assert.ThrowAssertAreEqualFailed(Object expected, Object actual, String userMessage) in /_/src/TestFramework/TestFramework/Assertions/Assert.AreEqual.cs:line 1015",
      "   at MTests.ManyTests.Case7() in /w/MTests/ManyTests.cs:line 9",
      "   at System.Reflection.MethodBaseInvoker.InvokeWithNoArgs(Object obj, BindingFlags invokeAttr)"
    ].join("\n")
  }, { cwd: "/w" });
  assert.deepEqual(failure, {
    name: "MTests.ManyTests.Case7",
    message: ["Assert.AreEqual failed. Expected:<7>. Actual:<8>."],
    frame: "at MTests.ManyTests.Case7() in MTests/ManyTests.cs:line 9"
  });
});

test("repair diagnostics carry xUnit's expected and actual values", () => {
  const diagnostics = extractDiagnostics(fixture("test-xunit-failures.txt"), "", { cwd: "/work/lab", failed: true });
  assert.equal(diagnostics[0], "Result: Tests FAILED, 22 failed, 1 passed, 0 skipped of 23");
  assert.ok(diagnostics.includes("    Expected: 0"), diagnostics.join("\n"));
  assert.ok(diagnostics.includes("    Actual:   1"), diagnostics.join("\n"));
  assert.ok(diagnostics.includes("    at XTests.CalcTests.AddsZero() in XTests/UnitTest1.cs:line 4"), diagnostics.join("\n"));
  assert.ok(diagnostics.length <= 40);
});

test("verification takes failed tests from the TRX file into the repair diagnostics", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-trx-failures-"));
  await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
  await fs.writeFile(path.join(cwd, "tests", "App.Tests.csproj"), "<Project />", "utf8");
  const root = await fs.realpath(cwd);
  const trx = fixture("test-xunit-failures.trx").replaceAll("/work/lab/", `${root}/`);

  // The console shows only the failure count; the values exist only in TRX.
  const exec = async (command, args) => {
    if (args.includes("--help")) return { code: 0, killed: false, stdout: "--logger\n--filter", stderr: "" };
    const directory = args[args.indexOf("--results-directory") + 1];
    const fileName = args[args.indexOf("--logger") + 1].replace(/^trx;LogFileName=/, "");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, fileName), trx, "utf8");
    return { code: 1, killed: false, stdout: "Failed!  - Failed:    22, Passed:     1, Skipped:     0, Total:    23, Duration: 44 ms - XTests.dll (net10.0)", stderr: "" };
  };

  const spec = { spec_id: "trx-failures", verification: { tests: { project: "tests/App.Tests.csproj" } } };
  const result = await runVerification({ cwd, spec, exec, attempt: 1 });
  const text = result.diagnostics.join("\n");
  assert.equal(result.passed, false);
  assert.equal(result.diagnostics[0], "Result: Tests FAILED, 22 failed, 1 passed, 0 skipped of 23");
  assert.match(text, /^ {4}Assert\.Equal\(\) Failure: Values differ$/m);
  assert.match(text, /^ {4}Expected: (\d+)\n {4}Actual: {3}\d+$/m);
  assert.match(text, /^ {4}at XTests\.\w+\.\w+\(\) in XTests\/(?:ManyTests|UnitTest1)\.cs:line \d+$/m);
  assert.doesNotMatch(text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "paths are relative to the workspace");
});

test("every failed result in a TRX file is read, next to self-closing passed results", async () => {
  const xunit = await readTrxFailures(fileURLToPath(new URL("test-xunit-failures.trx", FIXTURES)));
  assert.equal(xunit.length, 22);
  assert.equal(new Set(xunit.map((failure) => failure.name)).size, 22);
  const case7 = xunit.find((failure) => failure.name === "XTests.ManyTests.Case7");
  assert.equal(case7.message, "Assert.Equal() Failure: Values differ\nExpected: 7\nActual:   8");
  const mtp = await readTrxFailures(fileURLToPath(new URL("test-mtp-failure.trx", FIXTURES)));
  assert.deepEqual(mtp.map((failure) => failure.name), ["ExactlyThresholdIsNotDiscounted"]);
});

test("a non-zero exit without a recognised error adds the keyword lines", () => {
  const text = ["Build succeeded.", "    0 Warning(s)", "    0 Error(s)", "Tool crashed: unexpected exception in post-build step"].join("\n");
  assert.doesNotMatch(summarizeDotnetOutput(text, { cwd: "/w" }), /shape not recognised/);
  const summary = summarizeDotnetOutput(text, { cwd: "/w", failed: true });
  assert.match(summary, /^Lines that mention a failure \(shape not recognised\):\nTool crashed: unexpected exception in post-build step$/m);
});

