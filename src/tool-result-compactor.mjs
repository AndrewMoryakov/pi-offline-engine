import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MIN_CHARS = 8000;
const MAX_DIAGNOSTIC_LINES = 50;
const MAX_TAIL_LINES = 12;

export async function compactToolResult({
  cwd,
  toolName,
  toolCallId,
  input,
  content,
  minChars = DEFAULT_MIN_CHARS
}) {
  if (!isShellTool(toolName)) return null;

  const command = extractCommand(input);
  if (!isDotnetBuildOrTest(command)) return null;

  const text = extractTextContent(content);
  if (text.length < minChars) return null;

  const artifact = await writeToolArtifact(cwd, toolCallId, command, text);
  const summary = summarizeDotnetOutput(text, { command, artifact });

  return {
    content: [{ type: "text", text: summary }],
    artifact,
    originalChars: text.length,
    originalLines: countLines(text)
  };
}

export function summarizeDotnetOutput(text, { command = "", artifact = "" } = {}) {
  const lines = String(text).split(/\r?\n/);
  const diagnosticLines = [];
  const seen = new Set();

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    if (
      /\berror\s+[A-Z]{1,5}\d{3,}\b/i.test(trimmed) ||
      /\bfailed\b/i.test(trimmed) ||
      /\bexception\b/i.test(trimmed) ||
      /\bassert(?:ion)?\b/i.test(trimmed) ||
      /\bTest Run Failed\b/i.test(trimmed)
    ) {
      if (!seen.has(trimmed)) {
        diagnosticLines.push(trimmed);
        seen.add(trimmed);
      }
      if (diagnosticLines.length >= MAX_DIAGNOSTIC_LINES) break;
    }
  }

  const tail = lines.filter((x) => x.trim().length > 0).slice(-MAX_TAIL_LINES);
  const body = diagnosticLines.length > 0 ? diagnosticLines : tail;

  return [
    "[pi-offline-engine: compacted dotnet tool output]",
    command ? `Command: ${command}` : null,
    `Original: ${countLines(text)} lines / ${String(text.length)} chars`,
    artifact ? `Full artifact: ${artifact}` : null,
    "",
    diagnosticLines.length > 0 ? "Selected diagnostics:" : "Output tail:",
    ...body,
    "",
    "Full output was retained locally; use the artifact only if the compact diagnostics are insufficient."
  ].filter((x) => x !== null).join("\n");
}

export function isDotnetBuildOrTest(command) {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!/^dotnet\s+(?:build|test)\b/i.test(trimmed)) return false;

  // Fail closed: compaction is safe only when the shell result belongs to one
  // direct dotnet invocation. Any shell composition/pipeline/substitution may
  // contain unrelated output that must remain visible to the model.
  if (/[;&|<>\r\n`]/.test(trimmed) || /\$\(/.test(trimmed)) return false;
  return true;
}

export function extractTextContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function extractCommand(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of ["command", "cmd", "script"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return "";
}

function isShellTool(toolName) {
  return toolName === "bash" || toolName === "powershell";
}

async function writeToolArtifact(cwd, toolCallId, command, text) {
  const dir = path.join(cwd, ".pi", "offline-engine", "tool-results");
  await fs.mkdir(dir, { recursive: true });
  const safeId = String(toolCallId ?? "tool").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96);
  const file = path.join(dir, `${safeId || "tool"}.log`);
  const body = [`command=${command}`, "", text].join("\n");
  await fs.writeFile(file, body, "utf8");
  return path.relative(cwd, file).replaceAll("\\", "/");
}

function countLines(text) {
  if (!text) return 0;
  return String(text).split(/\r?\n/).length;
}
