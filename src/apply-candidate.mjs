import fs from "node:fs/promises";
import path from "node:path";
import { validateCandidate } from "./implementation-spec.mjs";
import { resolveInside, verifySnapshot } from "./workspace-snapshot.mjs";

export async function planCandidateApplication(cwd, { spec, candidate, snapshot }) {
  const checked = validateCandidate(candidate, spec);
  if (!checked.ok) throw new Error(`candidate validation failed: ${checked.errors.join("; ")}`);

  const fresh = await verifySnapshot(cwd, snapshot);
  if (!fresh.ok) throw new Error(`stale candidate: ${fresh.errors.join("; ")}`);

  const root = snapshot.root;
  const state = new Map();

  for (const change of candidate.changes) {
    const absolute = resolveInside(root, change.path);
    let entry = state.get(change.path);
    if (!entry) {
      const baseline = snapshot.files[change.path];
      if (!baseline) throw new Error(`missing baseline for ${change.path}`);
      let original = null;
      if (baseline.exists) original = await fs.readFile(absolute, "utf8");
      entry = { path: change.path, absolute, existed: baseline.exists, original, next: original };
      state.set(change.path, entry);
    }

    if (change.operation === "create_file") {
      if (entry.existed || entry.next !== null) throw new Error(`create_file target already exists: ${change.path}`);
      entry.next = change.content;
      continue;
    }

    if (change.operation === "replace_text") {
      if (!entry.existed || typeof entry.next !== "string") throw new Error(`replace_text target does not exist: ${change.path}`);
      const count = countOccurrences(entry.next, change.expected);
      if (count !== 1) throw new Error(`replace_text expected text must occur exactly once in ${change.path}; found ${count}`);
      entry.next = entry.next.replace(change.expected, change.content);
      continue;
    }

    throw new Error(`operation is not applicable in v1: ${change.operation}`);
  }

  return [...state.values()];
}

export async function applyCandidate(cwd, record) {
  const plan = await planCandidateApplication(cwd, record);
  const written = [];
  try {
    for (const item of plan) {
      await fs.mkdir(path.dirname(item.absolute), { recursive: true });
      await fs.writeFile(item.absolute, item.next, "utf8");
      written.push(item);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...written].reverse()) {
      try {
        if (item.existed) await fs.writeFile(item.absolute, item.original, "utf8");
        else await fs.rm(item.absolute, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(`${item.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    const suffix = rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join("; ")}` : "";
    throw new Error(`candidate write failed: ${error instanceof Error ? error.message : String(error)}${suffix}`);
  }

  return {
    changedFiles: plan.map((x) => x.path),
    bytesWritten: plan.reduce((sum, x) => sum + Buffer.byteLength(x.next, "utf8"), 0)
  };
}

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}
