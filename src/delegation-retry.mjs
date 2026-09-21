export function canRetryModelOutput({ attempt, maxAttempts }) {
  return attempt < maxAttempts;
}

export function buildModelOutputRepairPacket({
  attempt,
  candidate = null,
  validationErrors = [],
  error = null,
  priorRepairPacket = null
}) {
  return {
    version: 1,
    kind: "model_output_failure",
    repair_attempt: attempt,
    previous_candidate: candidate,
    validation_errors: validationErrors,
    error: error ? String(error) : null,
    prior_repair_packet: priorRepairPacket,
    instruction: [
      "Return a corrected bounded implementation response.",
      "Do not expand scope or redesign the task.",
      "Return JSON matching the required candidate schema exactly."
    ].join(" ")
  };
}

export function buildModelOutputEscalation({
  reason,
  stage,
  attempt,
  workspaceModified,
  changedFiles = [],
  attempts = [],
  error = null
}) {
  return {
    status: "needs_main_model",
    reason,
    stage,
    attempt,
    workspace_modified: Boolean(workspaceModified),
    changed_files: [...new Set(changedFiles)].sort(),
    error: error ? String(error) : null,
    attempts
  };
}
