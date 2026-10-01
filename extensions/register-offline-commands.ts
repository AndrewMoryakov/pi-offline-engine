// The eight /offline-* commands and the shared doctor report. Session toggles
// are changed only through the runtime state; configuration through the
// runtime config facade.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntime } from "./extension-runtime.ts";
import { runOfflineDoctor, formatDoctorReport, checkEndpointLocality } from "../src/offline-doctor.mjs";
import { buildMinimalToolSet } from "../src/tool-profile.mjs";
import { readOfflineEvents, summarizeOfflineEvents, formatOfflineStats } from "../src/stats.mjs";
import { trainingCaptureStatus } from "../src/training-recorder.mjs";
import { exportTrainingData } from "../src/training-exporter.mjs";
import { selectActiveToolObjects } from "../src/extension-policy.mjs";
import { discoverEndpoints, probeEndpoint } from "../src/endpoint-discovery.mjs";
import {
  configureFromSetupArgs,
  describeDiscoveryFailure,
  formatEngineStatus,
  parseSetupArgs
} from "../src/engine-setup.mjs";

export function registerOfflineCommands(pi: ExtensionAPI, runtime: ExtensionRuntime) {
  const state = runtime.state;

  pi.registerCommand("offline-context", {
    description: "Add git repo snapshot to prompts",
    getArgumentCompletions: argumentChoices([
      ["status", "Show whether the repository snapshot is added to prompts"],
      ["on", "Add branch, HEAD, changed files and .sln/.csproj list whenever they change"],
      ["off", "Stop adding the repository snapshot"],
      ["refresh", "Turn the snapshot on and resend it with the next prompt"]
    ]),
    handler: async (args, ctx) => {
      const mode = String(args ?? "").trim().toLowerCase() || "status";
      if (mode === "on") state.repoCapsuleEnabled = true;
      else if (mode === "off") state.repoCapsuleEnabled = false;
      else if (mode === "refresh") {
        state.repoCapsuleEnabled = true;
        state.lastRepoCapsuleFingerprint = null;
      } else if (mode !== "status") {
        ctx.ui.notify("Usage: /offline-context on|off|refresh|status", "warning");
        return;
      }
      ctx.ui.notify(`Repository context capsule: ${state.repoCapsuleEnabled ? "on" : "off"}${mode === "refresh" ? " (will refresh on next prompt)" : ""}`, "info");
    }
  });

  pi.registerCommand("offline-compact", {
    description: "Shorten dotnet build/test output",
    getArgumentCompletions: argumentChoices([
      ["status", "Show whether dotnet build/test output is shortened"],
      ["on", "Large output: send errors/failed tests only, full log to .pi/offline-engine/tool-results"],
      ["off", "Send dotnet build/test output to the model in full"]
    ]),
    handler: async (args, ctx) => {
      const mode = String(args ?? "").trim().toLowerCase() || "status";
      if (mode === "on") state.compactToolResults = true;
      else if (mode === "off") state.compactToolResults = false;
      else if (mode !== "status") {
        ctx.ui.notify("Usage: /offline-compact on|off|status", "warning");
        return;
      }
      ctx.ui.notify(`Dotnet tool-result compaction: ${state.compactToolResults ? "on" : "off"}`, "info");
    }
  });

  async function notifyDoctorReport(ctx: any) {
    const allTools = pi.getAllTools();
    const activeTools = selectActiveToolObjects(allTools, pi.getActiveTools());
    const report = await runOfflineDoctor({
      cwd: ctx.cwd,
      endpoint: runtime.config.settings().endpoint,
      model: runtime.config.settings().model,
      apiKey: runtime.config.settings().apiKey,
      tools: activeTools,
      editProvider: runtime.editProviderAtLoad,
      scriptEditPolicy: runtime.scriptEditPolicyAtLoad,
      allTools,
      sessionModel: ctx.model,
      exec: runtime.exec
    });
    ctx.ui.notify(formatDoctorReport(report), report.ready ? "info" : "warning");
  }

  pi.registerCommand("offline-doctor", {
    description: "Check TinyCoder, dotnet, LSP, search",
    handler: async (_args, ctx) => {
      await notifyDoctorReport(ctx);
    }
  });

  pi.registerCommand("offline-setup", {
    description: "Find/save TinyCoder server, or reset",
    // Nothing on an empty prefix: Enter would otherwise insert "reset".
    getArgumentCompletions: (prefix) =>
      prefix.trim()
        ? argumentChoices([["reset", "Forget the saved TinyCoder endpoint and model"]])(prefix)
        : null,
    handler: async (args, ctx) => {
      const request = parseSetupArgs(args);

      if (request.mode === "invalid") {
        ctx.ui.notify(request.message, "warning");
        return;
      }

      if (request.mode === "reset") {
        runtime.config.save({ endpoint: null, model: null, backend: null, configuredBy: null, configuredAt: null });
        ctx.ui.notify(`Engine config cleared: ${runtime.config.file}`, "info");
        return;
      }

      if (request.mode === "manual") {
        const result = await configureFromSetupArgs({ request, probe: probeEndpoint, save: runtime.config.save });
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

        runtime.config.save({
          endpoint: chosen.endpoint,
          model: chosen.model,
          backend: chosen.label,
          configuredBy: "offline-setup",
          configuredAt: new Date().toISOString()
        });
        ctx.ui.notify(`Saved TinyCoder ${chosen.model} @ ${chosen.endpoint} (${chosen.label}).`, "info");
      }

      const sources = runtime.config.settings().sources;
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
    description: "Trim tools for slow models / restore",
    getArgumentCompletions: argumentChoices([
      ["status", "List the tools the model can call right now"],
      ["minimal", "Keep only read/edit/line_edit/write, shell, code, search, LSP and TinyCoder tools"],
      ["restore", "Bring back the tool set that was active before 'minimal'"]
    ]),
    handler: async (args, ctx) => {
      const mode = String(args ?? "").trim().toLowerCase() || "status";
      if (mode === "minimal") {
        if (!state.savedActiveTools) state.savedActiveTools = pi.getActiveTools();
        const minimal = buildMinimalToolSet(pi.getAllTools(), process.platform, pi.getActiveTools());
        pi.setActiveTools(minimal);
        ctx.ui.notify(`Offline minimal tools enabled (${minimal.length}): ${minimal.join(", ")}`, "info");
        return;
      }
      if (mode === "restore") {
        if (!state.savedActiveTools) {
          ctx.ui.notify("No saved tool set to restore.", "warning");
          return;
        }
        pi.setActiveTools(state.savedActiveTools);
        ctx.ui.notify(`Restored ${state.savedActiveTools.length} tools.`, "info");
        state.savedActiveTools = null;
        return;
      }
      ctx.ui.notify(`Active tools (${pi.getActiveTools().length}): ${pi.getActiveTools().join(", ")}`, "info");
    }
  });

  pi.registerCommand("offline-training", {
    description: "Save TinyCoder runs as training data",
    getArgumentCompletions: argumentChoices([
      ["status", "Show whether capture is on and where the raw trace is written"],
      ["on", "Start saving specs, context and TinyCoder results locally (includes source code)"],
      ["off", "Stop saving training data"],
      ["export", "Build SFT, preference and eval datasets from the captured runs"]
    ]),
    handler: async (args, ctx) => {
      const mode = String(args ?? "").trim().toLowerCase() || "status";
      if (mode === "on") {
        state.trainingCaptureEnabled = true;
        ctx.ui.notify(
          "Training capture enabled. Exact bounded specs, context, TinyCoder candidates and verification labels will be stored locally under .pi/offline-engine/training/raw.jsonl. Sensitive-path captures are blocked automatically.",
          "warning"
        );
        return;
      }
      if (mode === "off") {
        state.trainingCaptureEnabled = false;
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
      const status = trainingCaptureStatus({ enabled: state.trainingCaptureEnabled });
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
    description: "TinyCoder calls and context savings",
    handler: async (_args, ctx) => {
      const { events } = await readOfflineEvents(ctx.cwd);
      ctx.ui.notify(formatOfflineStats(summarizeOfflineEvents(events)), "info");
    }
  });

  pi.registerCommand("offline-status", {
    description: "Show engine settings and sources",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        [
          formatEngineStatus({
            settings: runtime.config.settings(),
            configFile: runtime.config.file,
            configError: runtime.config.error(),
            companionEnv: runtime.companionEnv
          }),
          `Endpoint locality: ${checkEndpointLocality(runtime.config.settings().endpoint).message}`,
          `Implementer auth: ${runtime.config.settings().apiKey ? "bearer key configured" : "none (local endpoint)"}`,
          `Bounded execute attempts: ${runtime.config.settings().maxAttempts}`,
          "Candidate apply: exact replace_text/create_file with stale preimage protection",
          "Verification: declared dotnet build/tests, --no-restore",
          "Telemetry: .pi/offline-engine/events.jsonl"
        ].join("\n"),
        "info"
      );
    }
  });
}

function argumentChoices(choices: Array<[value: string, description: string]>) {
  return (prefix: string) => {
    const typed = prefix.trimStart().toLowerCase();
    const items = choices
      .filter(([value]) => value.startsWith(typed))
      .map(([value, description]) => ({ value, label: value, description }));
    return items.length > 0 ? items : null;
  };
}
