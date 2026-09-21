import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const implementation = await fs.readFile(new URL("../fixtures/dotnet-boundary-v0/src/Acceptance.Core/LoyaltyDiscount.cs", import.meta.url), "utf8");
const tests = await fs.readFile(new URL("../fixtures/dotnet-boundary-v0/tests/Acceptance.Tests/LoyaltyDiscountTests.cs", import.meta.url), "utf8");
const task = await fs.readFile(new URL("../fixtures/dotnet-boundary-v0/ACCEPTANCE_TASK.md", import.meta.url), "utf8");
const globalJson = JSON.parse(await fs.readFile(new URL("../fixtures/dotnet-boundary-v0/global.json", import.meta.url), "utf8"));

test("acceptance fixture keeps its intentional boundary bug", () => {
  assert.match(implementation, /total >= 100m/);
  assert.match(task, /strictly greater than 100/);
});

test("acceptance fixture opts .NET 10+ into Microsoft.Testing.Platform", () => {
  assert.equal(globalJson.test?.runner, "Microsoft.Testing.Platform");
});

test("acceptance fixture keeps all four verification tests", () => {
  for (const name of [
    "ExactlyThresholdIsNotDiscounted",
    "AboveThresholdIsDiscounted",
    "NonLoyalCustomerIsUnchanged",
    "NegativeTotalIsRejected"
  ]) {
    assert.match(tests, new RegExp(name));
    assert.match(task, new RegExp(name));
  }
});


test("acceptance preparer refuses to delete an existing unmarked output directory", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-acceptance-guard-"));
  const sentinel = path.join(cwd, "keep.txt");
  await fs.writeFile(sentinel, "keep", "utf8");
  const script = fileURLToPath(new URL("../scripts/prepare-acceptance-v0.mjs", import.meta.url));

  const result = spawnSync(process.execPath, [script, "--out", cwd], {
    cwd,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.equal(await fs.readFile(sentinel, "utf8"), "keep");
  assert.match(result.stderr, /Refusing to use a destructive acceptance output path|Refusing to delete existing output/);
});
