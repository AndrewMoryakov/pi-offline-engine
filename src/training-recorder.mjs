import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519|credentials?|secrets?)(?:\.|$|\/)/i,
  /\.(?:pem|p12|pfx|key)$/i
];

export function createTrainingRunId(specId = "run") {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return `${sanitizeId(specId)}-${suffix}`;
}

export function hasSensitiveTrainingPath(spec) {
  const paths = [
    spec?.target?.file,
    ...(Array.isArray(spec?.scope?.allowed_files) ? spec.scope.allowed_files : [])
  ].filter(Boolean);
  return paths.some((value) => SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalizePath(value))));
}

export async function appendTrainingRecord(cwd, record) {
  const dir = path.join(cwd, ".pi", "offline-engine", "training");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "raw.jsonl");
  const row = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    ...record
  };
  await fs.appendFile(file, JSON.stringify(row) + "\n", "utf8");
  return file;
}

export function makeImplementationAttemptRecord({
  runId,
  model,
  attempt,
  spec,
  context,
  repairPacket,
  candidate,
  verification = null,
  outcome,
  usage = null,
  latencyMs = null
}) {
  return {
    kind: "implementation_attempt",
    run_id: runId,
    spec_id: spec.spec_id,
    model,
    attempt,
    input: {
      implementation_spec: spec,
      context: context ?? {},
      repair_packet: repairPacket ?? null
    },
    output: {
      candidate
    },
    supervision: {
      outcome,
      verification_passed: verification?.passed === true,
      diagnostics: verification?.diagnostics ?? [],
      checks: (verification?.checks ?? []).map((check) => ({
        kind: check.kind,
        passed: check.passed,
        code: check.code,
        runner: check.runner ?? null,
        test_pattern: check.testPattern ?? null,
        expected_test_patterns: check.expectedTestPatterns ?? null,
        test_count: check.testCount ?? null,
        executed_test_count: check.executedTestCount ?? null
      }))
    },
    usage,
    latency_ms: latencyMs
  };
}

export function makeInfrastructureFailureRecord({ runId, spec, attempt, stage, reason, error }) {
  return {
    kind: "infrastructure_failure",
    run_id: runId,
    spec_id: spec.spec_id,
    attempt,
    stage,
    reason,
    error: String(error)
  };
}

export function trainingCaptureStatus({ enabled, includeContext = true }) {
  return {
    enabled: Boolean(enabled),
    includeContext: Boolean(includeContext),
    rawPath: ".pi/offline-engine/training/raw.jsonl"
  };
}

function sanitizeId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "run";
}

function normalizePath(value) {
  return String(value).replaceAll("\\", "/");
}
