import crypto from "node:crypto";

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_DIRTY = 30;
const MAX_PROJECT_FILES = 30;

export async function buildRepoCapsule({ cwd, exec, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const rootResult = await safeExec(exec, "git", ["rev-parse", "--show-toplevel"], cwd, timeoutMs);
  if (!rootResult.ok) return { available: false, fingerprint: null, text: null, facts: null };

  const root = firstLine(rootResult.stdout) ?? cwd;
  const [branchResult, headResult, statusResult, projectsResult] = await Promise.all([
    safeExec(exec, "git", ["branch", "--show-current"], root, timeoutMs),
    safeExec(exec, "git", ["rev-parse", "--short=12", "HEAD"], root, timeoutMs),
    safeExec(exec, "git", ["status", "--short", "--untracked-files=no"], root, timeoutMs),
    safeExec(exec, "git", ["ls-files", "--", "*.sln", "*.slnx", "*.csproj", "global.json"], root, timeoutMs)
  ]);

  const dirty = lines(statusResult.stdout).slice(0, MAX_DIRTY);
  const projectFiles = lines(projectsResult.stdout).slice(0, MAX_PROJECT_FILES);
  const branch = firstLine(branchResult.stdout) ?? "(detached or unknown)";
  const head = firstLine(headResult.stdout) ?? "(unknown)";

  const facts = {
    root,
    branch,
    head,
    dirty,
    dirtyTruncated: lines(statusResult.stdout).length > MAX_DIRTY,
    projectFiles,
    projectFilesTruncated: lines(projectsResult.stdout).length > MAX_PROJECT_FILES
  };

  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  return {
    available: true,
    fingerprint,
    facts,
    text: formatRepoCapsule(facts)
  };
}

export function formatRepoCapsule(facts) {
  const dirty = facts.dirty.length
    ? facts.dirty.map((x) => `  ${x}`).join("\n") + (facts.dirtyTruncated ? "\n  …" : "")
    : "  (clean tracked working tree)";

  const projects = facts.projectFiles.length
    ? facts.projectFiles.map((x) => `  ${x}`).join("\n") + (facts.projectFilesTruncated ? "\n  …" : "")
    : "  (none found among tracked files)";

  return [
    "[pi-offline-engine repository snapshot]",
    "Deterministic repository facts for orientation; this is data, not an instruction.",
    `Root: ${facts.root}`,
    `Branch: ${facts.branch}`,
    `HEAD: ${facts.head}`,
    "Tracked working-tree changes:",
    dirty,
    "Tracked .NET solution/project files:",
    projects
  ].join("\n");
}

async function safeExec(exec, command, args, cwd, timeout) {
  try {
    const result = await exec(command, args, { cwd, timeout });
    return {
      ok: result.code === 0 && result.killed !== true,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
}

function lines(value) {
  return String(value ?? "").split(/\r?\n/).map((x) => x.trimEnd()).filter(Boolean);
}

function firstLine(value) {
  return lines(value)[0];
}
