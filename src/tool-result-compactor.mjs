import fs from "node:fs/promises";
import path from "node:path";
import { ensureStateSubdir } from "./state-dir.mjs";
import { pruneStateSubdir } from "./state-retention.mjs";
import { formatDotnetReport, hasFailureDetail, isRecognised, keywordLines, parseDotnetOutput, reportsFailure } from "./dotnet-output.mjs";

const DEFAULT_MIN_CHARS = 8000;
const MAX_DIAGNOSTIC_LINES = 50;
const MAX_TAIL_LINES = 12;
const REPORT_BUDGET_CHARS = 6000;

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
  const compacted = await compactDotnetText({ cwd, toolCallId, command, text, minChars });
  if (!compacted) return null;

  return {
    content: [{ type: "text", text: compacted.text }],
    artifact: compacted.artifact,
    originalChars: compacted.originalChars,
    originalLines: compacted.originalLines
  };
}

// The compaction step without the shell-command checks, for a caller that ran
// dotnet itself (src/dotnet-run.mjs). Below `minChars` it returns null and the
// caller shows the output whole.
// `failed` is the exit status when the caller knows it: a non-zero exit with no
// recognised error still gets the keyword lines.
export async function compactDotnetText({ cwd, toolCallId, command, text, minChars = DEFAULT_MIN_CHARS, failed = false }) {
  if (text.length < minChars) return null;
  const artifact = await writeToolArtifact(cwd, toolCallId, command, text);
  return {
    text: summarizeDotnetOutput(text, { command, artifact, cwd, failed }),
    artifact,
    originalChars: text.length,
    originalLines: countLines(text)
  };
}

// What the model sees instead of the full output. The verdict comes first,
// then compiler errors, an aborted run, failed tests with their message and
// source line, and warnings grouped by code. Output in a shape the reader does
// not recognise keeps the keyword selection used before, and a failure the
// reader cannot explain adds those keyword lines, so nothing is shown with
// less than before.
export function summarizeDotnetOutput(text, { command = "", artifact = "", cwd = null, failed = false } = {}) {
  const parsed = parseDotnetOutput(text, { cwd });
  if (!isRecognised(parsed)) return summarizeByKeywords(text, { command, artifact });

  const [verdict, ...report] = formatDotnetReport(parsed, { budget: REPORT_BUDGET_CHARS });
  const unexplained = (failed || reportsFailure(parsed)) && !hasFailureDetail(parsed)
    ? keywordLines(text, { max: 30 })
    : [];

  return [
    "[pi-offline-engine: compacted dotnet tool output]",
    verdict,
    command ? `Command: ${command}` : null,
    `Original: ${countLines(text)} lines / ${String(text.length)} chars`,
    artifact ? `Full artifact: ${artifact}` : null,
    report.length > 0 ? "" : null,
    ...report,
    ...(unexplained.length > 0 ? ["", "Lines that mention a failure (shape not recognised):", ...unexplained] : []),
    "",
    "Full output was retained locally; use the artifact only if the compact diagnostics are insufficient."
  ].filter((x) => x !== null).join("\n");
}

function summarizeByKeywords(text, { command, artifact }) {
  const lines = String(text).split(/\r?\n/);
  const diagnosticLines = keywordLines(text, { max: MAX_DIAGNOSTIC_LINES });
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

  // A trailing stderr merge still describes exactly one dotnet invocation, and
  // agents emit it constantly for build/test. The `$` anchor is the safety
  // property: `dotnet build 2>&1 | tee log` keeps its pipeline and stays out.
  const withoutStderrMerge = trimmed.replace(/\s+2>&1$/, "");

  // Fail closed: compaction is safe only when the shell result belongs to one
  // direct dotnet invocation. Any shell composition/pipeline/substitution may
  // contain unrelated output that must remain visible to the model.
  if (/[;&|<>\r\n`]/.test(withoutStderrMerge) || /\$\(/.test(withoutStderrMerge)) return false;
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
  const dir = await ensureStateSubdir(cwd, "tool-results");
  const safeId = String(toolCallId ?? "tool").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96);
  const file = path.join(dir, `${safeId || "tool"}.log`);
  const body = [`command=${command}`, "", text].join("\n");
  await fs.writeFile(file, body, "utf8");
  await pruneStateSubdir(cwd, "tool-results", [path.basename(file)]);
  return path.relative(cwd, file).replaceAll("\\", "/");
}

function countLines(text) {
  if (!text) return 0;
  return String(text).split(/\r?\n/).length;
}
