// Candidate-only delegation: ask TinyCoder for a bounded candidate, validate
// it and persist it, without ever applying it to repository files.
//
// Host-independent: no Pi imports and no Pi result shapes. External
// capabilities arrive in one options object:
//   callTiny(request)          TinyCoder transport; request is
//                              { endpoint, model, spec, context, signal }
//   appendEvent(cwd, event)    event-ledger writer
//   saveCandidate(cwd, record) candidate store (defaults to the file store)
//
// Returns a discriminated outcome for the host adapter to format:
//   { kind: "spec_rejected", errors }
//   { kind: "invalid_candidate", candidate, usage, latencyMs, errors }
//   { kind: "accepted", candidate, usage, latencyMs }
// A TinyCoder failure is recorded as `tiny_failed` and rethrown as
// `Tiny implementer failed: <message>`. A candidate-store failure after a
// valid candidate is recorded as `candidate_record_failed` and rethrown as
// `Candidate record failed: <message>`.

import { validateCandidate, validateImplementationSpec } from "./implementation-spec.mjs";
import { captureAllowedFiles } from "./workspace-snapshot.mjs";
import { saveCandidateRecord } from "./candidate-store.mjs";

export async function runCandidateDelegation({
  spec,
  context,
  cwd,
  signal,
  endpoint,
  model,
  callTiny,
  appendEvent,
  saveCandidate = saveCandidateRecord,
  attachCurrentFiles = false,
  tinyTimeoutMs = undefined
}) {
  const checked = validateImplementationSpec(spec);
  if (!checked.ok) return { kind: "spec_rejected", errors: checked.errors };

  const { snapshot, currentFiles } = await captureAllowedFiles(cwd, spec, { withContent: attachCurrentFiles });
  await appendEvent(cwd, { type: "tiny_started", specId: spec.spec_id, model, endpoint, mode: "candidate_only" });

  let result;
  let candidateCheck;
  try {
    result = await callTiny({ endpoint, model, spec, context: context ?? {}, ...(currentFiles ? { currentFiles } : {}), ...(tinyTimeoutMs ? { timeoutMs: tinyTimeoutMs } : {}), signal });
    candidateCheck = validateCandidate(result.candidate, spec);
    await appendEvent(cwd, {
      type: "tiny_finished",
      specId: spec.spec_id,
      model,
      latencyMs: result.latencyMs,
      usage: result.usage,
      candidateStatus: result.candidate?.status ?? null,
      candidateValid: candidateCheck.ok,
      validationErrors: candidateCheck.errors,
      mode: "candidate_only"
    });
  } catch (error) {
    const message = errorMessage(error);
    await appendEvent(cwd, { type: "tiny_failed", specId: spec.spec_id, model, error: message, mode: "candidate_only" });
    throw new Error(`Tiny implementer failed: ${message}`);
  }

  if (!candidateCheck.ok) {
    return {
      kind: "invalid_candidate",
      candidate: result.candidate,
      usage: result.usage,
      latencyMs: result.latencyMs,
      errors: candidateCheck.errors
    };
  }

  if (result.candidate.status === "candidate") {
    try {
      await saveCandidate(cwd, { spec, candidate: result.candidate, snapshot, attempt: 1, model, usage: result.usage });
    } catch (error) {
      const message = errorMessage(error);
      await appendEvent(cwd, { type: "candidate_record_failed", specId: spec.spec_id, model, error: message, mode: "candidate_only" });
      throw new Error(`Candidate record failed: ${message}`);
    }
  }

  return { kind: "accepted", candidate: result.candidate, usage: result.usage, latencyMs: result.latencyMs };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
