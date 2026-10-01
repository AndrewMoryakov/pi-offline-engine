// Real-verification gate: runs execute_delegated_implementation from
// extensions/index.ts against the acceptance fixture with the real dotnet SDK
// and a scripted implementer that uses all three attempts: malformed output
// (model-output retry), a wrong candidate (red tests, RepairPacket), then the
// fix. Unit tests fake exec and the Pi host; this drives the real extension,
// real build/test/TRX handling and both retry paths in one run. Timing bugs
// (such as the former 10 s runner-detection limit) show up only on machines
// slow enough to hit them, so a pass here does not rule them out.
//
// Skips (exit 0, loud) only when no dotnet SDK is on PATH. Needs the
// MSTest.Sdk packages in the NuGet cache; the first run restores them online.

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeExec } from "../src/node-exec.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dotnet = process.platform === "win32" ? "dotnet.exe" : "dotnet";

if (spawnSync(dotnet, ["--version"], { stdio: "ignore" }).status !== 0) {
  console.log("DOTNET GATE: SKIPPED (no dotnet SDK on PATH)");
  process.exit(0);
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), "pi-offline-dotnet-gate-"));
const fixture = path.join(work, "fixture");
const prepared = spawnSync(process.execPath, [path.join(root, "scripts", "prepare-acceptance-v0.mjs"), "--restore", "--out", fixture], {
  stdio: ["ignore", "ignore", "inherit"]
});
if (prepared.status !== 0) fail(`fixture preparation failed (exit ${prepared.status})`);

process.env.PI_CODING_AGENT_DIR = path.join(work, "agent");

const target = "src/Acceptance.Core/LoyaltyDiscount.cs";
const replies = [
  "Sure! Here is the fix you asked for.",
  { status: "candidate", changes: [{ path: target, operation: "replace_text", expected: "return total >= 100m", content: "return total > 1000m" }] },
  { status: "candidate", changes: [{ path: target, operation: "replace_text", expected: "return total > 1000m", content: "return total > 100m" }] }
];
const requests = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    requests.push(JSON.parse(body));
    const reply = replies[Math.min(requests.length, replies.length) - 1];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } }], usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 } }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.PI_OFFLINE_TINY_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
process.env.PI_OFFLINE_TINY_MODEL = "scripted-gate";
process.env.PI_OFFLINE_TINY_MAX_ATTEMPTS = "3";

const { default: offlineEngine } = await import(pathToFileURL(path.join(root, "extensions", "index.ts")).href);
const tools = {};
offlineEngine({
  registerTool: (tool) => { tools[tool.name] = tool; },
  registerCommand() {},
  on() {},
  exec: nodeExec,
  getAllTools: () => [],
  getActiveTools: () => [],
  setActiveTools() {}
});

const testClass = "Acceptance.Tests.LoyaltyDiscountTests.";
const spec = {
  version: 1,
  spec_id: "dotnet-gate",
  operation: "modify_symbol",
  goal: { summary: "Apply the loyalty discount only when total is strictly greater than 100." },
  target: { file: target, symbol: "LoyaltyDiscount.Apply" },
  requirements: ["Discount only when total > 100.", "A total of exactly 100 stays unchanged."],
  scope: { allowed_files: [target], allow_new_files: false, allow_dependencies: false, allow_public_api_change: false },
  verification: {
    build: { project: "src/Acceptance.Core/Acceptance.Core.csproj" },
    tests: {
      project: "tests/Acceptance.Tests/Acceptance.Tests.csproj",
      names: ["ExactlyThresholdIsNotDiscounted", "AboveThresholdIsDiscounted", "NonLoyalCustomerIsUnchanged", "NegativeTotalIsRejected"]
        .map((name) => testClass + name)
    }
  }
};

const started = Date.now();
let result;
try {
  result = await tools.execute_delegated_implementation.execute("dotnet-gate", { spec }, undefined, () => {}, {
    cwd: fixture,
    hasUI: true,
    ui: { confirm: async () => true, notify() {} }
  });
} catch (error) {
  fail(`execute_delegated_implementation threw: ${error?.stack ?? error}`);
} finally {
  server.close();
}

const outcome = JSON.parse(result.content[0].text);
const source = await fs.readFile(path.join(fixture, target), "utf8");
const payload = (index) => JSON.parse(requests[index]?.messages?.[1]?.content ?? "{}");
const checks = [
  ["status is verification_passed", outcome.status === "verification_passed"],
  ["passed on attempt 3 after malformed output and red tests", outcome.attempt === 3 && requests.length === 3],
  ["malformed output was retried with a model-output packet", payload(1).repair_packet?.kind === "model_output_failure"],
  ["red tests produced a verification repair packet", payload(2).repair_packet?.verification?.passed === false],
  ["build and tests both passed", outcome.verification?.checks?.length === 2 && outcome.verification.checks.every((x) => x.passed)],
  ["only the declared file changed", JSON.stringify(outcome.changedFiles) === JSON.stringify([target])],
  ["fix is on disk", source.includes("return total > 100m")]
];

for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
console.log(`elapsed: ${Math.round((Date.now() - started) / 1000)} s; fixture: ${fixture}`);
if (checks.some(([, ok]) => !ok)) fail(result.content[0].text.slice(0, 4000));

await fs.rm(work, { recursive: true, force: true }).catch(() => {});
console.log("DOTNET GATE: PASS");

function fail(detail) {
  console.error(detail);
  console.error("DOTNET GATE: FAIL");
  process.exit(1);
}
