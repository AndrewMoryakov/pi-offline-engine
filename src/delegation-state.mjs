export function failureReasonForStage(stage) {
  if (stage === "tiny_call") return "tiny_transport_failure";
  if (stage === "candidate_validation") return "tiny_invalid_candidate";
  if (stage === "verification") return "verification_execution_failure";
  if (stage === "apply") return "candidate_apply_failure";
  return "delegated_runtime_failure";
}

export function buildRuntimeFailureOutcome({ stage, workspaceModified, error, attempts = [] }) {
  return {
    status: "needs_main_model",
    reason: failureReasonForStage(stage),
    stage,
    workspace_modified: Boolean(workspaceModified),
    error: String(error),
    attempts
  };
}
