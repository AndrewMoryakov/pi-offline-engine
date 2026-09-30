// Exactly one TinyCoder attempt of bounded execution: snapshot the allowed
// files, call TinyCoder, validate its output, and for a valid candidate save
// it, apply it under the mutation queues and run the declared verification.
//
// The attempt never throws. It returns a discriminated outcome at the point
// where the outer workflow (delegation-execution-workflow.mjs) must decide
// between retry, escalation and completion:
//
//   invalid_model_output   source "candidate" (validation rejected the
//                          candidate) or "tiny_output" (TinyModelOutputError)
//   terminal_model_status  TinyCoder answered insufficient_spec or
//                          cannot_safely_implement
//   verification_passed    candidate applied, verification green
//   verification_failed    candidate applied, verification red
//   runtime_failure        any other error, classified later by `stage`
//
// Every outcome carries `stage` (the last stage reached, starting from the
// carried-in stage), `tinyResult` (when TinyCoder returned), `applied` (when
// the write completed) and `verification` (when it returned). The kinds are
// internal control-flow labels, not public status or event strings.
//
// This module is the only importer of the TinyCoder client, so the
// TinyModelOutputError class it tests against is always the one the default
// transport throws.

import path from "node:path";
import { validateCandidate } from "./implementation-spec.mjs";
import { callTinyImplementer, TinyModelOutputError } from "./tiny-client.mjs";
import { resolveInside, snapshotAllowedFiles } from "./workspace-snapshot.mjs";
import { saveCandidateRecord } from "./candidate-store.mjs";
import { applyCandidate } from "./apply-candidate.mjs";
import { runVerification } from "./verification.mjs";
import { makeImplementationAttemptRecord, safeAppendTrainingRecord } from "./training-recorder.mjs";

// Default TinyCoder transport. The API key is resolved per request.
export function createTinyTransport(resolveApiKey) {
  return (request) => callTinyImplementer({ ...request, apiKey: resolveApiKey() });
}

// Best-effort training capture: a recorder failure (or its telemetry) never
// affects the coding task.
export async function captureTrainingRecord({ cwd, record, appendEvent }) {
  const result = await safeAppendTrainingRecord(cwd, record);
  if (!result.ok) {
    try {
      await appendEvent(cwd, {
        type: result.skipped ? "training_capture_skipped_sensitive_path" : "training_capture_failed",
        error: result.error
      });
    } catch {
      // Training capture and its telemetry must never affect the coding task.
    }
  }
  return result;
}

export function uniqueAbsolutePaths(cwd, candidate) {
  const root = path.resolve(cwd);
  return [...new Set(candidate.changes.map((change) => resolveInside(root, change.path)))].sort();
}

export async function runDelegationAttempt({
  attempt,
  maxAttempts,
  stage: carriedStage,
  spec,
  context,
  cwd,
  signal,
  endpoint,
  model,
  repairPacket,
  trainingRunId,
  verificationPreflight,
  callTiny,
  appendEvent,
  exec,
  withMutationQueues,
  onAttemptStart
}) {
  let stage = carriedStage;
  let tinyResult = null;
  let applied = null;
  const reached = () => ({ stage, tinyResult, applied });

  const recordAttempt = (outcome, verification) => trainingRunId
    ? captureTrainingRecord({
      cwd,
      appendEvent,
      record: makeImplementationAttemptRecord({
        runId: trainingRunId,
        model,
        attempt,
        spec,
        context: context ?? {},
        repairPacket,
        candidate: tinyResult.candidate,
        verification,
        outcome,
        usage: tinyResult.usage,
        latencyMs: tinyResult.latencyMs
      })
    })
    : null;

  try {
    // A throwing progress callback is classified by the carried-in stage.
    onAttemptStart?.({ attempt, maxAttempts });

    stage = "snapshot";
    const snapshot = await snapshotAllowedFiles(cwd, spec);
    await appendEvent(cwd, { type: "tiny_started", specId: spec.spec_id, model, endpoint, attempt, mode: "execute" });

    stage = "tiny_call";
    tinyResult = await callTiny({ endpoint, model, spec, context: context ?? {}, repairPacket, signal });

    stage = "candidate_validation";
    const candidateCheck = validateCandidate(tinyResult.candidate, spec);
    await appendEvent(cwd, {
      type: "tiny_finished",
      specId: spec.spec_id,
      model,
      attempt,
      latencyMs: tinyResult.latencyMs,
      usage: tinyResult.usage,
      candidateStatus: tinyResult.candidate?.status ?? null,
      candidateValid: candidateCheck.ok,
      validationErrors: candidateCheck.errors,
      mode: "execute"
    });

    if (!candidateCheck.ok) {
      await recordAttempt("invalid_candidate", null);
      return { kind: "invalid_model_output", source: "candidate", ...reached(), validationErrors: candidateCheck.errors };
    }

    if (tinyResult.candidate.status !== "candidate") {
      await recordAttempt(tinyResult.candidate.status, null);
      return { kind: "terminal_model_status", ...reached() };
    }

    stage = "candidate_record";
    const record = { spec, candidate: tinyResult.candidate, snapshot, attempt, model, usage: tinyResult.usage };
    const candidateRecord = await saveCandidateRecord(cwd, record);
    const targetPaths = uniqueAbsolutePaths(cwd, tinyResult.candidate);

    stage = "apply";
    applied = await withMutationQueues(targetPaths, () => applyCandidate(cwd, record));
    await appendEvent(cwd, {
      type: "candidate_applied",
      specId: spec.spec_id,
      attempt,
      changedFiles: applied.changedFiles,
      bytesWritten: applied.bytesWritten,
      candidateRecord
    });

    stage = "verification";
    const verification = await runVerification({ cwd, spec, exec, signal, attempt, preflight: verificationPreflight });
    await recordAttempt(verification.passed ? "verification_passed" : "verification_failed", verification);
    return { kind: verification.passed ? "verification_passed" : "verification_failed", ...reached(), verification };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof TinyModelOutputError) {
      return { kind: "invalid_model_output", source: "tiny_output", ...reached(), error: message };
    }
    return { kind: "runtime_failure", ...reached(), error: message };
  }
}
