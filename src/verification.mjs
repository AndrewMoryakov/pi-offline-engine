import fs from "node:fs/promises";
import path from "node:path";
import { isSafeRelativePath } from "./implementation-spec.mjs";
import { resolveInside, sha256 } from "./workspace-snapshot.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;
const RUNNER_DETECTION_TIMEOUT_MS = 10_000;

export async function runVerification({ cwd, spec, exec, signal, timeoutMs = DEFAULT_TIMEOUT_MS, attempt = 1 }) {
  const root = await fs.realpath(cwd);
  const results = [];

  if (spec.verification.build) {
    const project = await resolveVerificationProject(root, spec.verification.build.project);
    const build = await runDotnetCheck({
      cwd: root,
      exec,
      signal,
      timeoutMs,
      kind: "build",
      project: spec.verification.build.project,
      args: ["build", project, "--no-restore", "--nologo", "--verbosity:minimal"],
      specId: spec.spec_id,
      attempt
    });
    results.push(build);
    if (!build.passed) return summarize(results);
  }

  if (spec.verification.tests) {
    const project = await resolveVerificationProject(root, spec.verification.tests.project);
    const testCapabilities = await inspectDotnetTestRunner({
      cwd: root,
      exec,
      signal,
      timeoutMs: Math.min(timeoutMs, RUNNER_DETECTION_TIMEOUT_MS)
    });
    const runner = testCapabilities.runner;
    const names = spec.verification.tests.names ?? [];

    if (runner === "mtp" && !testCapabilities.trxReporting) {
      throw new Error(
        "Microsoft.Testing.Platform is active but TRX reporting is unavailable. " +
        "Add/enable Microsoft.Testing.Extensions.TrxReport (or an SDK profile that includes it) before offline verification."
      );
    }

    if (runner === "mtp") {
      const mtp = await runMtpTests({
        cwd: root,
        project,
        projectLabel: spec.verification.tests.project,
        expectedPatterns: names,
        exec,
        signal,
        timeoutMs,
        specId: spec.spec_id,
        attempt
      });
      results.push(mtp);
      if (!mtp.passed) return summarize(results);
    } else {
      const patterns = names.length > 0 ? names : [null];
      for (let index = 0; index < patterns.length; index += 1) {
        const vstest = await runVstestPattern({
          cwd: root,
          project,
          projectLabel: spec.verification.tests.project,
          pattern: patterns[index],
          patternIndex: index,
          patternCount: patterns.length,
          exec,
          signal,
          timeoutMs,
          specId: spec.spec_id,
          attempt
        });
        results.push(vstest);
        if (!vstest.passed) return summarize(results);
      }
    }
  }

  return summarize(results);
}

async function runVstestPattern({
  cwd,
  project,
  projectLabel,
  pattern,
  patternIndex,
  patternCount,
  exec,
  signal,
  timeoutMs,
  specId,
  attempt
}) {
  const testRun = await prepareTestRun(cwd, specId, attempt, `vstest-${patternIndex}`);
  const args = [
    "test",
    project,
    "--no-restore",
    "--nologo",
    "--verbosity:minimal",
    "--results-directory",
    testRun.directory,
    "--logger",
    `trx;LogFileName=${testRun.fileName}`
  ];

  if (pattern) args.push("--filter", `FullyQualifiedName~${escapeFilterValue(pattern)}`);

  const tests = await runDotnetCheck({
    cwd,
    exec,
    signal,
    timeoutMs,
    kind: patternCount === 1 ? "tests" : `tests-${patternIndex + 1}`,
    project: projectLabel,
    args,
    specId,
    attempt
  });

  return attachTrxEvidence(tests, testRun.filePath, {
    runner: "vstest",
    expectedPatterns: pattern ? [pattern] : []
  });
}

async function runMtpTests({
  cwd,
  project,
  projectLabel,
  expectedPatterns,
  exec,
  signal,
  timeoutMs,
  specId,
  attempt
}) {
  const testRun = await prepareTestRun(cwd, specId, attempt, "mtp");
  const args = [
    "test",
    "--project",
    project,
    "--no-restore",
    "--nologo",
    "--verbosity:minimal",
    "--results-directory",
    testRun.directory,
    "--",
    "--report-trx",
    "--report-trx-filename",
    testRun.fileName
  ];

  const tests = await runDotnetCheck({
    cwd,
    exec,
    signal,
    timeoutMs,
    kind: "tests",
    project: projectLabel,
    args,
    specId,
    attempt
  });

  return attachTrxEvidence(tests, testRun.filePath, {
    runner: "mtp",
    expectedPatterns
  });
}

async function attachTrxEvidence(tests, trxPath, { runner, expectedPatterns }) {
  const evidence = await readTrxEvidence(trxPath);
  tests.runner = runner;
  tests.testCount = evidence?.total ?? null;
  tests.executedTestCount = evidence?.executed ?? null;
  tests.executedTestIdentities = evidence?.executedIdentities ?? [];
  tests.expectedTestPatterns = expectedPatterns;
  tests.resultArtifact = trxPath;

  if (tests.passed && !(typeof tests.executedTestCount === "number" && tests.executedTestCount > 0)) {
    tests.passed = false;
    tests.diagnostics = [
      ...tests.diagnostics,
      tests.executedTestCount === 0
        ? "Test verification failed: zero tests executed."
        : "Test verification failed: no readable TRX execution count was produced."
    ].slice(0, 40);
    return tests;
  }

  if (tests.passed && expectedPatterns.length > 0 && runner === "mtp") {
    const missing = expectedPatterns.filter((pattern) =>
      !tests.executedTestIdentities.some((identity) => containsPattern(identity, pattern))
    );
    if (missing.length > 0) {
      tests.passed = false;
      tests.diagnostics = [
        ...tests.diagnostics,
        `MTP verification failed: declared test pattern(s) not found among executed TRX results: ${missing.join(", ")}`
      ].slice(0, 40);
    }
  }

  return tests;
}

export async function inspectDotnetTestRunner({ cwd, exec, signal, timeoutMs = RUNNER_DETECTION_TIMEOUT_MS }) {
  const help = await exec("dotnet", ["test", "--help"], { cwd, signal, timeout: timeoutMs });
  if (help.code !== 0 || help.killed === true) {
    throw new Error(`unable to detect dotnet test runner (exit ${String(help.code)})`);
  }

  const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
  const runner = /--test-modules\b|--max-parallel-test-modules\b/.test(text) ? "mtp" : "vstest";
  return {
    runner,
    trxReporting: runner === "vstest" || /--report-trx\b/.test(text),
    helpText: text
  };
}

export async function detectDotnetTestRunner(options) {
  return (await inspectDotnetTestRunner(options)).runner;
}

async function runDotnetCheck({ cwd, exec, signal, timeoutMs, kind, project, args, specId, attempt }) {
  const result = await exec("dotnet", args, { signal, timeout: timeoutMs, cwd });
  const artifact = await writeCommandArtifact(cwd, specId, attempt, kind, result);
  return {
    kind,
    project,
    passed: result.code === 0 && result.killed !== true,
    code: result.code,
    killed: result.killed === true,
    diagnostics: extractDiagnostics(result.stdout, result.stderr),
    artifact
  };
}

async function resolveVerificationProject(root, project) {
  if (!isSafeRelativePath(project)) throw new Error(`unsafe verification project path: ${project}`);
  const absolute = resolveInside(root, project);
  const real = await fs.realpath(absolute);
  const rel = path.relative(root, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`verification project escapes workspace through filesystem resolution: ${project}`);
  }
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error(`verification project is not a regular file: ${project}`);
  return real;
}

async function prepareTestRun(cwd, specId, attempt, discriminator) {
  const id = sha256(`${specId}:${attempt}:trx:${discriminator}`).slice(0, 20);
  const directory = path.join(cwd, ".pi", "offline-engine", "test-results", id);
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
  const fileName = "results.trx";
  return { directory, fileName, filePath: path.join(directory, fileName) };
}

async function readTrxEvidence(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const countersTag = text.match(/<Counters\b[^>]*>/i)?.[0];
    if (!countersTag) return null;

    const executedResults = new Map();
    const identities = new Set();

    for (const match of text.matchAll(/<UnitTestResult\b([^>]*)\/?\s*>/gi)) {
      const attrs = parseXmlAttributes(match[1]);
      const outcome = String(attrs.outcome ?? "").toLowerCase();
      if (outcome === "notexecuted" || outcome === "skipped") continue;
      if (attrs.testName) identities.add(decodeXml(attrs.testName));
      if (attrs.testId) executedResults.set(attrs.testId, true);
    }

    for (const match of text.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/gi)) {
      const attrs = parseXmlAttributes(match[1]);
      if (!attrs.id || !executedResults.has(attrs.id)) continue;
      const methodTag = match[2].match(/<TestMethod\b([^>]*)\/?\s*>/i)?.[1];
      if (!methodTag) continue;
      const method = parseXmlAttributes(methodTag);
      const className = method.className ? decodeXml(method.className) : "";
      const name = method.name ? decodeXml(method.name) : "";
      if (name) identities.add(name);
      if (className && name) identities.add(`${className}.${name}`);
    }

    return {
      total: readCounter(countersTag, "total"),
      executed: readCounter(countersTag, "executed"),
      executedIdentities: [...identities]
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function parseXmlAttributes(fragment) {
  const attrs = {};
  for (const match of String(fragment).matchAll(/([:\w.-]+)="([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function decodeXml(value) {
  return String(value)
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function readCounter(tag, name) {
  const value = tag.match(new RegExp(`\\b${name}="(\\d+)"`, "i"))?.[1];
  return value === undefined ? null : Number.parseInt(value, 10);
}

function containsPattern(identity, pattern) {
  return String(identity).toLocaleLowerCase().includes(String(pattern).toLocaleLowerCase());
}

function summarize(results) {
  return {
    passed: results.length > 0 && results.every((x) => x.passed),
    checks: results,
    diagnostics: results.flatMap((x) => x.diagnostics).slice(0, 40)
  };
}

function extractDiagnostics(stdout = "", stderr = "") {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map((x) => x.trimEnd()).filter(Boolean);
  const important = lines.filter((line) =>
    /\berror\b/i.test(line) ||
    /\bfailed\b/i.test(line) ||
    /\bexception\b/i.test(line) ||
    /\bassert/i.test(line) ||
    /no test/i.test(line) ||
    /MTP\d+/i.test(line)
  );
  const selected = important.length ? important : lines.slice(-20);
  return selected.slice(-40);
}

async function writeCommandArtifact(cwd, specId, attempt, kind, result) {
  const dir = path.join(cwd, ".pi", "offline-engine", "artifacts");
  await fs.mkdir(dir, { recursive: true });
  const id = sha256(`${specId}:${attempt}:${kind}`).slice(0, 20);
  const relative = path.join(".pi", "offline-engine", "artifacts", `${id}.log`);
  const absolute = path.join(cwd, relative);
  const body = [
    `kind=${kind}`,
    `exitCode=${String(result.code)}`,
    `killed=${String(result.killed === true)}`,
    "",
    "STDOUT",
    result.stdout ?? "",
    "",
    "STDERR",
    result.stderr ?? ""
  ].join("\n");
  await fs.writeFile(absolute, body, "utf8");
  return relative.replaceAll("\\", "/");
}

function escapeFilterValue(value) {
  return String(value).replaceAll("|", "\\|");
}
