import test from "node:test";
import assert from "node:assert/strict";
import { runOfflineDoctor, formatDoctorReport } from "../src/offline-doctor.mjs";

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


test("warns when MTP lacks the TRX report extension", async () => {
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
  assert.ok(report.warnings.includes("dotnet_test_runner"));
  assert.match(formatDoctorReport(report), /Microsoft\.Testing\.Extensions\.TrxReport/);
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
