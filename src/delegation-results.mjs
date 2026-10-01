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

// --- execute_delegated_implementation -----------------------------------------

export function formatCancelledResult() {
  return { content: text("Delegated implementation cancelled by user."), details: { cancelled: true } };
}

export function formatExecutionResult(outcome) {
  switch (outcome.kind) {
    case "preflight_failure":
      // No TinyCoder call has happened, so the result carries no usage key.
      return {
        content: json(outcome.outcome),
        details: {
          success: false,
          escalated: true,
          reason: outcome.outcome.reason,
          stage: outcome.outcome.stage,
          workspaceModified: false,
          error: outcome.outcome.error,
          attempts: outcome.attempts
        }
      };

    case "model_output_escalation":
      return {
        content: json(outcome.outcome),
        details: {
          success: false,
          escalated: true,
          reason: outcome.outcome.reason,
          stage: outcome.outcome.stage,
          workspaceModified: outcome.outcome.workspace_modified,
          changedFiles: outcome.outcome.changed_files,
          attempts: outcome.attempts
        },
        usage: outcome.nestedUsage
      };

    case "terminal_model_status":
      return {
        content: json(outcome.outcome),
        details: {
          success: false,
          escalated: outcome.workspaceModified,
          terminalStatus: outcome.terminalStatus,
          attempt: outcome.attempt,
          usage: outcome.attemptUsage,
          workspaceModified: outcome.outcome.workspace_modified,
          changedFiles: outcome.outcome.changed_files
        },
        usage: outcome.nestedUsage
      };

    case "runtime_failure":
      return {
        content: json(outcome.outcome),
        details: {
          success: false,
          escalated: true,
          reason: outcome.outcome.reason,
          stage: outcome.outcome.stage,
          workspaceModified: outcome.outcome.workspace_modified,
          workspaceStateUncertain: outcome.outcome.workspace_state_uncertain,
          changedFiles: outcome.outcome.changed_files,
          error: outcome.outcome.error,
          attempts: outcome.attempts
        },
        usage: outcome.nestedUsage
      };

    case "verification_passed":
      return {
        content: json({
          status: "verification_passed",
          task_complete: false,
          note: "Compiler/test verification passed; the main reasoner still owns semantic completion.",
          attempt: outcome.attempt,
          changedFiles: [...outcome.changedFiles],
          verification: outcome.verification
        }),
        details: {
          success: true,
          taskComplete: false,
          attempt: outcome.attempt,
          attempts: outcome.attempts,
          changedFiles: [...outcome.changedFiles],
          verification: outcome.verification
        },
        usage: outcome.nestedUsage
      };

    case "attempts_exhausted":
      // `attempts` is the attempt count in the JSON body and the per-attempt
      // records in details; both shapes are part of the current contract.
      return {
        content: json({
          status: "needs_main_model",
          reason: "tiny_implementation_attempts_exhausted",
          workspace_modified: outcome.workspaceModified,
          changed_files: [...outcome.changedFiles],
          attempts: outcome.maxAttempts,
          verification: outcome.verification
        }),
        details: {
          success: false,
          escalated: true,
          workspaceModified: outcome.workspaceModified,
          changedFiles: [...outcome.changedFiles],
          attempts: outcome.attempts,
          verification: outcome.verification
        },
        usage: outcome.nestedUsage
      };

    default:
      throw new Error(`unknown execution outcome: ${String(outcome.kind)}`);
  }
}
