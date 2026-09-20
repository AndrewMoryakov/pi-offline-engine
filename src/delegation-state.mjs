export function failureReasonForStage(stage) {
  if (stage === "tiny_call") return "tiny_transport_failure";
  if (stage === "candidate_validation") return "tiny_invalid_candidate";
  if (stage === "verification") return "verification_execution_failure";
  if (stage === "apply") return "candidate_apply_failure";
  return "delegated_runtime_failure";
}

export function buildRuntimeFailureOutcome({
  stage,
  workspaceModified,
  error,
  attempts = [],
  changedFiles = []
}) {
  const applyStateUncertain = stage === "apply" && !workspaceModified;
  return {
    status: "needs_main_model",
    reason: failureReasonForStage(stage),
    stage,
    // A failed write can theoretically leave a partially modified file even
    // though applyCandidate performs best-effort rollback. Report the
    // conservative state rather than a false "clean" claim.
    workspace_modified: Boolean(workspaceModified || stage === "apply"),
    workspace_state_uncertain: applyStateUncertain,
    changed_files: [...new Set(changedFiles)].sort(),
    error: String(error),
    attempts
  };
}

export function buildTinyTerminalOutcome({
  terminalStatus,
  reason = null,
  attempt,
  usage,
  workspaceModified,
  changedFiles = []
}) {
  const files = [...new Set(changedFiles)].sort();

  if (workspaceModified) {
    return {
      status: "needs_main_model",
      reason: `tiny_${terminalStatus}_after_mutation`,
      terminal_status: terminalStatus,
      terminal_reason: reason,
      attempt,
      workspace_modified: true,
      changed_files: files,
      usage
    };
  }

  return {
    status: terminalStatus,
    reason,
    attempt,
    workspace_modified: false,
    changed_files: files,
    usage
  };
}
