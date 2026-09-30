// Pi-visible result bodies for the two delegation tools. Pure formatting of
// already-classified workflow outcomes: no I/O. Imported by the Pi tool
// adapter only, never by the domain workflows, so the JSON `content` and the
// `details` object for each outcome are built side by side and cannot drift.

import { toPiUsage } from "./pi-usage.mjs";

function text(value) {
  return [{ type: "text", text: value }];
}

function json(value) {
  return text(JSON.stringify(value, null, 2));
}

// --- delegate_implementation -------------------------------------------------

export function formatCandidateResult(outcome) {
  if (outcome.kind === "spec_rejected") {
    return {
      content: text(`ImplementationSpec rejected: ${outcome.errors.join("; ")}`),
      details: { accepted: false, errors: outcome.errors }
    };
  }

  if (outcome.kind === "invalid_candidate") {
    return {
      content: text(`Tiny implementer returned an invalid candidate: ${outcome.errors.join("; ")}`),
      details: { accepted: false, candidate: outcome.candidate, usage: outcome.usage, latencyMs: outcome.latencyMs, errors: outcome.errors },
      usage: toPiUsage(outcome.usage)
    };
  }

  if (outcome.kind === "accepted") {
    return {
      content: json(outcome.candidate),
      details: { accepted: true, candidate: outcome.candidate, usage: outcome.usage, latencyMs: outcome.latencyMs },
      usage: toPiUsage(outcome.usage)
    };
  }

  throw new Error(`unknown candidate outcome: ${String(outcome.kind)}`);
}
