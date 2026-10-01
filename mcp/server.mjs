#!/usr/bin/env node
// pi-offline-engine as an MCP server, for Claude Code and any other MCP
// client (Codex, Cursor, Gemini CLI, ...). It runs the same host-independent
// workflows as the Pi extension (src/delegation-*-workflow.mjs) and reads the
// same engine config as /offline-setup, with environment variables first.
//
// Two rules differ from Pi because an MCP server cannot see the host:
// - Workspace: PI_OFFLINE_WORKSPACE, else CLAUDE_PROJECT_DIR, else the
//   client's first MCP root. The process cwd is never used silently, because
//   a plugin-launched server may run from the plugin's install directory.
// - Approval: one elicitation naming model, files and attempts, as Pi's
//   confirmation does. A client that cannot elicit is refused. With
//   PI_OFFLINE_ALLOW_HEADLESS_APPLY=1 (the switch Pi uses without a UI) the
//   server does not ask at all: headless clients may advertise elicitation and
//   then decline every request, as `claude -p` 2.1.286 does. The client's own
//   tool-permission prompt does not count: bypass modes and allow-lists skip
//   it.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "./stdio-server.mjs";
import { DELEGATION_PARAMETERS_JSON_SCHEMA } from "./delegation-json-schema.mjs";
import { appendEvent } from "../src/event-log.mjs";
import { runCandidateDelegation } from "../src/delegation-candidate-workflow.mjs";
import { createTinyTransport, prepareDelegatedExecution, runDelegatedExecution } from "../src/delegation-execution-workflow.mjs";
import { formatCancelledResult, formatCandidateResult, formatExecutionResult } from "../src/delegation-results.mjs";
import { engineConfigPath, readEngineConfig, resolveEngineSettings } from "../src/engine-config.mjs";
import { formatEngineStatus } from "../src/engine-setup.mjs";
import { checkEndpointLocality, formatDoctorReport, runOfflineDoctor } from "../src/offline-doctor.mjs";
import { formatOfflineStats, readOfflineEvents, summarizeOfflineEvents } from "../src/stats.mjs";
import { resolveAgentDir } from "../src/agent-dir.mjs";
import { nodeExec } from "../src/node-exec.mjs";
import { ensureSelfIgnoringStateDir } from "../src/state-dir.mjs";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createEngineTools({ env = process.env, exec = nodeExec, serverRoot = SERVER_ROOT } = {}) {
  const configFile = engineConfigPath(resolveAgentDir(env));
  const settings = () => {
    const { config, error } = readEngineConfig(configFile);
    return { ...resolveEngineSettings({ env, config }), configError: error };
  };
  const callTiny = createTinyTransport(() => settings().apiKey);

  async function workspace(ctx) {
    return resolveWorkspace({ env, listRoots: ctx.listRoots, serverRoot });
  }

  const delegate = {
    name: "delegate_implementation",
    title: "Delegate implementation (candidate only)",
    description: "Ask the cheap implementer model for a bounded candidate for a fully decided change (1-2 files, ImplementationSpec v1). Writes nothing. The current text of the allowed files is attached automatically (up to 16 KB each); put other relevant snippets in context.",
    inputSchema: DELEGATION_PARAMETERS_JSON_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: true },
    async call(args, ctx) {
      const cwd = await workspace(ctx);
      await ensureSelfIgnoringStateDir(cwd);
      const { endpoint, model, attachCurrentFiles } = settings();
      const outcome = await runCandidateDelegation({
        spec: args.spec, context: args.context, cwd, signal: ctx.signal, endpoint, model, callTiny, appendEvent, attachCurrentFiles
      });
      return withWorkspace(formatCandidateResult(outcome), cwd);
    }
  };

  const execute = {
    name: "execute_delegated_implementation",
    title: "Execute delegated implementation",
    description: "Run a fully decided 1-2 file change through the implementer model: guarded apply inside the declared files, declared dotnet build/tests with --no-restore, up to two self-repairs. verification_passed is compiler/test evidence only; inspect the diff. Make it the only mutating call in its turn.",
    inputSchema: DELEGATION_PARAMETERS_JSON_SCHEMA,
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async call(args, ctx) {
      const cwd = await workspace(ctx);
      await ensureSelfIgnoringStateDir(cwd);
      const { trainingRunId } = await prepareDelegatedExecution({
        spec: args.spec, cwd, trainingCaptureEnabled: env.PI_OFFLINE_TRAINING_CAPTURE === "1", appendEvent
      });
      const { endpoint, model, maxAttempts, attachCurrentFiles } = settings();

      const headless = env.PI_OFFLINE_ALLOW_HEADLESS_APPLY === "1";
      const approval = headless ? true : await ctx.confirm([
        "Bounded delegated implementation",
        `Workspace: ${cwd}`,
        `Spec: ${args.spec.spec_id}`,
        `Implementer: ${model} @ ${endpoint} (${checkEndpointLocality(endpoint).message})`,
        `Files: ${args.spec.scope.allowed_files.join(", ")}`,
        `Attempts: up to ${maxAttempts}`,
        "Writes stay inside these files; the declared dotnet checks run with --no-restore."
      ].join("\n"));
      if (approval === false) return withWorkspace(formatCancelledResult(), cwd);
      if (approval === null) {
        throw new Error(
          "execute_delegated_implementation needs a confirmation this client cannot show (no MCP elicitation). " +
          "Set PI_OFFLINE_ALLOW_HEADLESS_APPLY=1 for the server only in a separately sandboxed workflow, or use delegate_implementation."
        );
      }

      const outcome = await runDelegatedExecution({
        spec: args.spec,
        context: args.context,
        cwd,
        signal: ctx.signal,
        endpoint,
        model,
        maxAttempts,
        trainingRunId,
        callTiny,
        exec,
        // No Pi mutation queue across processes; the SHA-256 preimage check
        // still refuses a candidate whose files changed meanwhile.
        withMutationQueues: (_paths, fn) => fn(),
        appendEvent,
        attachCurrentFiles,
        onAttemptStart: ({ attempt, maxAttempts: total }) => ctx.progress(`Implementer attempt ${attempt}/${total}`)
      });
      return withWorkspace(formatExecutionResult(outcome), cwd);
    }
  };

  const doctor = {
    name: "offline_doctor",
    title: "Check implementer readiness",
    description: "Check the configured implementer endpoint and model, dotnet and its test runner, csharp-ls, and whether .pi/ engine state is git-ignored in the workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async call(_args, ctx) {
      const cwd = await workspace(ctx);
      const current = settings();
      const report = await runOfflineDoctor({
        cwd, endpoint: current.endpoint, model: current.model, apiKey: current.apiKey, tools: null, exec
      });
      return text(`${formatDoctorReport(report)}\nWorkspace: ${cwd}`);
    }
  };

  const status = {
    name: "offline_status",
    title: "Show engine settings",
    description: "Show the effective implementer endpoint, model and attempts, and where each value comes from (environment, config file or default).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async call(_args, ctx) {
      const current = settings();
      const client = ctx?.clientCapabilities ?? {};
      return text([
        formatEngineStatus({ settings: current, configFile, configError: current.configError }),
        `Client: elicitation ${client.elicitation ? "supported" : "not offered"}, roots ${client.roots ? "offered" : "not offered"}`,
        `Endpoint locality: ${checkEndpointLocality(current.endpoint).message}`,
        `Implementer auth: ${current.apiKey ? "bearer key configured" : current.openRouterKeyWithheld ? "none (OPENROUTER_API_KEY is set but sent only to openrouter.ai)" : "none"}`,
        `Apply approval: ${env.PI_OFFLINE_ALLOW_HEADLESS_APPLY === "1" ? "not asked (PI_OFFLINE_ALLOW_HEADLESS_APPLY=1)" : "asked through elicitation; refused without it"}`
      ].join("\n"));
    }
  };

  const stats = {
    name: "offline_stats",
    title: "Show delegation statistics",
    description: "Summarise implementer calls, tokens, latency, retries and verification outcomes recorded in the workspace's .pi/offline-engine/events.jsonl.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async call(_args, ctx) {
      const cwd = await workspace(ctx);
      const { events } = await readOfflineEvents(cwd);
      return text(formatOfflineStats(summarizeOfflineEvents(events)));
    }
  };

  return [delegate, execute, doctor, status, stats];
}

export async function resolveWorkspace({ env, listRoots, serverRoot }) {
  const explicit = env.PI_OFFLINE_WORKSPACE;
  let candidate = explicit || env.CLAUDE_PROJECT_DIR || null;
  if (!candidate && listRoots) {
    const roots = await listRoots();
    const first = roots?.find((uri) => uri.startsWith("file:"));
    if (first) candidate = fileURLToPath(first);
  }
  if (!candidate) {
    throw new Error("No workspace: set PI_OFFLINE_WORKSPACE (or run under Claude Code, which sets CLAUDE_PROJECT_DIR), or use a client that offers MCP roots.");
  }

  const resolved = await fs.realpath(path.resolve(candidate)).catch(() => {
    throw new Error(`Workspace does not exist: ${candidate}`);
  });
  if (!explicit && isInside(resolved, await fs.realpath(serverRoot))) {
    throw new Error(`Refusing workspace ${resolved}: it is inside the engine's own install directory. Set PI_OFFLINE_WORKSPACE to override.`);
  }
  return resolved;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function text(value) {
  return { content: [{ type: "text", text: value }] };
}

// Pi result shape -> MCP tool result. `details` duplicates `content` for Pi's
// renderer; MCP clients read the content text.
function withWorkspace(result, cwd) {
  return { content: [...result.content, { type: "text", text: `Workspace: ${cwd}` }] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(await fs.readFile(path.join(SERVER_ROOT, "package.json"), "utf8"));
  serveStdio({
    name: "pi-offline-engine",
    version: pkg.version,
    instructions: "Bounded delegation of fully decided 1-2 file .NET changes to a cheap implementer model, with guarded writes and deterministic dotnet verification. Run offline_doctor first in a new environment.",
    tools: createEngineTools()
  });
}
