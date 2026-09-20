import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateImplementationSpec, validateCandidate } from "../src/implementation-spec.mjs";
import { callTinyImplementer } from "../src/tiny-client.mjs";
import { appendEvent } from "../src/event-log.mjs";

export default function offlineEngine(pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate_implementation",
    label: "Delegate implementation",
    description: "Delegate a tightly scoped implementation specification to a small local coding model. This tool does not apply changes.",
    promptSnippet: "Delegate a precise bounded code change to the local tiny implementer",
    promptGuidelines: [
      "Use delegate_implementation only after you understand the problem and can provide an explicit bounded implementation specification.",
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

      const endpoint = process.env.PI_OFFLINE_TINY_ENDPOINT ?? "http://127.0.0.1:8081";
      const model = process.env.PI_OFFLINE_TINY_MODEL ?? "qwen2.5-coder-3b-instruct";
      const started = { type: "tiny_started", specId: params.spec.spec_id, model, endpoint };
      await appendEvent(ctx.cwd, started);

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
          validationErrors: candidateCheck.errors
        });

        if (!candidateCheck.ok) {
          return {
            content: [{ type: "text", text: `Tiny implementer returned an invalid candidate: ${candidateCheck.errors.join("; ")}` }],
            details: { accepted: false, candidate: result.candidate, usage: result.usage, latencyMs: result.latencyMs, errors: candidateCheck.errors }
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result.candidate, null, 2) }],
          details: { accepted: true, candidate: result.candidate, usage: result.usage, latencyMs: result.latencyMs }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendEvent(ctx.cwd, { type: "tiny_failed", specId: params.spec.spec_id, model, error: message });
        return { content: [{ type: "text", text: `Tiny implementer failed: ${message}` }], details: { accepted: false, error: message } };
      }
    }
  });

  pi.registerCommand("offline-status", {
    description: "Show pi-offline-engine configuration",
    handler: async (_args, ctx) => {
      const endpoint = process.env.PI_OFFLINE_TINY_ENDPOINT ?? "http://127.0.0.1:8081";
      const model = process.env.PI_OFFLINE_TINY_MODEL ?? "qwen2.5-coder-3b-instruct";
      ctx.ui.notify(`Tiny implementer: ${model} @ ${endpoint}\nCandidate application: disabled in v0\nTelemetry: .pi/offline-engine/events.jsonl`, "info");
    }
  });
}
