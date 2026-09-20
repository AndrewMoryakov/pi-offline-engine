import test from "node:test";
import assert from "node:assert/strict";
import { addPiUsage, toPiUsage } from "../src/pi-usage.mjs";

test("maps normalized TinyCoder usage into Pi disjoint usage", () => {
  const usage = toPiUsage({
    inputTokens: 80,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    outputTokens: 10,
    totalTokens: 110
  });

  assert.deepEqual(usage, {
    input: 80,
    output: 10,
    cacheRead: 20,
    cacheWrite: 0,
    totalTokens: 110,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  });
});

test("adds nested usage across TinyCoder repair attempts", () => {
  const total = addPiUsage(
    toPiUsage({ inputTokens: 80, cacheReadTokens: 20, outputTokens: 10, totalTokens: 110 }),
    toPiUsage({ inputTokens: 40, cacheReadTokens: 60, outputTokens: 12, totalTokens: 112 })
  );

  assert.equal(total.input, 120);
  assert.equal(total.cacheRead, 80);
  assert.equal(total.output, 22);
  assert.equal(total.totalTokens, 222);
});
