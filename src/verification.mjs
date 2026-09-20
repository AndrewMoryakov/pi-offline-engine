import fs from "node:fs/promises";
import path from "node:path";
import { isSafeRelativePath } from "./implementation-spec.mjs";
import { sha256 } from "./workspace-snapshot.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;

export async function runVerification({ cwd, spec, exec, signal, timeoutMs = DEFAULT_TIMEOUT_MS, attempt = 1 }) {
  const results = [];
  if (spec.verification.build) {
    const build = await runDotnetCheck({
      cwd,
      exec,
      signal,
      timeoutMs,
      kind: "build",
      project: spec.verification.build.project,
      args: ["build", spec.verification.build.project, "--no-restore", "--nologo", "--verbosity:minimal"],
      specId: spec.spec_id,
      attempt
    });
    results.push(build);
    if (!build.passed) return summarize(results);
  }

  if (spec.verification.tests) {
    const args = ["test", spec.verification.tests.project, "--no-restore", "--nologo", "--verbosity:minimal"];
    const names = spec.verification.tests.names ?? [];
    if (names.length) {
      const filter = names.map((name) => `FullyQualifiedName~${escapeFilterValue(name)}`).join("|");
      args.push("--filter", filter);
    }

    results.push(await runDotnetCheck({
      cwd,
      exec,
      signal,
      timeoutMs,
      kind: "tests",
      project: spec.verification.tests.project,
      args,
      specId: spec.spec_id,
      attempt
    }));
  }

  return summarize(results);
}

async function runDotnetCheck({ cwd, exec, signal, timeoutMs, kind, project, args, specId, attempt }) {
  if (!isSafeRelativePath(project)) throw new Error(`unsafe verification project path: ${project}`);
  const result = await exec("dotnet", args, { signal, timeout: timeoutMs });
  const artifact = await writeCommandArtifact(cwd, specId, attempt, kind, result);
  return {
    kind,
    passed: result.code === 0 && result.killed !== true,
    code: result.code,
    killed: result.killed === true,
    diagnostics: extractDiagnostics(result.stdout, result.stderr),
    artifact
  };
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
    /\bassert/i.test(line)
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
