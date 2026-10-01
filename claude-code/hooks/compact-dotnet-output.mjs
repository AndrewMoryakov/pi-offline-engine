#!/usr/bin/env node
// Claude Code PostToolUse hook (Bash / PowerShell): shortens a large direct
// `dotnet build` / `dotnet test` result to its diagnostics and keeps the full
// output under .pi/offline-engine/tool-results/. Same rules as the Pi
// tool_result hook (src/tool-result-compactor.mjs).
//
// Claude Code applies `updatedToolOutput` for built-in tools only when it has
// the shape of `tool_response` ({stdout, stderr, ...}); a plain string is
// ignored (observed with Claude Code 2.1.286). Any failure exits 0 without
// output, which leaves the original result untouched.

import { readFileSync } from "node:fs";
import { compactToolResult } from "../../src/tool-result-compactor.mjs";
import { ensureSelfIgnoringStateDir } from "../../src/state-dir.mjs";

export async function compactHookPayload(payload, { env = process.env } = {}) {
  if (env.PI_OFFLINE_COMPACT_TOOL_RESULTS === "0") return null;
  const response = payload?.tool_response;
  if (!response || typeof response !== "object" || typeof response.stdout !== "string") return null;

  const toolName = String(payload.tool_name ?? "").toLowerCase();
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const text = [response.stdout, response.stderr].filter((x) => typeof x === "string" && x.length > 0).join("\n");

  const compacted = await compactToolResult({
    cwd,
    toolName,
    toolCallId: payload.tool_use_id,
    input: payload.tool_input,
    content: [{ type: "text", text }]
  });
  if (!compacted) return null;
  await ensureSelfIgnoringStateDir(cwd);

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: { ...response, stdout: compacted.content[0].text, stderr: "" }
    }
  };
}

if (process.argv[1]?.endsWith("compact-dotnet-output.mjs")) {
  try {
    const output = await compactHookPayload(JSON.parse(readFileSync(0, "utf8") || "{}"));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // Never break the tool call; the model then sees the original output.
  }
}
