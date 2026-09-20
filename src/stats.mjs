import fs from "node:fs/promises";
import path from "node:path";

export async function readOfflineEvents(cwd) {
  const file = path.join(cwd, ".pi", "offline-engine", "events.jsonl");
  try {
    const text = await fs.readFile(file, "utf8");
    const events = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch {}
    }
    return { file, events };
  } catch (error) {
    if (error?.code === "ENOENT") return { file, events: [] };
    throw error;
  }
}

export function summarizeOfflineEvents(events) {
  const summary = {
    tinyCalls: 0,
    tinyInputTokens: 0,
    tinyOutputTokens: 0,
    tinyUnknownUsageCalls: 0,
    tinyLatencyMs: 0,
    delegatedSuccesses: 0,
    delegatedEscalations: 0,
    verificationPasses: 0,
    verificationFailures: 0,
    repairPackets: 0,
    repoCapsules: 0,
    compactedToolResults: 0,
    originalToolChars: 0,
    compactedToolChars: 0
  };

  for (const event of events) {
    if (event.type === "tiny_finished") {
      summary.tinyCalls += 1;
      summary.tinyLatencyMs += numberOrZero(event.latencyMs);
      const input = finiteOrNull(event.usage?.inputTokens);
      const output = finiteOrNull(event.usage?.outputTokens);
      if (input === null || output === null) summary.tinyUnknownUsageCalls += 1;
      else {
        summary.tinyInputTokens += input;
        summary.tinyOutputTokens += output;
      }
    } else if (event.type === "delegated_implementation_succeeded") {
      summary.delegatedSuccesses += 1;
    } else if (event.type === "delegated_implementation_escalated") {
      summary.delegatedEscalations += 1;
    } else if (event.type === "verification_finished") {
      if (event.passed) summary.verificationPasses += 1;
      else summary.verificationFailures += 1;
    } else if (event.type === "repair_packet_created") {
      summary.repairPackets += 1;
    } else if (event.type === "repo_capsule_injected") {
      summary.repoCapsules += 1;
    } else if (event.type === "tool_result_compacted") {
      summary.compactedToolResults += 1;
      summary.originalToolChars += numberOrZero(event.originalChars);
      summary.compactedToolChars += numberOrZero(event.compactedChars);
    }
  }

  summary.toolCharsAvoided = Math.max(0, summary.originalToolChars - summary.compactedToolChars);
  summary.averageTinyLatencyMs = summary.tinyCalls > 0
    ? Math.round(summary.tinyLatencyMs / summary.tinyCalls)
    : 0;

  return summary;
}

export function formatOfflineStats(summary) {
  const lines = [
    "pi-offline-engine stats",
    "",
    `TinyCoder calls: ${summary.tinyCalls}`,
    `TinyCoder reported tokens: in ${summary.tinyInputTokens}, out ${summary.tinyOutputTokens}`,
    `TinyCoder calls with incomplete usage: ${summary.tinyUnknownUsageCalls}`,
    `TinyCoder average latency: ${summary.averageTinyLatencyMs} ms`,
    `Delegated successes / escalations: ${summary.delegatedSuccesses} / ${summary.delegatedEscalations}`,
    `Verification pass / fail: ${summary.verificationPasses} / ${summary.verificationFailures}`,
    `Repair packets: ${summary.repairPackets}`,
    `Repository capsules injected: ${summary.repoCapsules}`,
    `Compacted tool results: ${summary.compactedToolResults}`,
    `Tool-result chars avoided in model context: ${summary.toolCharsAvoided}`
  ];
  return lines.join("\n");
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrZero(value) {
  return finiteOrNull(value) ?? 0;
}
