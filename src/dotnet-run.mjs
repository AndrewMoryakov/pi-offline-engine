// `dotnet build` / `dotnet test` run by the engine itself, for hosts whose
// hooks cannot shorten a failed command's output.
//
// Claude Code 2.1.329 sends a Bash command that exits non-zero to
// PostToolUseFailure, not PostToolUse, and a hook on that event cannot replace
// what the model reads (tried with updatedToolOutput as a string and as an
// object, and with additionalContext). A failed build or test run, the output
// worth shortening most, therefore reaches the model in full through Bash.
// Running the command here returns the short result whatever the exit code.

import fs from "node:fs/promises";
import path from "node:path";
import { isSafeRelativePath } from "./implementation-spec.mjs";
import { compactDotnetText } from "./tool-result-compactor.mjs";
import { formatDotnetReport, parseDotnetOutput } from "./dotnet-output.mjs";

export const DOTNET_RUN_TIMEOUT_MS = 15 * 60_000;
const CONFIGURATION = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_FILTER_CHARS = 500;

export async function runDotnetCommand({
  cwd,
  command,
  project = null,
  filter = null,
  configuration = null,
  noRestore = false,
  exec,
  signal,
  toolCallId = null,
  timeoutMs = DOTNET_RUN_TIMEOUT_MS
}) {
  if (command !== "build" && command !== "test") throw new Error(`unsupported dotnet command: ${String(command)}`);
  const target = project ? await resolveProjectArgument(cwd, project) : null;
  if (filter !== null && filter !== undefined && filter !== "") {
    if (command !== "test") throw new Error("filter applies to dotnet test only");
    if (typeof filter !== "string" || filter.length > MAX_FILTER_CHARS || /[\r\n\0]/.test(filter)) throw new Error("filter must be one line of at most 500 characters");
  }
  if (configuration && !CONFIGURATION.test(configuration)) throw new Error("configuration must be a plain name such as Debug or Release");

  const args = [command];
  if (target) {
    // In Microsoft.Testing.Platform mode `dotnet test` takes the project only
    // through --project.
    if (command === "test" && await usesTestingPlatformMode(cwd)) args.push("--project", target);
    else args.push(target);
  }
  if (noRestore) args.push("--no-restore");
  if (configuration) args.push("--configuration", configuration);
  if (filter) args.push("--filter", filter);

  const display = `dotnet ${args.map(quoteForDisplay).join(" ")}`;
  const result = await exec("dotnet", args, { cwd, signal, timeout: timeoutMs });
  const text = [result.stdout, result.stderr].filter((part) => typeof part === "string" && part.length > 0).join("\n");
  const exit = result.killed === true
    ? `killed after ${Math.round(timeoutMs / 1000)} s`
    : `exit code ${String(result.code)}`;

  const compacted = await compactDotnetText({ cwd, toolCallId: toolCallId ?? `dotnet-${command}-${Date.now()}`, command: display, text });
  if (compacted) {
    return {
      text: [`${display}: ${exit}`, compacted.text].join("\n"),
      compacted,
      code: result.code,
      killed: result.killed === true
    };
  }

  // Short output is shown whole, under the same verdict line the compacted
  // form starts with.
  const [verdict] = formatDotnetReport(parseDotnetOutput(text, { cwd }));
  return {
    text: [`${display}: ${exit}`, verdict, "", text || "(no output)"].join("\n"),
    compacted: null,
    code: result.code,
    killed: result.killed === true
  };
}

async function resolveProjectArgument(cwd, project) {
  if (typeof project !== "string" || !isSafeRelativePath(project)) throw new Error(`project must be a relative path inside the workspace: ${String(project)}`);
  const root = await fs.realpath(cwd);
  const real = await fs.realpath(path.join(root, project)).catch(() => {
    throw new Error(`project does not exist: ${project}`);
  });
  const rel = path.relative(root, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`project resolves outside the workspace: ${project}`);
  const stat = await fs.stat(real);
  if (stat.isFile() && !/\.(?:[a-z]{2}proj|proj|slnx?)$/i.test(real)) throw new Error(`project must be a project or solution file, or a directory: ${project}`);
  return project;
}

// .NET 10 switches `dotnet test` to Microsoft.Testing.Platform through the
// nearest global.json: { "test": { "runner": "Microsoft.Testing.Platform" } }.
async function usesTestingPlatformMode(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      const json = JSON.parse(await fs.readFile(path.join(dir, "global.json"), "utf8"));
      return String(json?.test?.runner ?? "").toLowerCase() === "microsoft.testing.platform";
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function quoteForDisplay(arg) {
  return /^[\w./:=@+~-]+$/.test(arg) ? arg : JSON.stringify(arg);
}
