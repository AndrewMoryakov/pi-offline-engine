const DEFAULT_TIMEOUT_MS = 5000;

export async function runOfflineDoctor({
  cwd,
  endpoint,
  model,
  tools,
  exec,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const checks = [];

  checks.push(await checkTinyEndpoint(endpoint, model, fetchFn, timeoutMs));

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

async function checkTinyEndpoint(endpoint, model, fetchFn, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let healthOk = false;
    try {
      const health = await fetchFn(new URL("/health", withSlash(endpoint)), { signal: controller.signal });
      healthOk = health.ok;
    } catch {}

    let models = [];
    try {
      const response = await fetchFn(new URL("/v1/models", withSlash(endpoint)), { signal: controller.signal });
      if (response.ok) {
        const json = await response.json();
        models = Array.isArray(json?.data) ? json.data.map((x) => String(x.id ?? x.model ?? "")).filter(Boolean) : [];
      }
    } catch {}

    const reachable = healthOk || models.length > 0;
    const exactModel = models.length === 0 || models.includes(model);

    return {
      id: "tiny_endpoint",
      required: true,
      ok: reachable && exactModel,
      status: reachable && exactModel ? "ok" : "error",
      message: !reachable
        ? `unreachable: ${endpoint}`
        : exactModel
          ? `reachable; model ${model}${models.length ? " present" : " catalog unavailable"}`
          : `reachable, but configured model ${model} not listed: ${models.join(", ")}`
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

function withSlash(endpoint) {
  return endpoint.endsWith("/") ? endpoint : endpoint + "/";
}
