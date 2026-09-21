import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const implementation = await fs.readFile(new URL("../fixtures/dotnet-boundary-v0/src/Acceptance.Core/LoyaltyDiscount.cs", import.meta.url), "utf8");
const tests = await fs.readFile(new URL("../fixtures/dotnet-boundary-v0/tests/Acceptance.Tests/LoyaltyDiscountTests.cs", import.meta.url), "utf8");
const task = await fs.readFile(new URL("../fixtures/dotnet-boundary-v0/ACCEPTANCE_TASK.md", import.meta.url), "utf8");

test("acceptance fixture keeps its intentional boundary bug", () => {
  assert.match(implementation, /total >= 100m/);
  assert.match(task, /strictly greater than 100/);
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
