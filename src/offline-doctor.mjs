import { resolveEndpointUrl } from "./endpoint-url.mjs";
import { buildAuthHeaders } from "./tiny-client.mjs";

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_CATALOG_SAMPLE = 8;

export async function runOfflineDoctor({
  cwd,
  endpoint,
  model,
  tools,
  exec,
  apiKey = null,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const checks = [];

  checks.push(await checkTinyEndpoint(endpoint, model, fetchFn, timeoutMs, apiKey));
  checks.push(checkEndpointLocality(endpoint));

  checks.push(await checkCommand({
    name: "dotnet",
    required: true,
    exec,
    args: ["--info"],
    cwd,
    timeoutMs
  }));

  checks.push(await checkDotnetTestCapabilities({
    exec,
    cwd,
    timeoutMs
  }));

  checks.push(await checkRuntimeStateIgnore({
    exec,
    cwd,
    timeoutMs
  }));

  checks.push(await checkCommand({
    name: "csharp-ls",
    required: false,
    exec,
    args: ["--version"],
    cwd,
    timeoutMs
  }));

  checks.push(checkTool(tools, "execute_delegated_implementation", true, "bounded TinyCoder execution"));
  checks.push(checkAnyTool(tools, ["knowledge_search"], false, "local semantic retrieval"));
  checks.push(checkAnyTool(tools, ["lsp_diagnostics"], false, "live compiler/LSP diagnostics"));
  checks.push(checkAnyTool(tools, ["code"], false, "code-mode mechanical pipelines"));
  checks.push(checkAnyTool(tools, ["list_symbols", "code_overview", "lsp_symbols"], false, "structural code navigation"));

  const editTool = tools.find((tool) => tool.name === "edit");
  checks.push({
    id: "edit_provider",
    required: false,
    ok: Boolean(editTool),
    status: editTool ? "ok" : "warn",
    message: editTool
      ? `edit tool source: ${formatSource(editTool.sourceInfo)}`
      : "edit tool not active"
  });

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

// The project's premise is that source stays on this machine. Pointing the
// implementer at a hosted router is a legitimate, deliberate choice, so this
// is a warning rather than a readiness failure -- but it must be stated, or
// "OFFLINE READY: yes" would be a false claim.
export function checkEndpointLocality(endpoint) {
  let host = "";
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`).hostname;
  } catch {
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

function isLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "::") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  // A bare intranet name with no dot is not a public destination.
  if (!host.includes(".")) return true;
  return false;
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

    const ok = ignored.code === 0;
    return {
      id: "runtime_state_ignore",
      required: false,
      ok,
      status: ok ? "ok" : "warn",
      message: ok
        ? ".pi/offline-engine is ignored by Git"
        : ".pi/offline-engine is not ignored; add '/.pi/offline-engine/' to .git/info/exclude before real use to avoid accidental commits"
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
        message: `unable to inspect dotnet test capabilities (exit ${String(result.code)})`
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
      ok: hasTrx,
      status: hasTrx ? "ok" : "warn",
      message: hasTrx
        ? "Microsoft.Testing.Platform mode detected; TRX reporter is available"
        : "Microsoft.Testing.Platform mode detected, but --report-trx is not advertised; test verification needs Microsoft.Testing.Extensions.TrxReport restored before going offline"
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

async function checkCommand({ name, required, exec, args, cwd, timeoutMs }) {
  try {
    const result = await exec(name, args, { cwd, timeout: timeoutMs });
    const ok = result.code === 0 && result.killed !== true;
    const firstLine = firstNonEmpty(result.stdout) ?? firstNonEmpty(result.stderr);
    return {
      id: name,
      required,
      ok,
      status: ok ? "ok" : required ? "error" : "warn",
      message: ok ? firstLine ?? "available" : `exit ${String(result.code)}`
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
