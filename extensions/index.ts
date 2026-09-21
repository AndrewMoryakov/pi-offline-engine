import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateImplementationSpec, validateCandidate } from "../src/implementation-spec.mjs";
import { callTinyImplementer, TinyModelOutputError } from "../src/tiny-client.mjs";
import { appendEvent } from "../src/event-log.mjs";
import { snapshotAllowedFiles, resolveInside } from "../src/workspace-snapshot.mjs";
import { saveCandidateRecord } from "../src/candidate-store.mjs";
import { applyCandidate } from "../src/apply-candidate.mjs";
import { preflightVerificationInfrastructure, runVerification } from "../src/verification.mjs";
import { buildRepairPacket } from "../src/repair-packet.mjs";
import { runOfflineDoctor, formatDoctorReport, checkEndpointLocality } from "../src/offline-doctor.mjs";
import { buildMinimalToolSet } from "../src/tool-profile.mjs";
import { compactToolResult } from "../src/tool-result-compactor.mjs";
import { buildRepoCapsule } from "../src/repo-capsule.mjs";
import { readOfflineEvents, summarizeOfflineEvents, formatOfflineStats } from "../src/stats.mjs";
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
  safeAppendTrainingRecord,
  trainingCaptureStatus
} from "../src/training-recorder.mjs";
import { exportTrainingData } from "../src/training-exporter.mjs";
import { applyCodeToolPolicy, selectActiveToolObjects } from "../src/extension-policy.mjs";
import { engineConfigPath, readEngineConfig, resolveEngineSettings, writeEngineConfig } from "../src/engine-config.mjs";
import { discoverEndpoints, probeEndpoint } from "../src/endpoint-discovery.mjs";
import {
  autoConfigureIfNeeded,
  configureFromSetupArgs,
  describeDiscoveryFailure,
  formatEngineStatus,
  parseSetupArgs
} from "../src/engine-setup.mjs";

// User-level engine config (endpoint/model chosen by /offline-setup or by the
// first-run discovery). Environment variables still override it.
const engineConfigFile = engineConfigPath(getAgentDir());
let engineConfigState = readEngineConfig(engineConfigFile);

function reloadEngineConfig() {
  engineConfigState = readEngineConfig(engineConfigFile);
}

function engineSettings() {
  return resolveEngineSettings({ env: process.env, config: engineConfigState.config });
}

function saveEngineConfig(patch: Record<string, unknown>) {
  writeEngineConfig(engineConfigFile, patch);
  reloadEngineConfig();
}

const NonEmptyString = Type.String({ minLength: 1 });

const VerificationSchema = Type.Object({
  build: Type.Optional(Type.Object({
    project: NonEmptyString
  }, { additionalProperties: false })),
  tests: Type.Optional(Type.Object({
    project: NonEmptyString,
    names: Type.Optional(Type.Array(NonEmptyString))
  }, { additionalProperties: false }))
}, { additionalProperties: false });

const ImplementationSpecSchema = Type.Object({
  version: Type.Literal(1),
  spec_id: NonEmptyString,
  operation: Type.Literal("modify_symbol"),
  goal: Type.Object({
    summary: NonEmptyString
  }, { additionalProperties: false }),
  target: Type.Object({
    file: NonEmptyString,
    symbol: NonEmptyString
  }, { additionalProperties: false }),
  requirements: Type.Array(NonEmptyString, { minItems: 1 }),
  preserve: Type.Optional(Type.Array(NonEmptyString)),
  scope: Type.Object({
    allowed_files: Type.Array(NonEmptyString, { minItems: 1, maxItems: 2 }),
    allow_new_files: Type.Boolean(),
    allow_dependencies: Type.Boolean(),
    allow_public_api_change: Type.Boolean()
  }, { additionalProperties: false }),
  verification: VerificationSchema
}, { additionalProperties: false });

const DelegationParametersSchema = Type.Object({
  spec: ImplementationSpecSchema,
  context: Type.Optional(Type.Object({}, { additionalProperties: true }))
}, { additionalProperties: false });

export default function offlineEngine(pi: ExtensionAPI) {
  let savedActiveTools: string[] | null = null;
  let compactToolResults = process.env.PI_OFFLINE_COMPACT_TOOL_RESULTS !== "0";
  let repoCapsuleEnabled = process.env.PI_OFFLINE_REPO_CAPSULE !== "0";
  let lastRepoCapsuleFingerprint: string | null = null;
  let trainingCaptureEnabled = process.env.PI_OFFLINE_TRAINING_CAPTURE === "1";
  let autoSetupAttempted = false;

  // The bundled pi-knowledge reads its settings lazily from the environment.
  // Apply the profile's slow-local-model search default unless the user chose
  // one. PI_KNOWLEDGE_OFFLINE is deliberately not forced: it would block the
  // first download of the local embedding model. /offline-status reports this,
  // so the write into another package's environment is never silent.
  const knowledgeProfileSource = process.env.PI_KNOWLEDGE_SEARCH_PROFILE === undefined ? "default" : "env";
  process.env.PI_KNOWLEDGE_SEARCH_PROFILE ??= "low_token";
  const companionEnv = [{
    name: "PI_KNOWLEDGE_SEARCH_PROFILE",
    value: process.env.PI_KNOWLEDGE_SEARCH_PROFILE,
    source: knowledgeProfileSource
  }];
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
      const checked = validateImplementationSpec(params.spec);
      if (!checked.ok) {
        return { content: [{ type: "text", text: `ImplementationSpec rejected: ${checked.errors.join("; ")}` }], details: { accepted: false, errors: checked.errors } };
      }

      const endpoint = tinyEndpoint();
      const model = tinyModel();
      const snapshot = await snapshotAllowedFiles(ctx.cwd, params.spec);
      await appendEvent(ctx.cwd, { type: "tiny_started", specId: params.spec.spec_id, model, endpoint, mode: "candidate_only" });

      try {
        const result = await callTinyImplementer({ endpoint, model, spec: params.spec, context: params.context ?? {}, apiKey: tinyApiKey(), signal });
        const candidateCheck = validateCandidate(result.candidate, params.spec);
        await appendEvent(ctx.cwd, {
          type: "tiny_finished",
          specId: params.spec.spec_id,
          model,
          latencyMs: result.latencyMs,
          usage: result.usage,
          candidateStatus: result.candidate?.status ?? null,
          candidateValid: candidateCheck.ok,
          validationErrors: candidateCheck.errors,
          mode: "candidate_only"
        });

        if (!candidateCheck.ok) {
          return {
            content: [{ type: "text", text: `Tiny implementer returned an invalid candidate: ${candidateCheck.errors.join("; ")}` }],
            details: { accepted: false, candidate: result.candidate, usage: result.usage, latencyMs: result.latencyMs, errors: candidateCheck.errors },
            usage: toPiUsage(result.usage)
          };
        }

        if (result.candidate.status === "candidate") {
          await saveCandidateRecord(ctx.cwd, { spec: params.spec, candidate: result.candidate, snapshot, attempt: 1, model, usage: result.usage });
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result.candidate, null, 2) }],
          details: { accepted: true, candidate: result.candidate, usage: result.usage, latencyMs: result.latencyMs },
          usage: toPiUsage(result.usage)
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendEvent(ctx.cwd, { type: "tiny_failed", specId: params.spec.spec_id, model, error: message, mode: "candidate_only" });
        throw new Error(`Tiny implementer failed: ${message}`);
      }
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

      const endpoint = tinyEndpoint();
      const model = tinyModel();
      const maxAttempts = tinyMaxAttempts();
      const trainingSensitive = hasSensitiveTrainingPath(params.spec);
      const trainingRunId = trainingCaptureEnabled && !trainingSensitive
        ? createTrainingRunId(params.spec.spec_id)
        : null;

      if (trainingCaptureEnabled && trainingSensitive) {
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
          return { content: [{ type: "text", text: "Delegated implementation cancelled by user." }], details: { cancelled: true } };
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
          exec: (command, args, options) => pi.exec(command, args, options),
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
        return {
          content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
          details: {
            success: false,
            escalated: true,
            reason: outcome.reason,
            stage: outcome.stage,
            workspaceModified: false,
            error: outcome.error,
            attempts
          }
        };
      }
      let nestedUsage: any = undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
        onUpdate?.({ content: [{ type: "text", text: `Tiny implementation attempt ${attempt}/${maxAttempts}...` }], details: { attempt, maxAttempts } });

        stage = "snapshot";
        const snapshot = await snapshotAllowedFiles(ctx.cwd, params.spec);
        await appendEvent(ctx.cwd, { type: "tiny_started", specId: params.spec.spec_id, model, endpoint, attempt, mode: "execute" });

        const trainingRepairPacket = repairPacket;
        stage = "tiny_call";
        const result = await callTinyImplementer({
          endpoint,
          model,
          spec: params.spec,
          context: params.context ?? {},
          repairPacket,
          apiKey: tinyApiKey(),
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
          return {
            content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
            details: {
              success: false,
              escalated: true,
              reason: outcome.reason,
              stage: outcome.stage,
              workspaceModified: outcome.workspace_modified,
              changedFiles: outcome.changed_files,
              attempts
            },
            usage: nestedUsage
          };
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

          return {
            content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
            details: {
              success: false,
              escalated: workspaceModified,
              terminalStatus: result.candidate.status,
              attempt,
              usage: result.usage,
              workspaceModified: outcome.workspace_modified,
              changedFiles: outcome.changed_files
            },
            usage: nestedUsage
          };
        }

        stage = "candidate_record";
        const record = { spec: params.spec, candidate: result.candidate, snapshot, attempt, model, usage: result.usage };
        const candidateRecord = await saveCandidateRecord(ctx.cwd, record);
        const targetPaths = uniqueAbsolutePaths(ctx.cwd, result.candidate);

        stage = "apply";
        const applied = await withMutationQueues(targetPaths, () => applyCandidate(ctx.cwd, record));
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
          exec: (command, args, options) => pi.exec(command, args, options),
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
          return {
            content: [{ type: "text", text: JSON.stringify({
              status: "verification_passed",
              task_complete: false,
              note: "Compiler/test verification passed; the main reasoner still owns semantic completion.",
              attempt,
              changedFiles: [...cumulativeChangedFiles].sort(),
              verification
            }, null, 2) }],
            details: {
              success: true,
              taskComplete: false,
              attempt,
              attempts,
              changedFiles: [...cumulativeChangedFiles].sort(),
              verification
            },
            usage: nestedUsage
          };
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
            return {
              content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
              details: {
                success: false,
                escalated: true,
                reason: outcome.reason,
                stage: outcome.stage,
                workspaceModified: outcome.workspace_modified,
                changedFiles: outcome.changed_files,
                attempts
              },
              usage: nestedUsage
            };
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

          return {
            content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
            details: {
              success: false,
              escalated: true,
              reason: outcome.reason,
              stage: outcome.stage,
              workspaceModified: outcome.workspace_modified,
              workspaceStateUncertain: outcome.workspace_state_uncertain,
              changedFiles: outcome.changed_files,
              error: outcome.error,
              attempts
            },
            usage: nestedUsage
          };
        }
      }

      await appendEvent(ctx.cwd, { type: "delegated_implementation_escalated", specId: params.spec.spec_id, attempts: maxAttempts });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "needs_main_model",
            reason: "tiny_implementation_attempts_exhausted",
            workspace_modified: workspaceModified,
            changed_files: [...cumulativeChangedFiles].sort(),
            attempts: maxAttempts,
            verification: lastVerification
          }, null, 2)
        }],
        details: {
          success: false,
          escalated: true,
          workspaceModified,
          changedFiles: [...cumulativeChangedFiles].sort(),
          attempts,
          verification: lastVerification
        },
        usage: nestedUsage
      };
    }
  });

  pi.on("session_start", async () => {
    lastRepoCapsuleFingerprint = null;
  });

  // First-run setup: while no endpoint is configured (neither env nor config
  // file), look for a local OpenAI-compatible server and persist it. Not
  // awaited, so a filtered port can never delay pi's startup; runs once per
  // process because session switches re-emit session_start.
  pi.on("session_start", async (_event, ctx) => {
    if (autoSetupAttempted) return;
    autoSetupAttempted = true;
    void autoConfigureIfNeeded({
      settings: engineSettings(),
      discover: () => discoverEndpoints(),
      save: saveEngineConfig
    }).then((result) => {
      if (result.action === "skipped" || !result.message || !ctx.hasUI) return;
      ctx.ui.notify(result.message, result.action === "configured" ? "info" : "warning");
    }).catch(() => {
      // Discovery failures are reported by /offline-setup and /offline-doctor;
      // they must never surface as an unhandled rejection during startup.
    });
  });

  pi.on("session_compact", async () => {
    // Compaction can remove the prior hidden capsule from replay context.
    // Force a fresh deterministic capsule on the next user prompt.
    lastRepoCapsuleFingerprint = null;
  });

  pi.on("session_tree", async () => {
    // Tree navigation can move to a branch without the last injected capsule.
    lastRepoCapsuleFingerprint = null;
  });

  pi.on("before_agent_start", async (event) => {
    applyCodeToolPolicy(event.systemPromptOptions);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!repoCapsuleEnabled) return;
    const capsule = await buildRepoCapsule({
      cwd: ctx.cwd,
      exec: (command, args, options) => pi.exec(command, args, options)
    });
    if (!capsule.available || !capsule.text || capsule.fingerprint === lastRepoCapsuleFingerprint) return;

    lastRepoCapsuleFingerprint = capsule.fingerprint;
    await appendEvent(ctx.cwd, {
      type: "repo_capsule_injected",
      fingerprint: capsule.fingerprint,
      dirtyFiles: capsule.facts?.dirty.length ?? 0,
      projectFiles: capsule.facts?.projectFiles.length ?? 0
    });

    return {
      message: {
        customType: "pi-offline-repo-capsule",
        content: capsule.text,
        display: false
      }
    };
  });

  pi.on("context", async (event) => {
    let latest = -1;
    for (let index = 0; index < event.messages.length; index += 1) {
      if ((event.messages[index] as any)?.customType === "pi-offline-repo-capsule") latest = index;
    }
    if (latest < 0) return;
    return {
      messages: event.messages.filter((message, index) =>
        (message as any)?.customType !== "pi-offline-repo-capsule" || index === latest
      )
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!compactToolResults) return;
    const compacted = await compactToolResult({
      cwd: ctx.cwd,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
      content: event.content
    });
    if (!compacted) return;

    await appendEvent(ctx.cwd, {
      type: "tool_result_compacted",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      artifact: compacted.artifact,
      originalChars: compacted.originalChars,
      originalLines: compacted.originalLines,
      compactedChars: compacted.content?.[0]?.type === "text" ? compacted.content[0].text.length : 0
    });
    return { content: compacted.content };
  });

  pi.registerCommand("offline-context", {
    description: "Use /offline-context on|off|refresh|status for deterministic repository context",
    handler: async (args, ctx) => {
      const mode = String(args ?? "").trim().toLowerCase() || "status";
      if (mode === "on") repoCapsuleEnabled = true;
      else if (mode === "off") repoCapsuleEnabled = false;
      else if (mode === "refresh") {
        repoCapsuleEnabled = true;
        lastRepoCapsuleFingerprint = null;
      } else if (mode !== "status") {
        ctx.ui.notify("Usage: /offline-context on|off|refresh|status", "warning");
        return;
      }
      ctx.ui.notify(`Repository context capsule: ${repoCapsuleEnabled ? "on" : "off"}${mode === "refresh" ? " (will refresh on next prompt)" : ""}`, "info");
    }
  });

  pi.registerCommand("offline-compact", {
    description: "Use /offline-compact on|off|status for deterministic dotnet output compaction",
    handler: async (args, ctx) => {
      const mode = String(args ?? "").trim().toLowerCase() || "status";
      if (mode === "on") compactToolResults = true;
      else if (mode === "off") compactToolResults = false;
      else if (mode !== "status") {
        ctx.ui.notify("Usage: /offline-compact on|off|status", "warning");
        return;
      }
      ctx.ui.notify(`Dotnet tool-result compaction: ${compactToolResults ? "on" : "off"}`, "info");
    }
  });

  async function notifyDoctorReport(ctx: any) {
    const activeTools = selectActiveToolObjects(pi.getAllTools(), pi.getActiveTools());
    const report = await runOfflineDoctor({
      cwd: ctx.cwd,
      endpoint: tinyEndpoint(),
      model: tinyModel(),
      apiKey: tinyApiKey(),
      tools: activeTools,
      exec: (command, args, options) => pi.exec(command, args, options)
    });
    ctx.ui.notify(formatDoctorReport(report), report.ready ? "info" : "warning");
  }

  pi.registerCommand("offline-doctor", {
    description: "Check local offline readiness",
    handler: async (_args, ctx) => {
      await notifyDoctorReport(ctx);
    }
  });

  pi.registerCommand("offline-setup", {
    description: "Configure the TinyCoder endpoint: /offline-setup [reset | <endpoint-url> [model]]",
    handler: async (args, ctx) => {
      const request = parseSetupArgs(args);

      if (request.mode === "invalid") {
        ctx.ui.notify(request.message, "warning");
        return;
      }

      if (request.mode === "reset") {
        saveEngineConfig({ endpoint: null, model: null, backend: null, configuredBy: null, configuredAt: null });
        ctx.ui.notify(`Engine config cleared: ${engineConfigFile}`, "info");
        return;
      }

      if (request.mode === "manual") {
        const result = await configureFromSetupArgs({ request, probe: probeEndpoint, save: saveEngineConfig });
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
        if (!result.ok) return;
      } else {
        const discovery = await discoverEndpoints();
        if (discovery.usable.length === 0) {
          ctx.ui.notify(describeDiscoveryFailure(discovery), "warning");
          return;
        }

        let chosen = discovery.selected;
        if (discovery.usable.length > 1 && ctx.hasUI) {
          const options = discovery.usable.map((x: any) => `${x.model} @ ${x.endpoint} (${x.label})`);
          const picked = await ctx.ui.select("Choose the TinyCoder backend", options);
          const index = options.indexOf(picked);
          if (index < 0) {
            ctx.ui.notify("Setup cancelled; nothing was saved.", "info");
            return;
          }
          chosen = discovery.usable[index];
        }

        saveEngineConfig({
          endpoint: chosen.endpoint,
          model: chosen.model,
          backend: chosen.label,
          configuredBy: "offline-setup",
          configuredAt: new Date().toISOString()
        });
        ctx.ui.notify(`Saved TinyCoder ${chosen.model} @ ${chosen.endpoint} (${chosen.label}).`, "info");
      }

      const sources = engineSettings().sources;
      if (sources.endpoint === "env" || sources.model === "env") {
        ctx.ui.notify(
          "Note: PI_OFFLINE_TINY_ENDPOINT / PI_OFFLINE_TINY_MODEL are set in the environment and still override the saved config.",
          "warning"
        );
      }
      await notifyDoctorReport(ctx);
    }
  });

  pi.registerCommand("offline-tools", {
    description: "Use /offline-tools minimal|restore|status to control the local-model tool surface",
    handler: async (args, ctx) => {
      const mode = String(args ?? "").trim().toLowerCase() || "status";
      if (mode === "minimal") {
        if (!savedActiveTools) savedActiveTools = pi.getActiveTools();
        const minimal = buildMinimalToolSet(pi.getAllTools());
        pi.setActiveTools(minimal);
        ctx.ui.notify(`Offline minimal tools enabled (${minimal.length}): ${minimal.join(", ")}`, "info");
        return;
      }
      if (mode === "restore") {
        if (!savedActiveTools) {
          ctx.ui.notify("No saved tool set to restore.", "warning");
          return;
        }
        pi.setActiveTools(savedActiveTools);
        ctx.ui.notify(`Restored ${savedActiveTools.length} tools.`, "info");
        savedActiveTools = null;
        return;
      }
      ctx.ui.notify(`Active tools (${pi.getActiveTools().length}): ${pi.getActiveTools().join(", ")}`, "info");
    }
  });

  pi.registerCommand("offline-training", {
    description: "Use /offline-training on|off|status|export for opt-in local training trace capture",
    handler: async (args, ctx) => {
      const mode = String(args ?? "").trim().toLowerCase() || "status";
      if (mode === "on") {
        trainingCaptureEnabled = true;
        ctx.ui.notify(
          "Training capture enabled. Exact bounded specs, context, TinyCoder candidates and verification labels will be stored locally under .pi/offline-engine/training/raw.jsonl. Sensitive-path captures are blocked automatically.",
          "warning"
        );
        return;
      }
      if (mode === "off") {
        trainingCaptureEnabled = false;
        ctx.ui.notify("Training capture disabled.", "info");
        return;
      }
      if (mode === "export") {
        const result = await exportTrainingData({ cwd: ctx.cwd });
        ctx.ui.notify(
          [
            "Training export complete.",
            `SFT: ${result.sft_examples}`,
            `Unpaired preference: ${result.preference_examples}`,
            `Paired preference: ${result.paired_preference_examples}`,
            `Eval: ${result.eval_examples}`,
            `Dropped sensitive/duplicate/incomplete: ${result.dropped_sensitive}/${result.dropped_duplicate}/${result.dropped_incomplete}`,
            `Manifest: ${result.manifest}`
          ].join("\n"),
          "info"
        );
        return;
      }
      if (mode !== "status") {
        ctx.ui.notify("Usage: /offline-training on|off|status|export", "warning");
        return;
      }
      const status = trainingCaptureStatus({ enabled: trainingCaptureEnabled });
      ctx.ui.notify(
        [
          `Training capture: ${status.enabled ? "on" : "off"}`,
          `Raw trace: ${status.rawPath}`,
          "Capture is opt-in and stores exact bounded context; obvious secret-bearing paths are blocked."
        ].join("\n"),
        "info"
      );
    }
  });

  pi.registerCommand("offline-stats", {
    description: "Show local TinyCoder and context-saving statistics",
    handler: async (_args, ctx) => {
      const { events } = await readOfflineEvents(ctx.cwd);
      ctx.ui.notify(formatOfflineStats(summarizeOfflineEvents(events)), "info");
    }
  });

  pi.registerCommand("offline-status", {
    description: "Show pi-offline-engine configuration",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        [
          formatEngineStatus({
            settings: engineSettings(),
            configFile: engineConfigFile,
            configError: engineConfigState.error,
            companionEnv
          }),
          `Endpoint locality: ${checkEndpointLocality(tinyEndpoint()).message}`,
          `Implementer auth: ${tinyApiKey() ? "bearer key configured" : "none (local endpoint)"}`,
          `Bounded execute attempts: ${tinyMaxAttempts()}`,
          "Candidate apply: exact replace_text/create_file with stale preimage protection",
          "Verification: declared dotnet build/tests, --no-restore",
          "Telemetry: .pi/offline-engine/events.jsonl"
        ].join("\n"),
        "info"
      );
    }
  });
}

// Precedence for all four: environment > engine config file > built-in default
// (see src/engine-config.mjs).
function tinyEndpoint() {
  return engineSettings().endpoint;
}

function tinyModel() {
  return engineSettings().model;
}

// Empty when the implementer is a local llama.cpp. OPENROUTER_API_KEY is
// honoured so an already-exported key needs no duplication. Keys are read from
// the environment only; the config file never stores them.
function tinyApiKey() {
  return engineSettings().apiKey;
}

function tinyMaxAttempts() {
  return engineSettings().maxAttempts;
}

function uniqueAbsolutePaths(cwd: string, candidate: any) {
  const root = path.resolve(cwd);
  return [...new Set(candidate.changes.map((change: any) => resolveInside(root, change.path)))].sort();
}

async function withMutationQueues<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  let wrapped = fn;
  for (const target of [...paths].reverse()) {
    const next = wrapped;
    wrapped = () => withFileMutationQueue(target, next);
  }
  return wrapped();
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
