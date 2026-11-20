import { endpointHost, isLocalHost } from "./endpoint-locality.mjs";
import { LINE_EDIT_TOOL, SCRIPT_EDIT_TOOL, isLocalModel } from "./edit-routing.mjs";
import { resolveEndpointUrl } from "./endpoint-url.mjs";
import { buildAuthHeaders, checkClaudeCli } from "./tiny-client.mjs";

const DEFAULT_TIMEOUT_MS = 5000;
// Starting dotnet, git, csharp-ls or the claude CLI is slower than an HTTP
// probe, and on a small or busy machine the first `dotnet` run of the day can
// pass 5 s. A process check that times out is a false red line, so processes
// get their own, longer limit.
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const MAX_CATALOG_SAMPLE = 8;

export async function runOfflineDoctor({
  cwd,
  provider = "openai-compatible",
  claudeBin = "claude",
  endpoint,
  model,
  tools,
  exec,
  editProvider = { value: "lean", source: "default" },
  scriptEditPolicy = { value: "always", source: "default" },
  allTools = tools,
  sessionModel = undefined,
  apiKey = null,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
}) {
  const checks = [];

  if (provider === "claude-code") {
    checks.push(await checkClaudeCodeImplementer({ claudeBin, model, exec, cwd, timeoutMs: commandTimeoutMs }));
    checks.push(claudeCodeLocality());
  } else {
    checks.push(await checkTinyEndpoint(endpoint, model, fetchFn, timeoutMs, apiKey));
    checks.push(checkEndpointLocality(endpoint));
  }

  // `dotnet --version` prints the SDK version on its first line; the first line
  // of `dotnet --info` is only the heading ".NET SDK:".
  checks.push(await checkCommand({
    name: "dotnet",
    required: true,
    exec,
    args: ["--version"],
    cwd,
    timeoutMs: commandTimeoutMs,
    describe: (line) => (/^\d+\.\d+/.test(line) ? `.NET SDK ${line}` : line)
  }));

  checks.push(await checkDotnetTestCapabilities({
    exec,
    cwd,
    timeoutMs: commandTimeoutMs
  }));

  checks.push(await checkRuntimeStateIgnore({
    exec,
    cwd,
    timeoutMs: commandTimeoutMs
  }));

  checks.push(await checkCommand({
    name: "csharp-ls",
    required: false,
    exec,
    args: ["--version"],
    cwd,
    timeoutMs: commandTimeoutMs
  }));

  // `tools: null` is a host without Pi's tool registry (the MCP server): the
  // checks below describe Pi's loaded tool set and do not apply there.
  if (tools) {
    checks.push(checkTool(tools, "execute_delegated_implementation", true, "bounded TinyCoder execution"));
    checks.push(checkAnyTool(tools, ["knowledge_search"], false, "local semantic retrieval"));
    checks.push(checkAnyTool(tools, ["lsp_diagnostics"], false, "live compiler/LSP diagnostics"));
    checks.push(checkAnyTool(tools, ["code"], false, "code-mode mechanical pipelines"));
    checks.push(checkAnyTool(tools, ["list_symbols", "code_overview", "lsp_symbols"], false, "structural code navigation"));

    if (editProvider.value === "hybrid") {
      checks.push(checkHybridEdit({ tools, allTools, editProvider, scriptEditPolicy, sessionModel }));
    } else {
      checks.push(checkEditProvider(tools, editProvider));
    }
  }

  const requiredFailures = checks.filter((x) => x.required && !x.ok);
  const warnings = checks.filter((x) => !x.required && !x.ok);

  return {
    ready: requiredFailures.length === 0,
    checks,
    requiredFailures: requiredFailures.map((x) => x.id),
    warnings: warnings.map((x) => x.id)
  };
}

export function formatDoctorReport(report) {
  const lines = [report.ready ? "OFFLINE READY: yes" : "OFFLINE READY: no", ""];
  for (const check of report.checks) {
    const mark = check.ok ? "✓" : check.required ? "✗" : "!";
    lines.push(`${mark} ${check.id}: ${check.message}`);
  }
  return lines.join("\n");
}

// 446-entry hosted catalogs must not be pasted into a terminal report.
function summarizeCatalog(models, model) {
  const stem = String(model ?? "").split(/[/:@]/).filter(Boolean).pop() ?? "";
  const near = stem.length >= 3 ? models.filter((x) => x.toLowerCase().includes(stem.toLowerCase())) : [];
  const shown = (near.length > 0 ? near : models).slice(0, MAX_CATALOG_SAMPLE);
  const suffix = models.length > shown.length ? `, ... (+${models.length - shown.length} more)` : "";
  return `${shown.join(", ")}${suffix}`;
}

function checkEditProvider(tools, editProvider) {
  const editTool = tools.find((tool) => tool.name === "edit");
  // Without the reason, "none" reads like a broken install months later.
  const leanOff = editProvider.value === "none"
    ? ` (bundled pi-lean-edit disabled: editProvider=none from ${editProvider.source})`
    : "";
  return {
    id: "edit_provider",
    required: false,
    ok: Boolean(editTool),
    status: editTool ? "ok" : "warn",
    message: editTool
      ? `edit tool source: ${formatSource(editTool.sourceInfo)}${leanOff}`
      : `edit tool not active${leanOff}`
  };
}

// Hybrid: pi-lean-edit's edit is line_edit, and the other package's `edit`
// is shown or hidden per scriptEditPolicy. Says which, and why, because a
// hidden `edit` otherwise looks like a missing one.
// Spec: docs/HYBRID_EDIT_V0.md HE-8.
function checkHybridEdit({ tools, allTools, editProvider, scriptEditPolicy, sessionModel }) {
  const lineTool = tools.find((tool) => tool.name === LINE_EDIT_TOOL);
  const scriptRegistered = allTools.find((tool) => tool.name === SCRIPT_EDIT_TOOL);
  const scriptActive = tools.some((tool) => tool.name === SCRIPT_EDIT_TOOL);
  const local = isLocalModel(sessionModel);
  const locality = local === null ? "model locality unknown" : local ? "local model" : "remote model";
  const parts = [
    `hybrid (editProvider from ${editProvider.source})`,
    lineTool ? `${LINE_EDIT_TOOL} source: ${formatSource(lineTool.sourceInfo)}` : `${LINE_EDIT_TOOL} not active`,
    scriptRegistered
      ? `${SCRIPT_EDIT_TOOL} source: ${formatSource(scriptRegistered.sourceInfo)}, ${scriptActive ? "offered" : "hidden"} (${locality}, scriptEditPolicy=${scriptEditPolicy.value} from ${scriptEditPolicy.source})`
      : `${SCRIPT_EDIT_TOOL} not registered`
  ];
  return {
    id: "edit_provider",
    required: false,
    ok: Boolean(lineTool),
    status: lineTool ? "ok" : "warn",
    message: parts.join("; ")
  };
}

// The project's premise is that source stays on this machine. Pointing the
// implementer at a hosted router is a legitimate, deliberate choice, so this
// is a warning rather than a readiness failure -- but it must be stated, or
// "OFFLINE READY: yes" would be a false claim.
export function checkEndpointLocality(endpoint) {
  const host = endpointHost(endpoint);
  if (host === null) {
    return {
      id: "endpoint_locality",
      required: false,
      ok: false,
      status: "warn",
      message: `cannot parse endpoint to determine locality: ${endpoint}`
    };
  }

  const local = isLocalHost(host);
  return {
    id: "endpoint_locality",
    required: false,
    ok: local,
    status: local ? "ok" : "warn",
    // Loopback, RFC1918 and bare hostnames are treated as trusted: source may
    // still cross to another box, but it stays inside the operator's network.
    message: local
      ? `implementer endpoint is local (${host}); source stays on your network`
      : `implementer endpoint is remote (${host}); prompts and source excerpts leave your network`
  };
}

// Provider "claude-code": the implementer is a Claude model reached through the
// Claude Code CLI. The doctor can see whether the CLI runs; whether the account
// may use the model is known only on the first call, and the report says so
// instead of spending a request on it.
async function checkClaudeCodeImplementer({ claudeBin, model, exec, cwd, timeoutMs }) {
  const cli = await checkClaudeCli({ claudeBin, exec, cwd, timeoutMs });
  return {
    id: "tiny_endpoint",
    required: true,
    ok: cli.ok,
    status: cli.ok ? "ok" : "error",
    message: cli.ok
      ? `claude CLI ${cli.version}; model ${model} is checked on the first call`
      : `claude CLI not usable (${claudeBin}): ${cli.error}`
  };
}

function claudeCodeLocality() {
  return {
    id: "endpoint_locality",
    required: false,
    ok: false,
    status: "warn",
    message: "implementer runs through Claude Code; prompts and source excerpts go to Anthropic"
  };
}

// One line for prompts and status output, for either provider.
export function describeImplementer(settings) {
  return settings.provider === "claude-code"
    ? `${settings.model} via Claude Code (${settings.claudeBin ?? "claude"} -p)`
    : `${settings.model} @ ${settings.endpoint}`;
}

// The "Implementer auth" status line. `noneText` keeps each host's wording for
// the HTTP provider without a key.
export function describeImplementerAuth(settings, noneText = "none") {
  if (settings.provider === "claude-code") return "Claude Code login (claude CLI)";
  if (settings.apiKey) return "bearer key configured";
  return settings.openRouterKeyWithheld ? "none (OPENROUTER_API_KEY is set but sent only to openrouter.ai)" : noneText;
}

export function describeImplementerLocality(settings) {
  return settings.provider === "claude-code" ? claudeCodeLocality().message : checkEndpointLocality(settings.endpoint).message;
}

async function checkTinyEndpoint(endpoint, model, fetchFn, timeoutMs, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = buildAuthHeaders(apiKey);
  try {
    let healthOk = false;
    try {
      // A hosted router has no /health; reachability then rests on v1/models.
      const health = await fetchFn(resolveEndpointUrl(endpoint, "health"), { signal: controller.signal, headers });
      healthOk = health.ok;
    } catch {}

    let models = [];
    try {
      const response = await fetchFn(resolveEndpointUrl(endpoint, "v1/models"), { signal: controller.signal, headers });
      if (response.ok) {
        const json = await response.json();
        models = Array.isArray(json?.data) ? json.data.map((x) => String(x.id ?? x.model ?? "")).filter(Boolean) : [];
      }
    } catch {}

    const reachable = healthOk || models.length > 0;
    const catalogAvailable = models.length > 0;
    const exactModel = catalogAvailable && models.includes(model);
    const ok = reachable && exactModel;

    return {
      id: "tiny_endpoint",
      required: true,
      ok,
      status: ok ? "ok" : "error",
      message: !reachable
        ? `unreachable: ${endpoint}`
        : !catalogAvailable
          ? `reachable, but model catalog is unavailable; cannot verify configured model ${model}`
          : exactModel
            ? `reachable; model ${model} present`
            : `reachable, but configured model ${model} not listed among ${models.length} available: ${summarizeCatalog(models, model)}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkRuntimeStateIgnore({ exec, cwd, timeoutMs }) {
  try {
    const repo = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: timeoutMs });
    if (repo.code !== 0 || repo.killed === true) {
      return {
        id: "runtime_state_ignore",
        required: false,
        ok: true,
        status: "ok",
        message: "not inside a Git repository; no Git ignore check needed"
      };
    }

    const ignored = await exec(
      "git",
      ["check-ignore", "-q", "--no-index", ".pi/offline-engine/probe"],
      { cwd, timeout: timeoutMs }
    );

    // Not a warning: the engine puts a `.gitignore` containing `*` into
    // .pi/offline-engine/ before every write (src/state-dir.mjs), and only
    // that file makes this probe succeed. So the probe fails in a repository
    // the engine has not written to yet, and in one holding state from a
    // version that did not have the file; the next write fixes both.
    const message = ignored.code === 0
      ? ".pi/offline-engine is ignored by Git"
      : ".pi/offline-engine is not ignored by Git yet; the engine adds a .gitignore inside it the next time it writes there, so its files are not staged by accident";
    return {
      id: "runtime_state_ignore",
      required: false,
      ok: true,
      status: "ok",
      message
    };
  } catch (error) {
    return {
      id: "runtime_state_ignore",
      required: false,
      ok: false,
      status: "warn",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkDotnetTestCapabilities({ exec, cwd, timeoutMs }) {
  try {
    const result = await exec("dotnet", ["test", "--help"], { cwd, timeout: timeoutMs });
    if (result.code !== 0 || result.killed === true) {
      return {
        id: "dotnet_test_runner",
        required: false,
        ok: false,
        status: "warn",
        message: `unable to inspect dotnet test capabilities (${describeFailure(result, timeoutMs)})`
      };
    }

    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const mtp = /--test-modules\b|--max-parallel-test-modules\b/.test(text);
    if (!mtp) {
      return {
        id: "dotnet_test_runner",
        required: false,
        ok: true,
        status: "ok",
        message: "VSTest mode detected"
      };
    }

    const hasTrx = /--report-trx\b/.test(text);
    return {
      id: "dotnet_test_runner",
      required: false,
      // MTP extensions are project-scoped. Generic help at the repository root
      // may omit --report-trx even when the declared test project provides it.
      // The mutating tool performs a required, project-qualified preflight and
      // fails closed before calling TinyCoder if TRX is really unavailable.
      ok: true,
      status: "ok",
      message: hasTrx
        ? "Microsoft.Testing.Platform mode detected; TRX reporter is available"
        : "Microsoft.Testing.Platform mode detected; TRX reporter will be verified against the declared test project before delegation"
    };
  } catch (error) {
    return {
      id: "dotnet_test_runner",
      required: false,
      ok: false,
      status: "warn",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

// A process the doctor killed at its time limit exits with whatever code the
// signal left, often 0; reporting that as "exit 0" reads like a contradiction.
export function describeFailure(result, timeoutMs) {
  return result?.killed === true
    ? `timed out after ${Math.round(timeoutMs / 1000)} s`
    : `exit ${String(result?.code)}`;
}

async function checkCommand({ name, required, exec, args, cwd, timeoutMs, describe = (line) => line }) {
  try {
    const result = await exec(name, args, { cwd, timeout: timeoutMs });
    const ok = result.code === 0 && result.killed !== true;
    const firstLine = firstNonEmpty(result.stdout) ?? firstNonEmpty(result.stderr);
    return {
      id: name,
      required,
      ok,
      status: ok ? "ok" : required ? "error" : "warn",
      message: ok ? (firstLine ? describe(firstLine) : "available") : describeFailure(result, timeoutMs)
    };
  } catch (error) {
    return {
      id: name,
      required,
      ok: false,
      status: required ? "error" : "warn",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function checkTool(tools, name, required, purpose) {
  const tool = tools.find((x) => x.name === name);
  return {
    id: `tool:${name}`,
    required,
    ok: Boolean(tool),
    status: tool ? "ok" : required ? "error" : "warn",
    message: tool ? `${purpose}; source ${formatSource(tool.sourceInfo)}` : `missing: ${purpose}`
  };
}

function checkAnyTool(tools, names, required, purpose) {
  const tool = tools.find((x) => names.includes(x.name));
  return {
    id: `tool:${names[0]}`,
    required,
    ok: Boolean(tool),
    status: tool ? "ok" : required ? "error" : "warn",
    message: tool ? `${purpose} via ${tool.name}` : `missing: ${purpose}`
  };
}

function formatSource(sourceInfo) {
  if (!sourceInfo) return "unknown";
  return sourceInfo.path ?? sourceInfo.origin ?? sourceInfo.source ?? "unknown";
}

function firstNonEmpty(value) {
  return String(value ?? "").split(/\r?\n/).map((x) => x.trim()).find(Boolean);
}
