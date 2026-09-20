import fs from "node:fs/promises";
import path from "node:path";
import { isSafeRelativePath } from "./implementation-spec.mjs";
import { resolveInside, sha256 } from "./workspace-snapshot.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;

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
    const testRun = await prepareTestRun(root, spec.spec_id, attempt);
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

    const names = spec.verification.tests.names ?? [];
    if (names.length) {
      const filter = names.map((name) => `FullyQualifiedName~${escapeFilterValue(name)}`).join("|");
      args.push("--filter", filter);
    }

    const tests = await runDotnetCheck({
      cwd: root,
      exec,
      signal,
      timeoutMs,
      kind: "tests",
      project: spec.verification.tests.project,
      args,
      specId: spec.spec_id,
      attempt
    });

    const testCount = await readTrxTotal(testRun.filePath);
    tests.testCount = testCount;
    tests.resultArtifact = relativeArtifact(root, testRun.filePath);

    // dotnet/vstest may return 0 when a filter matches no tests. A successful
    // test verification therefore requires machine-readable evidence that at
    // least one test actually executed.
    if (tests.passed && !(typeof testCount === "number" && testCount > 0)) {
      tests.passed = false;
      tests.diagnostics = [
        ...tests.diagnostics,
        testCount === 0
          ? "Test verification failed: zero tests executed."
          : "Test verification failed: no readable TRX result was produced; test count is unknown."
      ].slice(0, 40);
    }

    results.push(tests);
  }

  return summarize(results);
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

async function prepareTestRun(cwd, specId, attempt) {
  const id = sha256(`${specId}:${attempt}:trx`).slice(0, 20);
  const directory = path.join(cwd, ".pi", "offline-engine", "test-results", id);
  // A repeated spec/attempt must never inherit a prior TRX. Otherwise a test
  // process that exits 0 without producing a result could accidentally reuse
  // stale evidence from an earlier run.
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
  const fileName = "results.trx";
  return { directory, fileName, filePath: path.join(directory, fileName) };
}

async function readTrxTotal(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const countersTag = text.match(/<Counters\b[^>]*>/i)?.[0];
    if (!countersTag) return null;
    const total = countersTag.match(/\btotal="(\d+)"/i)?.[1];
    return total === undefined ? null : Number.parseInt(total, 10);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
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
    /no test/i.test(line)
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

function relativeArtifact(cwd, absolute) {
  return path.relative(cwd, absolute).replaceAll("\\", "/");
}

function escapeFilterValue(value) {
  return String(value).replaceAll("|", "\\|");
}
