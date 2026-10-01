// Bounded delegated execution: verification preflight, then up to
// `maxAttempts` TinyCoder attempts (delegation-attempt.mjs), with retry,
// escalation and completion decided here from ordinary state data.
//
// Host-independent: no Pi imports, no UI, no Pi result shapes. The host
// adapter owns spec-level refusal UI (headless refusal, confirmation) and
// formats the returned outcome. Capabilities arrive in one options object:
//   callTiny(request)                TinyCoder transport
//                                    (see createTinyTransport)
//   exec(command, args, options)     process runner for dotnet
//   withMutationQueues(paths, fn)    serializes writes to candidate targets
//   appendEvent(cwd, event)          event-ledger writer
//   onAttemptStart({attempt, maxAttempts})  optional progress callback
//   attachCurrentFiles               send the allowed files' current text
//                                    with every TinyCoder request
//   tinyTimeoutMs                    per-request TinyCoder timeout
//
// Returned outcome kinds: preflight_failure, runtime_failure,
// model_output_escalation, terminal_model_status, verification_passed,
// attempts_exhausted (see src/delegation-results.mjs for their Pi shape).
//
// Error propagation is part of the contract: a failure while writing a
// decision event for an invalid, terminal or verified attempt becomes a
// runtime failure at that attempt's stage, while a failure writing the
// malformed-output retry/escalation, runtime-failure or exhaustion event
// propagates to the caller.

import { validateImplementationSpec } from "./implementation-spec.mjs";
import { preflightVerificationInfrastructure } from "./verification.mjs";
import { buildRepairPacket } from "./repair-packet.mjs";
import { buildRuntimeFailureOutcome, buildTinyTerminalOutcome } from "./delegation-state.mjs";
import { buildModelOutputEscalation, buildModelOutputRepairPacket, canRetryModelOutput } from "./delegation-retry.mjs";
import { addPiUsage, toPiUsage } from "./pi-usage.mjs";
import { createTrainingRunId, hasSensitiveTrainingPath, makeInfrastructureFailureRecord } from "./training-recorder.mjs";
import { captureTrainingRecord, runDelegationAttempt } from "./delegation-attempt.mjs";

export { createTinyTransport } from "./delegation-attempt.mjs";

// Runs before any host confirmation: rejects an invalid spec (throws) and
// opens the training run. A sensitive-path skip is recorded here, i.e. even
// if the host then refuses or the user cancels.
export async function prepareDelegatedExecution({ spec, cwd, trainingCaptureEnabled, appendEvent, newTrainingRunId = createTrainingRunId }) {
  const checked = validateImplementationSpec(spec);
  if (!checked.ok) throw new Error(`ImplementationSpec rejected: ${checked.errors.join("; ")}`);

  const trainingSensitive = hasSensitiveTrainingPath(spec);
  const trainingRunId = trainingCaptureEnabled && !trainingSensitive ? newTrainingRunId(spec.spec_id) : null;
  if (trainingCaptureEnabled && trainingSensitive) {
    await appendEvent(cwd, { type: "training_capture_skipped_sensitive_path", specId: spec.spec_id });
  }
  return { trainingRunId };
}

export async function runDelegatedExecution(options) {
  const { spec, cwd, signal, maxAttempts, trainingRunId, exec, appendEvent } = options;
  const specId = spec.spec_id;

  // The stage survives across attempts: a failure before an attempt sets its
  // first stage is classified by the stage reached previously.
  const state = {
    stage: "verification_preflight",
    repairPacket: null,
    lastVerification: null,
    workspaceModified: false,
    cumulativeChangedFiles: new Set(),
    attempts: [],
    nestedUsage: undefined
  };
  const changedFiles = () => [...state.cumulativeChangedFiles];

  let verificationPreflight;
  try {
    verificationPreflight = await preflightVerificationInfrastructure({ cwd, spec, exec, signal });
  } catch (error) {
    const message = errorMessage(error);
    const outcome = buildRuntimeFailureOutcome({
      stage: state.stage,
      workspaceModified: false,
      error: message,
      attempts: state.attempts,
      changedFiles: []
    });
    await appendEvent(cwd, { type: "delegated_implementation_runtime_failure", specId, attempt: 0, ...outcome });
    if (trainingRunId) {
      await captureTrainingRecord({
        cwd,
        appendEvent,
        record: makeInfrastructureFailureRecord({ runId: trainingRunId, spec, attempt: 0, stage: state.stage, reason: outcome.reason, error: message })
      });
    }
    return { kind: "preflight_failure", outcome, attempts: state.attempts };
  }

  const runtimeFailure = async (attempt, message) => {
    const outcome = buildRuntimeFailureOutcome({
      stage: state.stage,
      workspaceModified: state.workspaceModified,
      error: message,
      attempts: state.attempts,
      changedFiles: changedFiles()
    });
    await appendEvent(cwd, { type: "delegated_implementation_runtime_failure", specId, attempt, ...outcome });
    if (trainingRunId && state.stage !== "candidate_validation") {
      await captureTrainingRecord({
        cwd,
        appendEvent,
        record: makeInfrastructureFailureRecord({ runId: trainingRunId, spec, attempt, stage: state.stage, reason: outcome.reason, error: message })
      });
    }
    return { kind: "runtime_failure", outcome, attempts: state.attempts, nestedUsage: state.nestedUsage };
  };

  const modelOutputEscalation = async ({ reason, stage, attempt, error }) => {
    const outcome = buildModelOutputEscalation({
      reason,
      stage,
      attempt,
      workspaceModified: state.workspaceModified,
      changedFiles: changedFiles(),
      attempts: state.attempts,
      error
    });
    await appendEvent(cwd, { type: "delegated_implementation_escalated", specId, ...outcome });
    return { kind: "model_output_escalation", outcome, attempts: state.attempts, nestedUsage: state.nestedUsage };
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const priorRepairPacket = state.repairPacket;
    const result = await runDelegationAttempt({
      ...options,
      attempt,
      stage: state.stage,
      repairPacket: priorRepairPacket,
      verificationPreflight
    });

    state.stage = result.stage;
    if (result.tinyResult) state.nestedUsage = addPiUsage(state.nestedUsage, toPiUsage(result.tinyResult.usage));
    if (result.applied) {
      state.workspaceModified = true;
      for (const file of result.applied.changedFiles) state.cumulativeChangedFiles.add(file);
    }
    if (result.verification) state.lastVerification = result.verification;

    if (result.kind === "runtime_failure") return runtimeFailure(attempt, result.error);

    if (result.kind === "invalid_model_output" && result.source === "tiny_output") {
      if (canRetryModelOutput({ attempt, maxAttempts })) {
        state.repairPacket = buildModelOutputRepairPacket({ attempt, error: result.error, priorRepairPacket });
        state.attempts.push({ attempt, modelOutputValid: false, verificationPassed: false });
        await appendEvent(cwd, { type: "tiny_model_retry_scheduled", specId, attempt, reason: "invalid_model_output", error: result.error });
        continue;
      }
      return modelOutputEscalation({ reason: "tiny_invalid_output", stage: "tiny_call", attempt, error: result.error });
    }

    const { candidate, usage, latencyMs } = result.tinyResult;
    try {
      if (result.kind === "invalid_model_output") {
        state.attempts.push({ attempt, usage, latencyMs, candidateValid: false, verificationPassed: false });
        if (canRetryModelOutput({ attempt, maxAttempts })) {
          state.repairPacket = buildModelOutputRepairPacket({
            attempt,
            candidate,
            validationErrors: result.validationErrors,
            priorRepairPacket
          });
          await appendEvent(cwd, {
            type: "tiny_model_retry_scheduled",
            specId,
            attempt,
            reason: "invalid_candidate",
            validationErrors: result.validationErrors
          });
          continue;
        }
        return await modelOutputEscalation({
          reason: "tiny_invalid_candidate",
          stage: "candidate_validation",
          attempt,
          error: result.validationErrors.join("; ")
        });
      }

      if (result.kind === "terminal_model_status") {
        const outcome = buildTinyTerminalOutcome({
          terminalStatus: candidate.status,
          reason: candidate.reason ?? null,
          attempt,
          usage,
          workspaceModified: state.workspaceModified,
          changedFiles: changedFiles()
        });
        await appendEvent(cwd, {
          type: state.workspaceModified ? "delegated_implementation_escalated" : "tiny_terminal_status",
          specId,
          attempt,
          ...outcome
        });
        return {
          kind: "terminal_model_status",
          outcome,
          terminalStatus: candidate.status,
          attempt,
          attemptUsage: usage,
          workspaceModified: state.workspaceModified,
          nestedUsage: state.nestedUsage
        };
      }

      const { verification } = result;
      state.attempts.push({ attempt, usage, latencyMs, changedFiles: result.applied.changedFiles, verificationPassed: verification.passed });
      await appendEvent(cwd, {
        type: "verification_finished",
        specId,
        attempt,
        passed: verification.passed,
        checks: verification.checks.map((x) => ({ kind: x.kind, passed: x.passed, code: x.code, artifact: x.artifact }))
      });

      if (verification.passed) {
        await appendEvent(cwd, { type: "delegated_verification_passed", specId, attempt });
        return {
          kind: "verification_passed",
          attempt,
          attempts: state.attempts,
          changedFiles: changedFiles().sort(),
          verification,
          nestedUsage: state.nestedUsage
        };
      }

      state.repairPacket = buildRepairPacket({ spec, attempt, candidate, verification });
      await appendEvent(cwd, { type: "repair_packet_created", specId, attempt, diagnostics: state.repairPacket.verification.diagnostics.length });
    } catch (error) {
      return runtimeFailure(attempt, errorMessage(error));
    }
  }

  await appendEvent(cwd, { type: "delegated_implementation_escalated", specId, attempts: maxAttempts });
  return {
    kind: "attempts_exhausted",
    maxAttempts,
    workspaceModified: state.workspaceModified,
    changedFiles: changedFiles().sort(),
    attempts: state.attempts,
    verification: state.lastVerification,
    nestedUsage: state.nestedUsage
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
