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
