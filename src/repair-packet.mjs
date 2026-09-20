export function buildRepairPacket({ spec, attempt, candidate, verification }) {
  return {
    version: 1,
    spec_id: spec.spec_id,
    repair_attempt: attempt,
    goal: spec.goal?.summary ?? null,
    previous_changes: (candidate.changes ?? []).map((change) => ({
      path: change.path,
      operation: change.operation,
      expected: change.operation === "replace_text" ? change.expected : undefined,
      content: change.content
    })),
    verification: {
      passed: verification.passed,
      diagnostics: verification.diagnostics,
      checks: verification.checks.map((check) => ({
        kind: check.kind,
        passed: check.passed,
        code: check.code,
        killed: check.killed,
        artifact: check.artifact
      }))
    },
    instruction: "Repair only the bounded implementation. Do not expand scope. The previous change content is the current failed source state where it was applied. Use the current source state as the new preimage."
  };
}
