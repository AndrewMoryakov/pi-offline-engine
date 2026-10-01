// Pi adapters for the two delegation tools: tool metadata, translation of Pi
// execution arguments into workflow input, the interactive confirmation and
// progress boundary, the headless refusal, and formatting of workflow
// outcomes into Pi content/details/usage. The bounded retry/verification
// state machine lives in src/delegation-execution-workflow.mjs.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DelegationParametersSchema } from "./delegation-schema.ts";
import type { ExtensionRuntime } from "./extension-runtime.ts";
import { appendEvent } from "../src/event-log.mjs";
import { runCandidateDelegation } from "../src/delegation-candidate-workflow.mjs";
import {
  createTinyTransport,
  prepareDelegatedExecution,
  runDelegatedExecution
} from "../src/delegation-execution-workflow.mjs";
import { formatCancelledResult, formatCandidateResult, formatExecutionResult } from "../src/delegation-results.mjs";

export function registerDelegationTools(pi: ExtensionAPI, runtime: ExtensionRuntime) {
  // The API key is resolved when each TinyCoder request is made.
  const callTiny = createTinyTransport(() => runtime.config.settings().apiKey);

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
        callTiny,
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
      const { trainingRunId } = await prepareDelegatedExecution({
        spec: params.spec,
        cwd: ctx.cwd,
        trainingCaptureEnabled: runtime.state.trainingCaptureEnabled,
        appendEvent
      });
      const { endpoint, model, maxAttempts } = runtime.config.settings();

      if (!ctx.hasUI && runtime.env.PI_OFFLINE_ALLOW_HEADLESS_APPLY !== "1") {
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
        if (!approved) return formatCancelledResult();
      }

      const outcome = await runDelegatedExecution({
        spec: params.spec,
        context: params.context,
        cwd: ctx.cwd,
        signal,
        endpoint,
        model,
        maxAttempts,
        trainingRunId,
        callTiny,
        exec: runtime.exec,
        withMutationQueues: runtime.withMutationQueues,
        appendEvent,
        onAttemptStart: ({ attempt, maxAttempts: total }: { attempt: number; maxAttempts: number }) => {
          onUpdate?.({ content: [{ type: "text", text: `Tiny implementation attempt ${attempt}/${total}...` }], details: { attempt, maxAttempts: total } });
        }
      });
      return formatExecutionResult(outcome);
    }
  });
}
