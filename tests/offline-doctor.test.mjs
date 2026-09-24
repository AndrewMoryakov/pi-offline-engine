import test from "node:test";
import assert from "node:assert/strict";
import { runOfflineDoctor, formatDoctorReport, checkEndpointLocality } from "../src/offline-doctor.mjs";

test("doctor reports ready with endpoint, dotnet and core tool", async () => {
  const fetchFn = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/health") return { ok: true, async json() { return {}; } };
    if (pathname === "/v1/models") return { ok: true, async json() { return { data: [{ id: "tiny" }] }; } };
    return { ok: false, async json() { return {}; } };
  };

  const exec = async (command) => {
    if (command === "dotnet") return { code: 0, killed: false, stdout: ".NET SDK 10.0", stderr: "" };
    throw new Error("missing");
  };

  const report = await runOfflineDoctor({
    cwd: "/tmp",
    endpoint: "http://127.0.0.1:8081",
    model: "tiny",
    tools: [{ name: "execute_delegated_implementation", sourceInfo: { source: "extension" } }],
    exec,
    fetchFn
  });

  assert.equal(report.ready, true);
  assert.match(formatDoctorReport(report), /OFFLINE READY: yes/);
});

test("doctor fails required readiness when tiny endpoint is unavailable", async () => {
  const fetchFn = async () => { throw new Error("offline"); };
  const exec = async (command) => command === "dotnet"
    ? { code: 0, killed: false, stdout: "ok", stderr: "" }
    : Promise.reject(new Error("missing"));

  const report = await runOfflineDoctor({
    cwd: "/tmp",
    endpoint: "http://127.0.0.1:8081",
    model: "tiny",
    tools: [{ name: "execute_delegated_implementation" }],
    exec,
    fetchFn
  });

  assert.equal(report.ready, false);
  assert.ok(report.requiredFailures.includes("tiny_endpoint"));
});


test("defers MTP TRX reporting checks to the declared project preflight", async () => {
  const fetchFn = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/health") return { ok: true, async json() { return {}; } };
    if (pathname === "/v1/models") return { ok: true, async json() { return { data: [{ id: "tiny" }] }; } };
    return { ok: false, async json() { return {}; } };
  };

  const exec = async (command, args) => {
    if (command === "dotnet" && args[0] === "--info") {
      return { code: 0, killed: false, stdout: ".NET SDK 10.0", stderr: "" };
    }
    if (command === "dotnet" && args[0] === "test") {
      return { code: 0, killed: false, stdout: "--test-modules\n--max-parallel-test-modules", stderr: "" };
    }
    throw new Error("missing");
  };

  const report = await runOfflineDoctor({
    cwd: "/tmp",
    endpoint: "http://127.0.0.1:8081",
    model: "tiny",
    tools: [{ name: "execute_delegated_implementation" }],
    exec,
    fetchFn
  });

  assert.equal(report.ready, true);
  assert.equal(report.warnings.includes("dotnet_test_runner"), false);
  assert.match(formatDoctorReport(report), /verified against the declared test project/);
});


test("warns when runtime state is not ignored by Git", async () => {
  const fetchFn = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/health") return { ok: true, async json() { return {}; } };
    if (pathname === "/v1/models") return { ok: true, async json() { return { data: [{ id: "tiny" }] }; } };
    return { ok: false, async json() { return {}; } };
  };

  const exec = async (command, args) => {
    if (command === "dotnet" && args[0] === "--info") {
      return { code: 0, killed: false, stdout: ".NET SDK", stderr: "" };
    }
    if (command === "dotnet" && args[0] === "test") {
      return { code: 0, killed: false, stdout: "--logger\n--filter", stderr: "" };
    }
    if (command === "git" && args[0] === "rev-parse") {
      return { code: 0, killed: false, stdout: "/repo\n", stderr: "" };
    }
    if (command === "git" && args[0] === "check-ignore") {
      return { code: 1, killed: false, stdout: "", stderr: "" };
    }
    throw new Error("missing");
  };

  const report = await runOfflineDoctor({
    cwd: "/repo",
    endpoint: "http://127.0.0.1:8081",
    model: "tiny",
    tools: [{ name: "execute_delegated_implementation" }],
    exec,
    fetchFn
  });

  assert.ok(report.warnings.includes("runtime_state_ignore"));
  assert.match(formatDoctorReport(report), /\.git\/info\/exclude/);
});


test("fails required readiness when model catalog is unavailable", async () => {
  const fetchFn = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/health") return { ok: true, async json() { return {}; } };
    if (pathname === "/v1/models") return { ok: false, async json() { return {}; } };
    return { ok: false, async json() { return {}; } };
  };
  const exec = async (command, args) => {
    if (command === "dotnet") return { code: 0, killed: false, stdout: args[0] === "test" ? "--logger" : ".NET", stderr: "" };
    throw new Error("missing");
  };

  const report = await runOfflineDoctor({
    cwd: "/tmp",
    endpoint: "http://127.0.0.1:8081",
    model: "tiny",
    tools: [{ name: "execute_delegated_implementation" }],
    exec,
    fetchFn
  });

  assert.equal(report.ready, false);
  assert.ok(report.requiredFailures.includes("tiny_endpoint"));
  assert.match(formatDoctorReport(report), /model catalog is unavailable/);
});

test("preserves endpoint path prefixes in doctor probes", async () => {
  const paths = [];
  const fetchFn = async (url) => {
    const pathname = new URL(url).pathname;
    paths.push(pathname);
    if (pathname === "/proxy/health") return { ok: true, async json() { return {}; } };
    if (pathname === "/proxy/v1/models") return { ok: true, async json() { return { data: [{ id: "tiny" }] }; } };
    return { ok: false, async json() { return {}; } };
  };
  const exec = async (command, args) => {
    if (command === "dotnet") return { code: 0, killed: false, stdout: args[0] === "test" ? "--logger" : ".NET", stderr: "" };
    throw new Error("missing");
  };

  const report = await runOfflineDoctor({
    cwd: "/tmp",
    endpoint: "http://127.0.0.1:8081/proxy",
    model: "tiny",
    tools: [{ name: "execute_delegated_implementation" }],
    exec,
    fetchFn
  });

  assert.equal(report.ready, true);
  assert.ok(paths.includes("/proxy/health"));
  assert.ok(paths.includes("/proxy/v1/models"));
});


test("fails readiness when health works but model catalog is unavailable", async () => {
  const seen = [];
  const fetchFn = async (url) => {
    seen.push(new URL(url).pathname);
    const pathname = new URL(url).pathname;
    if (pathname === "/proxy/health") return { ok: true, async json() { return {}; } };
    if (pathname === "/proxy/v1/models") return { ok: false, async json() { return {}; } };
    return { ok: false, async json() { return {}; } };
  };
  const exec = async (command, args) => {
    if (command === "dotnet" && args[0] === "--info") return { code: 0, killed: false, stdout: ".NET", stderr: "" };
    if (command === "dotnet" && args[0] === "test") return { code: 0, killed: false, stdout: "--logger\n--filter", stderr: "" };
    if (command === "git") return { code: 1, killed: false, stdout: "", stderr: "" };
    throw new Error("missing");
  };

  const report = await runOfflineDoctor({
    cwd: "/tmp",
    endpoint: "http://127.0.0.1:8081/proxy",
    model: "tiny",
    tools: [{ name: "execute_delegated_implementation" }],
    exec,
    fetchFn
  });

  assert.equal(report.ready, false);
  assert.ok(report.requiredFailures.includes("tiny_endpoint"));
  assert.deepEqual(seen.slice(0, 2), ["/proxy/health", "/proxy/v1/models"]);
  assert.match(formatDoctorReport(report), /model catalog is unavailable/);
});

test("warns without blocking readiness when the implementer endpoint is remote", async () => {
  const seenHeaders = [];
  const fetchFn = async (url, options) => {
    seenHeaders.push(options?.headers?.authorization ?? null);
    const pathname = new URL(url).pathname;
    if (pathname === "/api/v1/models") {
      return { ok: true, async json() { return { data: [{ id: "qwen/qwen3-coder-30b-a3b-instruct" }] }; } };
    }
    return { ok: false, async json() { return {}; } };
  };

  const exec = async (command) => {
    if (command === "dotnet") return { code: 0, killed: false, stdout: ".NET SDK 10.0", stderr: "" };
    throw new Error("missing");
  };

  const report = await runOfflineDoctor({
    cwd: "/tmp",
    endpoint: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3-coder-30b-a3b-instruct",
    apiKey: "sk-or-v1-testkey",
    tools: [{ name: "execute_delegated_implementation", sourceInfo: { source: "extension" } }],
    exec,
    fetchFn
  });

  // A hosted router has no /health; v1/models alone must carry reachability.
  assert.equal(report.checks.find((x) => x.id === "tiny_endpoint").ok, true);
  assert.equal(report.ready, true);
  assert.ok(report.warnings.includes("endpoint_locality"));
  assert.match(formatDoctorReport(report), /prompts and source excerpts leave your network/);
  assert.deepEqual([...new Set(seenHeaders)], ["Bearer sk-or-v1-testkey"]);
});

test("treats loopback and private endpoints as local", () => {
  for (const endpoint of ["http://127.0.0.1:8081", "http://localhost:8081", "http://192.168.1.5:8081", "http://[::1]:8081", "http://workstation:8081"]) {
    assert.equal(checkEndpointLocality(endpoint).ok, true, endpoint);
  }
  for (const endpoint of ["https://openrouter.ai/api/v1", "https://api.example.com"]) {
    assert.equal(checkEndpointLocality(endpoint).ok, false, endpoint);
  }
});

test("truncates a large hosted catalog when the configured model is missing", async () => {
  const data = Array.from({ length: 446 }, (_, i) => ({ id: `vendor/model-${i}` }));
  const fetchFn = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/v1/models") return { ok: true, async json() { return { data }; } };
    return { ok: false, async json() { return {}; } };
  };

  const report = await runOfflineDoctor({
    cwd: "/tmp",
    endpoint: "https://openrouter.ai/api/v1",
    model: "vendor/absent-model",
    tools: [{ name: "execute_delegated_implementation", sourceInfo: { source: "extension" } }],
    exec: async () => { throw new Error("missing"); },
    fetchFn
  });

  const check = report.checks.find((x) => x.id === "tiny_endpoint");
  assert.equal(check.ok, false);
  assert.match(check.message, /not listed among 446 available/);
  assert.match(check.message, /\(\+438 more\)/);
  assert.ok(check.message.length < 400);
});

test("survives HTML error pages instead of JSON and never echoes the key", async () => {
  const key = "sk-or-v1-doctorcanary0123456789abcdef0123456789ab";
  // OpenRouter has no /health: it serves a 404 HTML page, so res.json() rejects.
  const html = () => ({
    ok: false,
    status: 404,
    async json() { throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"); },
    async text() { return "<!DOCTYPE html><html>404</html>"; }
  });

  const report = await runOfflineDoctor({
    cwd: "/tmp",
    endpoint: "https://openrouter.ai",           // the classic misconfiguration: no /api/v1
    model: "qwen/qwen3-coder-30b-a3b-instruct",
    apiKey: key,
    tools: [{ name: "execute_delegated_implementation", sourceInfo: { source: "extension" } }],
    exec: async () => { throw new Error("missing"); },
    fetchFn: async () => html()
  });

  const check = report.checks.find((x) => x.id === "tiny_endpoint");
  assert.equal(check.ok, false);
  assert.match(check.message, /unreachable/);
  assert.equal(report.ready, false);

  const serialized = JSON.stringify(report) + formatDoctorReport(report);
  assert.equal(serialized.includes(key), false, "api key leaked into the doctor report");
  assert.equal(serialized.includes("doctorcanary"), false);
});

test("doctor names the edit provider and why pi-lean-edit is off", async () => {
  const fetchFn = async () => ({ ok: true, async json() { return { data: [{ id: "tiny" }] }; } });
  const exec = async () => ({ code: 0, killed: false, stdout: "ok", stderr: "" });
  const run = (tools, editProvider) => runOfflineDoctor({
    cwd: "/tmp", endpoint: "http://127.0.0.1:8081", model: "tiny", tools, exec, fetchFn, editProvider
  });
  const lineOf = (report) => formatDoctorReport(report).split("\n").find((x) => x.includes("edit_provider"));

  const lean = await run([{ name: "edit", sourceInfo: { path: "/pkg/extensions/pi-lean-edit.ts" } }]);
  assert.equal(lineOf(lean), "✓ edit_provider: edit tool source: /pkg/extensions/pi-lean-edit.ts");

  const other = await run(
    [{ name: "edit", sourceInfo: { path: "/pi-utils/extensions/edit.ts" } }],
    { value: "none", source: "config" }
  );
  assert.equal(
    lineOf(other),
    "✓ edit_provider: edit tool source: /pi-utils/extensions/edit.ts (bundled pi-lean-edit disabled: editProvider=none from config)"
  );

  const absent = await run([], { value: "none", source: "env" });
  assert.match(lineOf(absent), /^! edit_provider: edit tool not active \(bundled pi-lean-edit disabled: editProvider=none from env\)$/);
});

// Spec: docs/HYBRID_EDIT_V0.md HE-8.
test("doctor explains a hybrid edit setup, including a hidden script edit", async () => {
  const fetchFn = async () => ({ ok: true, async json() { return { data: [{ id: "tiny" }] }; } });
  const exec = async () => ({ code: 0, killed: false, stdout: "ok", stderr: "" });
  const lineEdit = { name: "line_edit", sourceInfo: { path: "/pkg/extensions/pi-lean-edit.ts" } };
  const scriptEdit = { name: "edit", sourceInfo: { path: "/pi-utils/extensions/edit.ts" } };
  const run = (tools, sessionModel) => runOfflineDoctor({
    cwd: "/tmp", endpoint: "http://127.0.0.1:8081", model: "tiny", exec, fetchFn,
    tools, allTools: [lineEdit, scriptEdit], sessionModel,
    editProvider: { value: "hybrid", source: "config" },
    scriptEditPolicy: { value: "cloud-only", source: "default" }
  });
  const lineOf = (report) => formatDoctorReport(report).split("\n").find((x) => x.includes("edit_provider"));

  const hidden = await run([lineEdit], { baseUrl: "http://127.0.0.1:8080/v1" });
  assert.equal(
    lineOf(hidden),
    "✓ edit_provider: hybrid (editProvider from config); line_edit source: /pkg/extensions/pi-lean-edit.ts; " +
      "edit source: /pi-utils/extensions/edit.ts, hidden (local model, scriptEditPolicy=cloud-only from default)"
  );

  const offered = await run([lineEdit, scriptEdit], { baseUrl: "https://chatgpt.com/backend-api" });
  assert.match(lineOf(offered), /edit source: \/pi-utils\/extensions\/edit\.ts, offered \(remote model,/);
});
