// Pi adapters for the two delegation tools: tool metadata, translation of Pi
// execution arguments into workflow input, the interactive confirmation and
// progress boundary, the headless refusal, and formatting of workflow
// outcomes into Pi content/details/usage.
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DelegationParametersSchema } from "./delegation-schema.ts";
import type { ExtensionRuntime } from "./extension-runtime.ts";
import { validateImplementationSpec, validateCandidate } from "../src/implementation-spec.mjs";
import { callTinyImplementer, TinyModelOutputError } from "../src/tiny-client.mjs";
import { appendEvent } from "../src/event-log.mjs";
import { snapshotAllowedFiles, resolveInside } from "../src/workspace-snapshot.mjs";
import { saveCandidateRecord } from "../src/candidate-store.mjs";
import { applyCandidate } from "../src/apply-candidate.mjs";
import { preflightVerificationInfrastructure, runVerification } from "../src/verification.mjs";
import { buildRepairPacket } from "../src/repair-packet.mjs";
import { buildRuntimeFailureOutcome, buildTinyTerminalOutcome } from "../src/delegation-state.mjs";
import {
  buildModelOutputEscalation,
  buildModelOutputRepairPacket,
  canRetryModelOutput
} from "../src/delegation-retry.mjs";
import { addPiUsage, toPiUsage } from "../src/pi-usage.mjs";
import {
  createTrainingRunId,
  hasSensitiveTrainingPath,
  makeImplementationAttemptRecord,
  makeInfrastructureFailureRecord,
  safeAppendTrainingRecord
} from "../src/training-recorder.mjs";
import { runCandidateDelegation } from "../src/delegation-candidate-workflow.mjs";
import { formatCancelledResult, formatCandidateResult, formatExecutionResult } from "../src/delegation-results.mjs";

export function registerDelegationTools(pi: ExtensionAPI, runtime: ExtensionRuntime) {
  pi.registerTool({
    name: "delegate_implementation",
    label: "Delegate implementation",
    description: "Ask the small local coding model for a bounded candidate without modifying files.",
    promptSnippet: "Delegate a precise bounded code change to the local tiny implementer without applying it",
    promptGuidelines: [
      "Use delegate_implementation only after you understand the problem and can provide an explicit bounded ImplementationSpec.",
      "When using delegate_implementation, include exact source snippets in its context when the tiny model needs to produce replace_text edits.",
      "Do not use delegate_implementation for architecture decisions, ambiguous work, or broad repository exploration."
    ],
    parameters: DelegationParametersSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const settings = runtime.config.settings();
      const outcome = await runCandidateDelegation({
        spec: params.spec,
        context: params.context,
        cwd: ctx.cwd,
        signal,
        endpoint: settings.endpoint,
        model: settings.model,
        callTiny: tinyTransport(runtime),
        appendEvent
      });
      return formatCandidateResult(outcome);
    }
  });

  pi.registerTool({
    name: "execute_delegated_implementation",
    label: "Execute delegated implementation",
    description: "Run a bounded local TinyCoder implementation loop: candidate, guarded apply, dotnet verification, and up to two cheap repair attempts before returning control.",
    promptSnippet: "Execute a strict ImplementationSpec through the local tiny coding model and deterministic verification",
    promptGuidelines: [
      "Use execute_delegated_implementation only for bounded implementation after architecture and scope are already decided.",
      "Treat execute_delegated_implementation status verification_passed as compiler/test evidence only; inspect the current diff/changed files before deciding the user task is semantically complete.",
      "Keep execute_delegated_implementation scope.allowed_files at two files or fewer.",
      "When using execute_delegated_implementation, provide exact relevant source snippets in context; the tiny model is not a repository explorer.",
      "Call execute_delegated_implementation as the only mutating tool in its assistant turn; do not issue sibling edit, write, or mutating shell calls in parallel."
    ],
    parameters: DelegationParametersSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const checked = validateImplementationSpec(params.spec);
      if (!checked.ok) throw new Error(`ImplementationSpec rejected: ${checked.errors.join("; ")}`);

      const endpoint = runtime.config.settings().endpoint;
      const model = runtime.config.settings().model;
      const maxAttempts = runtime.config.settings().maxAttempts;
      const trainingSensitive = hasSensitiveTrainingPath(params.spec);
      const trainingRunId = runtime.state.trainingCaptureEnabled && !trainingSensitive
        ? createTrainingRunId(params.spec.spec_id)
        : null;

      if (runtime.state.trainingCaptureEnabled && trainingSensitive) {
        await appendEvent(ctx.cwd, {
          type: "training_capture_skipped_sensitive_path",
          specId: params.spec.spec_id
        });
      }

      if (!ctx.hasUI && process.env.PI_OFFLINE_ALLOW_HEADLESS_APPLY !== "1") {
        throw new Error("execute_delegated_implementation requires interactive confirmation; set PI_OFFLINE_ALLOW_HEADLESS_APPLY=1 only in a separately sandboxed workflow");
      }

      if (ctx.hasUI) {
        const approved = await ctx.ui.confirm(
          "Bounded local implementation",
          [
            `Spec: ${params.spec.spec_id}`,
            `Tiny model: ${model}`,
            `Files: ${params.spec.scope.allowed_files.join(", ")}`,
            `Attempts: up to ${maxAttempts}`,
            "Pi will write only inside this declared scope and run the declared dotnet checks."
          ].join("\n")
        );
        if (!approved) {
          return formatCancelledResult();
        }
      }

      let repairPacket = null;
      let lastVerification = null;
      let workspaceModified = false;
      let stage = "not_started";
      const attempts = [];
      const cumulativeChangedFiles = new Set<string>();

      let verificationPreflight = null;
      try {
        stage = "verification_preflight";
        verificationPreflight = await preflightVerificationInfrastructure({
          cwd: ctx.cwd,
          spec: params.spec,
          exec: runtime.exec,
          signal
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const outcome = buildRuntimeFailureOutcome({
          stage,
          workspaceModified: false,
          error: message,
          attempts,
          changedFiles: []
        });
        await appendEvent(ctx.cwd, {
          type: "delegated_implementation_runtime_failure",
          specId: params.spec.spec_id,
          attempt: 0,
          ...outcome
        });
        if (trainingRunId) {
          await captureTrainingRecord(ctx.cwd, makeInfrastructureFailureRecord({
            runId: trainingRunId,
            spec: params.spec,
            attempt: 0,
            stage,
            reason: outcome.reason,
            error: message
          }));
        }
        return formatExecutionResult({ kind: "preflight_failure", outcome, attempts });
      }
      let nestedUsage: any = undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        // Declared outside the try: the catch below chains it into the next
        // model-output repair packet.
        const trainingRepairPacket = repairPacket;
        try {
        onUpdate?.({ content: [{ type: "text", text: `Tiny implementation attempt ${attempt}/${maxAttempts}...` }], details: { attempt, maxAttempts } });

        stage = "snapshot";
        const snapshot = await snapshotAllowedFiles(ctx.cwd, params.spec);
        await appendEvent(ctx.cwd, { type: "tiny_started", specId: params.spec.spec_id, model, endpoint, attempt, mode: "execute" });

        stage = "tiny_call";
        const result = await callTinyImplementer({
          endpoint,
          model,
          spec: params.spec,
          context: params.context ?? {},
          repairPacket,
          apiKey: runtime.config.settings().apiKey,
          signal
        });

        nestedUsage = addPiUsage(nestedUsage, toPiUsage(result.usage));
        stage = "candidate_validation";
        const candidateCheck = validateCandidate(result.candidate, params.spec);
        await appendEvent(ctx.cwd, {
          type: "tiny_finished",
          specId: params.spec.spec_id,
          model,
          attempt,
          latencyMs: result.latencyMs,
          usage: result.usage,
          candidateStatus: result.candidate?.status ?? null,
          candidateValid: candidateCheck.ok,
          validationErrors: candidateCheck.errors,
          mode: "execute"
        });

        if (!candidateCheck.ok) {
          if (trainingRunId) {
            await captureTrainingRecord(ctx.cwd, makeImplementationAttemptRecord({
              runId: trainingRunId,
              model,
              attempt,
              spec: params.spec,
              context: params.context ?? {},
              repairPacket: trainingRepairPacket,
              candidate: result.candidate,
              verification: null,
              outcome: "invalid_candidate",
              usage: result.usage,
              latencyMs: result.latencyMs
            }));
          }

          attempts.push({
            attempt,
            usage: result.usage,
            latencyMs: result.latencyMs,
            candidateValid: false,
            verificationPassed: false
          });

          if (canRetryModelOutput({ attempt, maxAttempts })) {
            repairPacket = buildModelOutputRepairPacket({
              attempt,
              candidate: result.candidate,
              validationErrors: candidateCheck.errors,
              priorRepairPacket: trainingRepairPacket
            });
            await appendEvent(ctx.cwd, {
              type: "tiny_model_retry_scheduled",
              specId: params.spec.spec_id,
              attempt,
              reason: "invalid_candidate",
              validationErrors: candidateCheck.errors
            });
            continue;
          }

          const outcome = buildModelOutputEscalation({
            reason: "tiny_invalid_candidate",
            stage: "candidate_validation",
            attempt,
            workspaceModified,
            changedFiles: [...cumulativeChangedFiles],
            attempts,
            error: candidateCheck.errors.join("; ")
          });
          await appendEvent(ctx.cwd, {
            type: "delegated_implementation_escalated",
            specId: params.spec.spec_id,
            ...outcome
          });
          return formatExecutionResult({ kind: "model_output_escalation", outcome, attempts, nestedUsage });
        }

        if (result.candidate.status !== "candidate") {
          if (trainingRunId) {
            await captureTrainingRecord(ctx.cwd, makeImplementationAttemptRecord({
              runId: trainingRunId,
              model,
              attempt,
              spec: params.spec,
              context: params.context ?? {},
              repairPacket: trainingRepairPacket,
              candidate: result.candidate,
              verification: null,
              outcome: result.candidate.status,
              usage: result.usage,
              latencyMs: result.latencyMs
            }));
          }
          const outcome = buildTinyTerminalOutcome({
            terminalStatus: result.candidate.status,
            reason: result.candidate.reason ?? null,
            attempt,
            usage: result.usage,
            workspaceModified,
            changedFiles: [...cumulativeChangedFiles]
          });

          await appendEvent(ctx.cwd, {
            type: workspaceModified ? "delegated_implementation_escalated" : "tiny_terminal_status",
            specId: params.spec.spec_id,
            attempt,
            ...outcome
          });

          return formatExecutionResult({
            kind: "terminal_model_status",
            outcome,
            terminalStatus: result.candidate.status,
            attempt,
            attemptUsage: result.usage,
            workspaceModified,
            nestedUsage
          });
        }

        stage = "candidate_record";
        const record = { spec: params.spec, candidate: result.candidate, snapshot, attempt, model, usage: result.usage };
        const candidateRecord = await saveCandidateRecord(ctx.cwd, record);
        const targetPaths = uniqueAbsolutePaths(ctx.cwd, result.candidate);

        stage = "apply";
        const applied = await runtime.withMutationQueues(targetPaths, () => applyCandidate(ctx.cwd, record));
        workspaceModified = true;
        for (const file of applied.changedFiles) cumulativeChangedFiles.add(file);
        await appendEvent(ctx.cwd, {
          type: "candidate_applied",
          specId: params.spec.spec_id,
          attempt,
          changedFiles: applied.changedFiles,
          bytesWritten: applied.bytesWritten,
          candidateRecord
        });

        stage = "verification";
        const verification = await runVerification({
          cwd: ctx.cwd,
          spec: params.spec,
          exec: runtime.exec,
          signal,
          attempt,
          preflight: verificationPreflight
        });
        lastVerification = verification;

        if (trainingRunId) {
          await captureTrainingRecord(ctx.cwd, makeImplementationAttemptRecord({
            runId: trainingRunId,
            model,
            attempt,
            spec: params.spec,
            context: params.context ?? {},
            repairPacket: trainingRepairPacket,
            candidate: result.candidate,
            verification,
            outcome: verification.passed ? "verification_passed" : "verification_failed",
            usage: result.usage,
            latencyMs: result.latencyMs
          }));
        }

        attempts.push({
          attempt,
          usage: result.usage,
          latencyMs: result.latencyMs,
          changedFiles: applied.changedFiles,
          verificationPassed: verification.passed
        });

        await appendEvent(ctx.cwd, {
          type: "verification_finished",
          specId: params.spec.spec_id,
          attempt,
          passed: verification.passed,
          checks: verification.checks.map((x) => ({ kind: x.kind, passed: x.passed, code: x.code, artifact: x.artifact }))
        });

        if (verification.passed) {
          await appendEvent(ctx.cwd, { type: "delegated_verification_passed", specId: params.spec.spec_id, attempt });
          return formatExecutionResult({
            kind: "verification_passed",
            attempt,
            attempts,
            changedFiles: [...cumulativeChangedFiles].sort(),
            verification,
            nestedUsage
          });
        }

        repairPacket = buildRepairPacket({ spec: params.spec, attempt, candidate: result.candidate, verification });
        await appendEvent(ctx.cwd, { type: "repair_packet_created", specId: params.spec.spec_id, attempt, diagnostics: repairPacket.verification.diagnostics.length });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          if (error instanceof TinyModelOutputError && canRetryModelOutput({ attempt, maxAttempts })) {
            repairPacket = buildModelOutputRepairPacket({
              attempt,
              error: message,
              priorRepairPacket: trainingRepairPacket
            });
            attempts.push({
              attempt,
              modelOutputValid: false,
              verificationPassed: false
            });
            await appendEvent(ctx.cwd, {
              type: "tiny_model_retry_scheduled",
              specId: params.spec.spec_id,
              attempt,
              reason: "invalid_model_output",
              error: message
            });
            continue;
          }

          if (error instanceof TinyModelOutputError) {
            const outcome = buildModelOutputEscalation({
              reason: "tiny_invalid_output",
              stage: "tiny_call",
              attempt,
              workspaceModified,
              changedFiles: [...cumulativeChangedFiles],
              attempts,
              error: message
            });
            await appendEvent(ctx.cwd, {
              type: "delegated_implementation_escalated",
              specId: params.spec.spec_id,
              ...outcome
            });
            return formatExecutionResult({ kind: "model_output_escalation", outcome, attempts, nestedUsage });
          }

          const outcome = buildRuntimeFailureOutcome({
            stage,
            workspaceModified,
            error: message,
            attempts,
            changedFiles: [...cumulativeChangedFiles]
          });

          await appendEvent(ctx.cwd, {
            type: "delegated_implementation_runtime_failure",
            specId: params.spec.spec_id,
            attempt,
            ...outcome
          });
          if (trainingRunId && stage !== "candidate_validation") {
            await captureTrainingRecord(ctx.cwd, makeInfrastructureFailureRecord({
              runId: trainingRunId,
              spec: params.spec,
              attempt,
              stage,
              reason: outcome.reason,
              error: message
            }));
          }

          return formatExecutionResult({ kind: "runtime_failure", outcome, attempts, nestedUsage });
        }
      }

      await appendEvent(ctx.cwd, { type: "delegated_implementation_escalated", specId: params.spec.spec_id, attempts: maxAttempts });
      return formatExecutionResult({
        kind: "attempts_exhausted",
        maxAttempts,
        workspaceModified,
        changedFiles: [...cumulativeChangedFiles].sort(),
        attempts,
        verification: lastVerification,
        nestedUsage
      });
    }
  });
}

// TinyCoder transport bound to the runtime: the API key is resolved at call
// time, exactly when the request is made.
function tinyTransport(runtime: ExtensionRuntime) {
  return (request: any) => callTinyImplementer({ ...request, apiKey: runtime.config.settings().apiKey });
}

function uniqueAbsolutePaths(cwd: string, candidate: any) {
  const root = path.resolve(cwd);
  return [...new Set(candidate.changes.map((change: any) => resolveInside(root, change.path)))].sort();
}

async function captureTrainingRecord(cwd: string, record: any) {
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
