#!/usr/bin/env node
// Claude Code PostToolUse hook (Bash / PowerShell): shortens a large direct
// `dotnet build` / `dotnet test` result to its diagnostics and keeps the full
// output under .pi/offline-engine/tool-results/. Same rules as the Pi
// tool_result hook (src/tool-result-compactor.mjs).
//
// Claude Code applies `updatedToolOutput` for built-in tools only when it has
// the shape of `tool_response` ({stdout, stderr, ...}); a plain string is
// ignored. A large result arrives with stdout cut to 30,000 characters and the
// full text in `persistedOutputPath`; the model is then shown a preview of
// that file, so the replacement must drop the persisted-output keys, and the
// compaction reads the full file. (Both observed with Claude Code 2.1.286.)
// Any failure exits 0 without output, which leaves the original result
// untouched.

import { readFileSync, statSync } from "node:fs";
import { compactToolResult } from "../../src/tool-result-compactor.mjs";
import { ensureSelfIgnoringStateDir } from "../../src/state-dir.mjs";
import { appendEvent } from "../../src/event-log.mjs";

export async function compactHookPayload(payload, { env = process.env } = {}) {
  if (env.PI_OFFLINE_COMPACT_TOOL_RESULTS === "0") return null;
  const response = payload?.tool_response;
  if (!response || typeof response !== "object" || typeof response.stdout !== "string") return null;

  const toolName = String(payload.tool_name ?? "").toLowerCase();
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const stdout = readPersistedOutput(response) ?? response.stdout;
  const text = [stdout, response.stderr].filter((x) => typeof x === "string" && x.length > 0).join("\n");

  const compacted = await compactToolResult({
    cwd,
    toolName,
    toolCallId: payload.tool_use_id,
    input: payload.tool_input,
    content: [{ type: "text", text }]
  });
  if (!compacted) return null;
  await ensureSelfIgnoringStateDir(cwd);

  // The same event the Pi extension writes, so offline_stats counts it. The
  // state directory exists at this point (the artifact was written into it).
  const compactedText = compacted.content[0].text;
  try {
    await appendEvent(cwd, {
      type: "tool_result_compacted",
      toolCallId: payload.tool_use_id,
      toolName,
      artifact: compacted.artifact,
      originalChars: compacted.originalChars,
      originalLines: compacted.originalLines,
      compactedChars: compactedText.length
    });
  } catch {
    // Telemetry only: the compacted result is still returned.
  }

  const { persistedOutputPath: _path, persistedOutputSize: _size, ...rest } = response;
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: { ...rest, stdout: compactedText, stderr: "" }
    }
  };
}

const MAX_PERSISTED_BYTES = 32 * 1024 * 1024;

function readPersistedOutput(response) {
  const file = response.persistedOutputPath;
  if (typeof file !== "string" || !file) return null;
  try {
    if (statSync(file).size > MAX_PERSISTED_BYTES) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

if (process.argv[1]?.endsWith("compact-dotnet-output.mjs")) {
  try {
    const output = await compactHookPayload(JSON.parse(readFileSync(0, "utf8") || "{}"));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // Never break the tool call; the model then sees the original output.
  }
}
