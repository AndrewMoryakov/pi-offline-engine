// Pi lifecycle subscriptions: first-run endpoint setup, repository capsule
// injection and invalidation, capsule de-duplication in context, the
// code-tool prompt policy and dotnet tool-result compaction. Registration
// order is observable and preserved; state is read and changed only through
// the runtime. Edit routing hooks stay in extensions/pi-lean-edit.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntime } from "./extension-runtime.ts";
import { appendEvent } from "../src/event-log.mjs";
import { compactToolResult } from "../src/tool-result-compactor.mjs";
import { buildRepoCapsule } from "../src/repo-capsule.mjs";
import { applyCodeToolPolicy } from "../src/extension-policy.mjs";
import { discoverEndpoints } from "../src/endpoint-discovery.mjs";
import { autoConfigureIfNeeded } from "../src/engine-setup.mjs";

export function registerLifecycleHooks(pi: ExtensionAPI, runtime: ExtensionRuntime) {
  const state = runtime.state;

  pi.on("session_start", async () => {
    state.lastRepoCapsuleFingerprint = null;
  });

  // First-run setup: while no endpoint is configured (neither env nor config
  // file), look for a local OpenAI-compatible server and persist it. Not
  // awaited, so a filtered port can never delay pi's startup; runs once per
  // process because session switches re-emit session_start.
  pi.on("session_start", async (_event, ctx) => {
    if (state.autoSetupAttempted) return;
    state.autoSetupAttempted = true;
    void autoConfigureIfNeeded({
      settings: runtime.config.settings(),
      discover: () => discoverEndpoints(),
      save: runtime.config.save
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
    state.lastRepoCapsuleFingerprint = null;
  });

  pi.on("session_tree", async () => {
    // Tree navigation can move to a branch without the last injected capsule.
    state.lastRepoCapsuleFingerprint = null;
  });

  pi.on("before_agent_start", async (event) => {
    applyCodeToolPolicy(event.systemPromptOptions);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!state.repoCapsuleEnabled) return;
    const capsule = await buildRepoCapsule({
      cwd: ctx.cwd,
      exec: runtime.exec
    });
    if (!capsule.available || !capsule.text || capsule.fingerprint === state.lastRepoCapsuleFingerprint) return;

    state.lastRepoCapsuleFingerprint = capsule.fingerprint;
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
    if (!state.compactToolResults) return;
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
}
