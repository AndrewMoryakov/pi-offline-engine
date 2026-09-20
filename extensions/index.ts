import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateImplementationSpec, validateCandidate } from "../src/implementation-spec.mjs";
import { callTinyImplementer } from "../src/tiny-client.mjs";
import { appendEvent } from "../src/event-log.mjs";
import { snapshotAllowedFiles, resolveInside } from "../src/workspace-snapshot.mjs";
import { saveCandidateRecord } from "../src/candidate-store.mjs";
import { applyCandidate } from "../src/apply-candidate.mjs";
import { runVerification } from "../src/verification.mjs";
import { buildRepairPacket } from "../src/repair-packet.mjs";
import { runOfflineDoctor, formatDoctorReport } from "../src/offline-doctor.mjs";
import { buildMinimalToolSet } from "../src/tool-profile.mjs";
import { compactToolResult } from "../src/tool-result-compactor.mjs";
import { buildRepoCapsule } from "../src/repo-capsule.mjs";
import { readOfflineEvents, summarizeOfflineEvents, formatOfflineStats } from "../src/stats.mjs";
import { buildRuntimeFailureOutcome } from "../src/delegation-state.mjs";

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
  pi.registerTool({
    name: "delegate_implementation",
    label: "Delegate implementation",
    description: "Ask the small local coding model for a bounded candidate without modifying files.",
    promptSnippet: "Delegate a precise bounded code change to the local tiny implementer without applying it",
    promptGuidelines: [
      "Use delegate_implementation only after you understand the problem and can provide an explicit bounded ImplementationSpec.",
      "Include exact source snippets in delegate_implementation context when the tiny model needs to produce replace_text edits.",
      "Do not delegate architecture decisions, ambiguous work, or broad repository exploration."
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
        const result = await callTinyImplementer({ endpoint, model, spec: params.spec, context: params.context ?? {}, signal });
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
            details: { accepted: false, candidate: result.candidate, usage: result.usage, latencyMs: result.latencyMs, errors: candidateCheck.errors }
          };
        }

        if (result.candidate.status === "candidate") {
          await saveCandidateRecord(ctx.cwd, { spec: params.spec, candidate: result.candidate, snapshot, attempt: 1, model, usage: result.usage });
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result.candidate, null, 2) }],
          details: { accepted: true, candidate: result.candidate, usage: result.usage, latencyMs: result.latencyMs }
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
      "Treat execute_delegated_implementation status verification_passed as compiler/test evidence only; it is not authority that the user task is semantically complete.",
      "Keep execute_delegated_implementation scope.allowed_files at two files or fewer.",
      "Provide exact relevant source snippets in context; the tiny model is not a repository explorer."
    ],
    parameters: DelegationParametersSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const checked = validateImplementationSpec(params.spec);
      if (!checked.ok) throw new Error(`ImplementationSpec rejected: ${checked.errors.join("; ")}`);

      const endpoint = tinyEndpoint();
      const model = tinyModel();
      const maxAttempts = tinyMaxAttempts();

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

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
          signal
        });

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

        if (!candidateCheck.ok) throw new Error(`Tiny implementer returned an invalid candidate: ${candidateCheck.errors.join("; ")}`);

        if (result.candidate.status !== "candidate") {
          return {
            content: [{ type: "text", text: JSON.stringify({ status: result.candidate.status, attempt, reason: result.candidate.reason ?? null }, null, 2) }],
            details: { success: false, terminalStatus: result.candidate.status, attempt, usage: result.usage }
          };
        }

        stage = "candidate_record";
        const record = { spec: params.spec, candidate: result.candidate, snapshot, attempt, model, usage: result.usage };
        const candidateRecord = await saveCandidateRecord(ctx.cwd, record);
        const targetPaths = uniqueAbsolutePaths(ctx.cwd, result.candidate);

        stage = "apply";
        const applied = await withMutationQueues(targetPaths, () => applyCandidate(ctx.cwd, record));
        workspaceModified = true;
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
          attempt
        });
        lastVerification = verification;

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
          await appendEvent(ctx.cwd, { type: "delegated_implementation_succeeded", specId: params.spec.spec_id, attempt });
          return {
            content: [{ type: "text", text: JSON.stringify({
              status: "verification_passed",
              task_complete: false,
              note: "Compiler/test verification passed; the main reasoner still owns semantic completion.",
              attempt,
              changedFiles: applied.changedFiles,
              verification
            }, null, 2) }],
            details: { success: true, taskComplete: false, attempt, attempts, verification }
          };
        }

        repairPacket = buildRepairPacket({ spec: params.spec, attempt, candidate: result.candidate, verification });
        await appendEvent(ctx.cwd, { type: "repair_packet_created", specId: params.spec.spec_id, attempt, diagnostics: repairPacket.verification.diagnostics.length });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const outcome = buildRuntimeFailureOutcome({
            stage,
            workspaceModified,
            error: message,
            attempts
          });

          await appendEvent(ctx.cwd, {
            type: "delegated_implementation_runtime_failure",
            specId: params.spec.spec_id,
            attempt,
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
              error: outcome.error,
              attempts
            }
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
            attempts: maxAttempts,
            verification: lastVerification
          }, null, 2)
        }],
        details: { success: false, escalated: true, workspaceModified, attempts, verification: lastVerification }
      };
    }
  });

  pi.on("session_start", async () => {
    lastRepoCapsuleFingerprint = null;
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

  pi.registerCommand("offline-doctor", {
    description: "Check local offline readiness",
    handler: async (_args, ctx) => {
      const report = await runOfflineDoctor({
        cwd: ctx.cwd,
        endpoint: tinyEndpoint(),
        model: tinyModel(),
        tools: pi.getAllTools(),
        exec: (command, args, options) => pi.exec(command, args, options)
      });
      ctx.ui.notify(formatDoctorReport(report), report.ready ? "info" : "warning");
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
          `Tiny implementer: ${tinyModel()} @ ${tinyEndpoint()}`,
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

function tinyEndpoint() {
  return process.env.PI_OFFLINE_TINY_ENDPOINT ?? "http://127.0.0.1:8081";
}

function tinyModel() {
  return process.env.PI_OFFLINE_TINY_MODEL ?? "qwen2.5-coder-3b-instruct";
}

function tinyMaxAttempts() {
  const raw = Number.parseInt(process.env.PI_OFFLINE_TINY_MAX_ATTEMPTS ?? "3", 10);
  return Number.isFinite(raw) ? Math.min(3, Math.max(1, raw)) : 3;
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
