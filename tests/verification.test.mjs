import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectDotnetTestRunner, runVerification } from "../src/verification.mjs";

const baseSpec = {
  spec_id: "verify-001",
  verification: {
    build: { project: "src/App.csproj" },
    tests: { project: "tests/App.Tests.csproj", names: ["RetryTests.Cancellation", "RetryTests.Backoff"] }
  }
};

async function createProjects(cwd) {
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "App.csproj"), "<Project />", "utf8");
  await fs.writeFile(path.join(cwd, "tests", "App.Tests.csproj"), "<Project />", "utf8");
}

function trxPathFromArgs(args) {
  const resultsIndex = args.indexOf("--results-directory");
  const directory = args[resultsIndex + 1];

  const loggerIndex = args.indexOf("--logger");
  if (loggerIndex >= 0) {
    const logger = args[loggerIndex + 1];
    return path.join(directory, logger.replace(/^trx;LogFileName=/, ""));
  }

  const filenameIndex = args.indexOf("--report-trx-filename");
  return path.join(directory, args[filenameIndex + 1]);
}

async function writeTrxFromArgs(
  args,
  {
    total = 1,
    executed = total,
    passed = executed,
    failed = 0,
    tests = []
  } = {}
) {
  const file = trxPathFromArgs(args);
  await fs.mkdir(path.dirname(file), { recursive: true });

  const results = tests.map((x, i) =>
    `<UnitTestResult testId="${i + 1}" testName="${x.name}" outcome="${x.outcome ?? "Passed"}" />`
  ).join("");

  const definitions = tests.map((x, i) =>
    `<UnitTest id="${i + 1}" name="${x.name}"><TestMethod className="${x.className}" name="${x.methodName ?? x.name}" /></UnitTest>`
  ).join("");

  await fs.writeFile(
    file,
    `<?xml version="1.0"?><TestRun><Results>${results}</Results><TestDefinitions>${definitions}</TestDefinitions><ResultSummary><Counters total="${total}" executed="${executed}" passed="${passed}" failed="${failed}" /></ResultSummary></TestRun>`,
    "utf8"
  );
}

function vstestHelp() {
  return { code: 0, killed: false, stdout: "Options:\n  --logger <LOGGER>\n  --filter <EXPRESSION>", stderr: "" };
}

function mtpHelp({ trx = true } = {}) {
  return {
    code: 0,
    killed: false,
    stdout: [
      "Options:",
      "  --test-modules <EXPRESSION>",
      "  --max-parallel-test-modules <NUMBER>",
      ...(trx ? ["  --report-trx", "  --report-trx-filename <FILE>"] : [])
    ].join("\n"),
    stderr: ""
  };
}

test("detects VSTest and MTP from dotnet test help", async () => {
  assert.equal(await detectDotnetTestRunner({
    cwd: "/repo",
    exec: async () => vstestHelp()
  }), "vstest");

  assert.equal(await detectDotnetTestRunner({
    cwd: "/repo",
    exec: async () => mtpHelp()
  }), "mtp");
});

test("VSTest runs every declared pattern independently and requires execution evidence", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
  await createProjects(cwd);
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === "test" && args[1] === "--help") return vstestHelp();
    if (args[0] === "test") await writeTrxFromArgs(args, { total: 1, executed: 1 });
    return { code: 0, killed: false, stdout: "ok", stderr: "" };
  };

  const result = await runVerification({ cwd, spec: baseSpec, exec, attempt: 1 });
  assert.equal(result.passed, true);
  assert.equal(calls.length, 4); // build + runner help + 2 targeted test runs
  assert.equal(calls[0][1][0], "build");
  assert.deepEqual(calls[1][1].slice(0, 3), ["test", "--help", "--project"]);
  assert.equal(path.basename(calls[1][1][3]), "App.Tests.csproj");
  assert.equal(path.basename(path.dirname(calls[1][1][3])), "tests");
  assert.equal(calls[2][1][0], "test");
  assert.equal(calls[3][1][0], "test");
  assert.ok(calls[2][1].includes("--filter"));
  assert.ok(calls[3][1].includes("--filter"));
  assert.equal(result.checks[1].executedTestCount, 1);
  assert.equal(result.checks[2].executedTestCount, 1);
  assert.equal(result.checks[1].runner, "vstest");
});

test("MTP uses report-trx and validates every expected identity from one executed suite", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
  await createProjects(cwd);
  const calls = [];
  const exec = async (_command, args) => {
    calls.push(args);
    if (args[0] === "test" && args[1] === "--help") return mtpHelp();
    if (args[0] === "test") {
      await writeTrxFromArgs(args, {
        total: 2,
        executed: 2,
        tests: [
          { name: "Cancellation", className: "RetryTests", methodName: "Cancellation" },
          { name: "Backoff", className: "RetryTests", methodName: "Backoff" }
        ]
      });
    }
    return { code: 0, killed: false, stdout: "ok", stderr: "" };
  };

  const result = await runVerification({ cwd, spec: baseSpec, exec, attempt: 1 });
  assert.equal(result.passed, true);
  const testArgs = calls.find((args) => args[0] === "test" && args[1] !== "--help");
  assert.ok(testArgs.includes("--project"));
  assert.ok(testArgs.includes("--report-trx"));
  assert.ok(testArgs.includes("--report-trx-filename"));
  assert.equal(testArgs.includes("--"), false);
  assert.equal(testArgs.includes("--logger"), false);
  assert.equal(testArgs.includes("--filter"), false);
  assert.equal(testArgs.includes("--nologo"), false);
  assert.equal(testArgs.includes("--no-logo"), false);
  assert.equal(testArgs.some((arg) => String(arg).startsWith("--verbosity")), false);
  assert.equal(result.checks[1].runner, "mtp");
  assert.equal(result.checks[1].executedTestCount, 2);
});

test("MTP fails if one declared expected pattern is absent from executed TRX identities", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
  await createProjects(cwd);
  const exec = async (_command, args) => {
    if (args[0] === "test" && args[1] === "--help") return mtpHelp();
    if (args[0] === "test") {
      await writeTrxFromArgs(args, {
        total: 1,
        executed: 1,
        tests: [{ name: "Cancellation", className: "RetryTests", methodName: "Cancellation" }]
      });
    }
    return { code: 0, killed: false, stdout: "ok", stderr: "" };
  };

  const result = await runVerification({ cwd, spec: baseSpec, exec, attempt: 1 });
  assert.equal(result.passed, false);
  assert.match(result.diagnostics.join("\n"), /RetryTests\.Backoff/);
});

test("does not run tests after failed build", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
  await createProjects(cwd);
  let calls = 0;
  const exec = async () => {
    calls += 1;
    return { code: 1, killed: false, stdout: "Program.cs(1,1): error CS1002: ; expected", stderr: "" };
  };

  const result = await runVerification({ cwd, spec: baseSpec, exec, attempt: 1 });
  assert.equal(result.passed, false);
  assert.equal(calls, 1);
  assert.match(result.diagnostics.join("\n"), /CS1002/);
});

test("rejects exit-code-zero VSTest runs that executed zero tests", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
  await createProjects(cwd);
  const exec = async (_command, args) => {
    if (args[0] === "test" && args[1] === "--help") return vstestHelp();
    if (args[0] === "test") await writeTrxFromArgs(args, { total: 0, executed: 0 });
    return { code: 0, killed: false, stdout: "ok", stderr: "" };
  };

  const result = await runVerification({ cwd, spec: baseSpec, exec, attempt: 1 });
  assert.equal(result.passed, false);
  assert.equal(result.checks[1].executedTestCount, 0);
  assert.match(result.diagnostics.join("\n"), /zero tests executed/);
});

test("rejects total-positive but all-skipped test results", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
  await createProjects(cwd);
  const exec = async (_command, args) => {
    if (args[0] === "test" && args[1] === "--help") return vstestHelp();
    if (args[0] === "test") await writeTrxFromArgs(args, { total: 3, executed: 0, passed: 0 });
    return { code: 0, killed: false, stdout: "ok", stderr: "" };
  };

  const result = await runVerification({ cwd, spec: baseSpec, exec, attempt: 1 });
  assert.equal(result.passed, false);
  assert.equal(result.checks[1].testCount, 3);
  assert.equal(result.checks[1].executedTestCount, 0);
});

test("rejects successful test exit when no TRX result is produced", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
  await createProjects(cwd);
  const exec = async (_command, args) => {
    if (args[0] === "test" && args[1] === "--help") return vstestHelp();
    return { code: 0, killed: false, stdout: "ok", stderr: "" };
  };

  const result = await runVerification({ cwd, spec: baseSpec, exec, attempt: 1 });
  assert.equal(result.passed, false);
  assert.equal(result.checks[1].executedTestCount, null);
  assert.match(result.diagnostics.join("\n"), /no readable TRX execution count/);
});

test("VSTest fails when any one of multiple declared patterns executes no tests", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
  await createProjects(cwd);
  let testCall = 0;
  const exec = async (_command, args) => {
    if (args[0] === "test" && args[1] === "--help") return vstestHelp();
    if (args[0] === "test") {
      testCall += 1;
      await writeTrxFromArgs(args, testCall === 1
        ? { total: 1, executed: 1 }
        : { total: 0, executed: 0 });
    }
    return { code: 0, killed: false, stdout: "ok", stderr: "" };
  };

  const result = await runVerification({ cwd, spec: baseSpec, exec, attempt: 1 });
  assert.equal(result.passed, false);
  assert.equal(testCall, 2);
  assert.equal(result.checks[1].passed, true);
  assert.equal(result.checks[2].passed, false);
});

test("rejects verification project symlinks escaping the workspace", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is permission-sensitive on Windows");
    return;
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pi-outside-"));
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(outside, "Outside.csproj"), "<Project />", "utf8");
  await fs.symlink(path.join(outside, "Outside.csproj"), path.join(cwd, "src", "App.csproj"));

  const spec = {
    spec_id: "verify-escape",
    verification: { build: { project: "src/App.csproj" } }
  };

  await assert.rejects(
    () => runVerification({
      cwd,
      spec,
      exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
      attempt: 1
    }),
    /escapes workspace/
  );
});

test("does not reuse stale VSTest TRX evidence from a previous identical pattern run", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
  await createProjects(cwd);

  const id = crypto.createHash("sha256").update("verify-001:1:trx:vstest-0").digest("hex").slice(0, 20);
  const resultDir = path.join(cwd, ".pi", "offline-engine", "test-results", id);
  await fs.mkdir(resultDir, { recursive: true });
  await fs.writeFile(
    path.join(resultDir, "results.trx"),
    '<?xml version="1.0"?><TestRun><ResultSummary><Counters total="99" executed="99" /></ResultSummary></TestRun>',
    "utf8"
  );

  const exec = async (_command, args) => {
    if (args[0] === "test" && args[1] === "--help") return vstestHelp();
    return { code: 0, killed: false, stdout: "ok", stderr: "" };
  };
  const result = await runVerification({ cwd, spec: baseSpec, exec, attempt: 1 });

  assert.equal(result.passed, false);
  assert.equal(result.checks[1].executedTestCount, null);
  assert.match(result.diagnostics.join("\n"), /no readable TRX execution count/);
});


test("fails fast when MTP has no TRX report extension", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
  await createProjects(cwd);
  let actualTestRuns = 0;
  const exec = async (_command, args) => {
    if (args[0] === "test" && args[1] === "--help") return mtpHelp({ trx: false });
    if (args[0] === "test") actualTestRuns += 1;
    return { code: 0, killed: false, stdout: "ok", stderr: "" };
  };

  await assert.rejects(
    () => runVerification({ cwd, spec: baseSpec, exec, attempt: 1 }),
    /TRX reporting is unavailable/
  );
  assert.equal(actualTestRuns, 0);
});
