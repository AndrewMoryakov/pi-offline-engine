import test from "node:test";
import assert from "node:assert/strict";
import { summarizeOfflineEvents, formatOfflineStats } from "../src/stats.mjs";

test("aggregates TinyCoder, verification and compaction metrics", () => {
  const summary = summarizeOfflineEvents([
    { type: "tiny_finished", latencyMs: 1000, usage: { inputTokens: 100, outputTokens: 20 } },
    { type: "tiny_finished", latencyMs: 2000, usage: { inputTokens: 80, outputTokens: 30 } },
    { type: "verification_finished", passed: false },
    { type: "repair_packet_created" },
    { type: "verification_finished", passed: true },
    { type: "delegated_implementation_succeeded" },
    { type: "repo_capsule_injected" },
    { type: "tool_result_compacted", originalChars: 12000, compactedChars: 1200 }
  ]);

  assert.equal(summary.tinyCalls, 2);
  assert.equal(summary.tinyOutputTokens, 50);
  assert.equal(summary.averageTinyLatencyMs, 1500);
  assert.equal(summary.verificationPasses, 1);
  assert.equal(summary.verificationFailures, 1);
  assert.equal(summary.toolCharsAvoided, 10800);
  assert.match(formatOfflineStats(summary), /10800/);
});

test("tracks incomplete usage instead of inventing zero-token calls", () => {
  const summary = summarizeOfflineEvents([
    { type: "tiny_finished", latencyMs: 500, usage: { inputTokens: null, outputTokens: null } }
  ]);
  assert.equal(summary.tinyUnknownUsageCalls, 1);
  assert.equal(summary.tinyInputTokens, 0);
});
