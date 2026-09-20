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

export default function offlineEngine(pi: ExtensionAPI) {
  let savedActiveTools: string[] | null = null;
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
    parameters: Type.Object({
      spec: Type.Object({}, { additionalProperties: true }),
      context: Type.Optional(Type.Object({}, { additionalProperties: true }))
    }),
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
      "Keep execute_delegated_implementation scope.allowed_files at two files or fewer.",
      "Provide exact relevant source snippets in context; the tiny model is not a repository explorer."
    ],
    parameters: Type.Object({
      spec: Type.Object({}, { additionalProperties: true }),
      context: Type.Optional(Type.Object({}, { additionalProperties: true }))
    }),
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
      const attempts = [];

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        onUpdate?.({ content: [{ type: "text", text: `Tiny implementation attempt ${attempt}/${maxAttempts}...` }], details: { attempt, maxAttempts } });

        const snapshot = await snapshotAllowedFiles(ctx.cwd, params.spec);
        await appendEvent(ctx.cwd, { type: "tiny_started", specId: params.spec.spec_id, model, endpoint, attempt, mode: "execute" });

        const result = await callTinyImplementer({
          endpoint,
          model,
          spec: params.spec,
          context: params.context ?? {},
          repairPacket,
          signal
        });

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

        const record = { spec: params.spec, candidate: result.candidate, snapshot, attempt, model, usage: result.usage };
        const candidateRecord = await saveCandidateRecord(ctx.cwd, record);
        const targetPaths = uniqueAbsolutePaths(ctx.cwd, result.candidate);

        const applied = await withMutationQueues(targetPaths, () => applyCandidate(ctx.cwd, record));
        await appendEvent(ctx.cwd, {
          type: "candidate_applied",
          specId: params.spec.spec_id,
          attempt,
          changedFiles: applied.changedFiles,
          bytesWritten: applied.bytesWritten,
          candidateRecord
        });

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
            content: [{ type: "text", text: JSON.stringify({ status: "verified", attempt, changedFiles: applied.changedFiles, verification }, null, 2) }],
            details: { success: true, attempt, attempts, verification }
          };
        }

        repairPacket = buildRepairPacket({ spec: params.spec, attempt, candidate: result.candidate, verification });
        await appendEvent(ctx.cwd, { type: "repair_packet_created", specId: params.spec.spec_id, attempt, diagnostics: repairPacket.verification.diagnostics.length });
      }

      await appendEvent(ctx.cwd, { type: "delegated_implementation_escalated", specId: params.spec.spec_id, attempts: maxAttempts });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "needs_main_model",
            reason: "tiny implementation attempts exhausted",
            attempts: maxAttempts,
            verification: lastVerification
          }, null, 2)
        }],
        details: { success: false, escalated: true, attempts, verification: lastVerification }
      };
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
